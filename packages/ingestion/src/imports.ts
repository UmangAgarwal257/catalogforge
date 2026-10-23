import { getDb } from "@catalogforge/db";
import { PARSER_VERSION, IngestionError, uploadFieldsSchema, validateFile } from "./contracts";
import { sha256, type OriginalStorage } from "./storage";

export async function registerImport(storage: OriginalStorage, input: {
  storeId: string; supplierId: string; idempotencyKey: string; filename: string; bytes: Uint8Array;
}) {
  const fields = uploadFieldsSchema.safeParse(input);
  if (!fields.success) throw new IngestionError("INVALID_FIELDS", "Provide a valid supplier UUID and a request key (1–200 characters).", 400);
  if (!input.filename || input.filename.length > 255 || /[\x00-\x1f]/.test(input.filename)) throw new IngestionError("INVALID_FILENAME", "Provide a filename of at most 255 characters without control characters.", 400);
  validateFile(input.bytes, input.filename);
  const db = getDb();
  if (!await db.supplier.findFirst({ where: { id: fields.data.supplierId, storeId: input.storeId } })) {
    throw new IngestionError("SUPPLIER_NOT_FOUND", "Supplier does not belong to the configured development store.", 404);
  }
  const hash = sha256(input.bytes);
  const scope = { storeId: input.storeId, supplierId: fields.data.supplierId, idempotencyKey: fields.data.idempotencyKey };
  const existing = await db.import.findUnique({ where: { storeId_supplierId_idempotencyKey: scope } });
  const compatible = (item: NonNullable<typeof existing>) => {
    if (item.fileSha256 !== hash || item.originalFilename !== input.filename || item.parserVersion !== PARSER_VERSION) {
      throw new IngestionError("IDEMPOTENCY_CONFLICT", "This request key already identifies a different upload. Use a new key for intentional reprocessing.", 409);
    }
    return { imported: item, reused: true };
  };
  if (existing) return compatible(existing);
  const key = await storage.save(input.bytes);
  try {
    const imported = await db.$transaction(async (tx) => {
      const item = await tx.import.create({ data: {
        ...scope, originalFilename: input.filename, storageKey: key,
        fileSha256: hash, parserVersion: PARSER_VERSION, mappingConfig: {}
      } });
      await tx.parseDispatch.create({ data: { importId: item.id } });
      return item;
    });
    return { imported, reused: false };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
      const winner = await db.import.findUnique({ where: { storeId_supplierId_idempotencyKey: scope } });
      if (winner) {
        await storage.remove(key);
        return compatible(winner);
      }
    }
    // A lost commit acknowledgement is ambiguous. Retain the original rather than
    // delete a file that a committed Import may reference. Retry with the same key.
    throw new IngestionError("REGISTRATION_UNAVAILABLE", "Import registration could not be confirmed. Retry with the same request key.", 503);
  }
}

const summarySelect = {
  id: true, supplierId: true, originalFilename: true, status: true, totalRows: true,
  errorCode: true, errorMessage: true, createdAt: true, startedAt: true, finishedAt: true,
  _count: { select: { sourceRows: true } },
  supplier: { select: { name: true } }
} as const;

export async function listImports(storeId: string, page: number, pageSize: number) {
  const items = await getDb().import.findMany({ where: { storeId }, select: summarySelect,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * pageSize, take: pageSize + 1 });
  return { imports: items.slice(0, pageSize), hasMore: items.length > pageSize };
}

export async function listSuppliers(storeId: string, page: number, pageSize: number) {
  const items = await getDb().supplier.findMany({ where: { storeId }, select: { id: true, name: true },
    orderBy: [{ name: "asc" }, { id: "asc" }], skip: (page - 1) * pageSize, take: pageSize + 1 });
  return { suppliers: items.slice(0, pageSize), hasMore: items.length > pageSize };
}

export async function importDetails(storeId: string, id: string, page: number, pageSize: number) {
  const db = getDb();
  return db.$transaction(async (tx) => {
    const imported = await tx.import.findFirst({ where: { id, storeId }, select: summarySelect });
    if (!imported) throw new IngestionError("IMPORT_NOT_FOUND", "Import was not found in this development store.", 404);
    const rows = await tx.sourceRow.findMany({ where: { importId: id, storeId },
      orderBy: [{ sheetIndex: "asc" }, { rowNumber: "asc" }], skip: (page - 1) * pageSize, take: pageSize });
    return { imported, rows, page, pageSize };
  }, { isolationLevel: "RepeatableRead" });
}
