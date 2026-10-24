import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { getDb, type Prisma } from "@catalogforge/db";
import { IngestionError, PARSER_VERSION, type ParsedRow } from "./contracts";
import { parseSpreadsheet } from "./parser";
import { readOriginal, sha256, type OriginalStorage } from "./storage";

class Superseded extends Error {}
export class RetryableParseError extends Error {
  constructor(public readonly runId: string) { super("Parsing interrupted; a bounded retry is required."); }
}

async function withRun<T>(id: string, runId: string, action: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return getDb().$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ parseRunId: string | null; status: string }[]>`
      SELECT "parseRunId", "status" FROM "Import" WHERE "id" = ${id}::uuid FOR UPDATE
    `;
    if (rows[0]?.parseRunId !== runId || rows[0]?.status !== "PROCESSING") throw new Superseded();
    return action(tx);
  });
}

export async function failParseRun(id: string, runId: string | null, code: string, message: string): Promise<boolean> {
  const result = await getDb().import.updateMany({ where: { id, parseRunId: runId, status: { in: ["PENDING", "PROCESSING"] } },
    data: { status: "FAILED", errorCode: code, errorMessage: message, finishedAt: new Date(), parseRunId: null } });
  return result.count === 1;
}

export async function processParseImport(id: string, storeId: string, storage: OriginalStorage, options: {
  // Progress observer also permits deterministic interruption/fencing fault tests.
  afterBatch?: (savedRows: number) => Promise<void>;
  batchSize?: number;
} = {}): Promise<void> {
  const db = getDb();
  const runId = randomUUID();
  const imported = await db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Import" WHERE "id" = ${id}::uuid AND "storeId" = ${storeId}::uuid FOR UPDATE`;
    if (!locked.length) throw new IngestionError("IMPORT_NOT_FOUND", "Parse job does not belong to the configured store.");
    const current = await tx.import.findUniqueOrThrow({ where: { id } });
    if (current.status === "COMPLETED" || current.status === "FAILED") return null;
    return tx.import.update({ where: { id }, data: {
      status: "PROCESSING", parseRunId: runId, startedAt: current.startedAt ?? new Date(),
      finishedAt: null, errorCode: null, errorMessage: null
    } });
  });
  if (!imported) return;
  try {
    if (imported.parserVersion !== PARSER_VERSION) throw new IngestionError("PARSER_VERSION", "This parser version is not available; source data was retained.");
    const read = async () => {
      const bytes = await readOriginal(storage, imported.storageKey);
      if (sha256(bytes) !== imported.fileSha256) throw new IngestionError("FILE_HASH_MISMATCH", "Original file does not match its finalized SHA-256 hash.");
      return bytes;
    };
    // Validate/count before writing any rows. Discard first-pass row objects.
    let totalRows = 0;
    for await (const row of parseSpreadsheet(await read(), imported.originalFilename)) { void row; totalRows++; }
    await withRun(id, runId, (tx) => tx.import.update({ where: { id }, data: { totalRows } }));
    let batch: ParsedRow[] = [];
    let saved = 0;
    const flush = async () => {
      const writing = batch;
      if (!writing.length) return;
      await withRun(id, runId, async (tx) => {
        await tx.sourceRow.createMany({ data: writing.map((row) => ({
          ...row, importId: id, storeId, rowFingerprint: sha256(Buffer.from(JSON.stringify(row.rawCells)))
          // Status deliberately defaults to PENDING for future catalog processing.
        })), skipDuplicates: true });
        const existing = await tx.sourceRow.findMany({ where: { importId: id,
          OR: writing.map((row) => ({ sheetIndex: row.sheetIndex, rowNumber: row.rowNumber })) } });
        const coordinates = new Map(existing.map((row) => [`${row.sheetIndex}:${row.rowNumber}`, row]));
        for (const row of writing) {
          const actual = coordinates.get(`${row.sheetIndex}:${row.rowNumber}`);
          if (!actual || actual.sheetName !== row.sheetName || !isDeepStrictEqual(actual.rawCells, row.rawCells) || actual.rowFingerprint !== sha256(Buffer.from(JSON.stringify(row.rawCells)))) {
            throw new IngestionError("SOURCE_MISMATCH", "Existing source evidence differs from this parse; immutable rows were not changed.");
          }
        }
      });
      saved += writing.length;
      batch = [];
      await options.afterBatch?.(saved);
    };
    const batchSize = Math.max(1, Math.min(options.batchSize ?? 250, 250));
    for await (const row of parseSpreadsheet(await read(), imported.originalFilename)) {
      batch.push(row);
      if (batch.length >= batchSize) await flush();
    }
    await flush();
    await withRun(id, runId, async (tx) => {
      if (saved !== totalRows || await tx.sourceRow.count({ where: { importId: id } }) !== totalRows) {
        throw new IngestionError("ROW_COUNT_MISMATCH", "Persisted source rows do not match the validated record count.");
      }
      await tx.import.update({ where: { id }, data: { status: "COMPLETED", finishedAt: new Date(), parseRunId: null, errorCode: null, errorMessage: null } });
      if (imported.mappingConfig && typeof imported.mappingConfig === "object" && "profile" in imported.mappingConfig) await tx.catalogTask.createMany({ data: [{ importId: id, storeId }], skipDuplicates: true });
    });
  } catch (error) {
    if (error instanceof Superseded) return;
    if (error instanceof IngestionError) {
      if (!await failParseRun(id, runId, error.code, error.message)) return;
      throw error;
    }
    const updated = await db.import.updateMany({ where: { id, parseRunId: runId, status: "PROCESSING" },
      data: { errorCode: "PARSE_RETRY_PENDING", errorMessage: "Parsing was interrupted. Waiting for a bounded retry." } });
    if (!updated.count) return;
    throw new RetryableParseError(runId);
  }
}
