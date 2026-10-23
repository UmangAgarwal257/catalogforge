import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disconnectDatabase, getDb } from "@catalogforge/db";
import { registerImport, importDetails } from "@catalogforge/ingestion/imports";
import { LocalOriginalStorage, readOriginal } from "@catalogforge/ingestion/storage";
import { processParseImport, failParseRun, RetryableParseError } from "@catalogforge/ingestion/processing";
import { importEndpoint } from "@catalogforge/ingestion/http";
import { LIMITS } from "@catalogforge/ingestion/contracts";
import ExcelJS from "exceljs";
import { Readable } from "node:stream";

const db = getDb();
let storeId: string;
let supplierId: string;
let directory: string;
let storage: LocalOriginalStorage;
const stores: string[] = [];
const csv = "SKU,Notes,Notes\r\n00123,first,second\r\n00123,first,second\r\n00456,\"two\nlines\",last\r\n";

async function register(text = csv, key = crypto.randomUUID()) {
  return (await registerImport(storage, { storeId, supplierId, idempotencyKey: key, filename: "supplier.csv", bytes: Buffer.from(text) })).imported;
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "catalogforge-ingestion-"));
  storage = new LocalOriginalStorage(directory);
  storeId = (await db.store.create({ data: { name: "Ingestion test" } })).id;
  stores.push(storeId);
  supplierId = (await db.supplier.create({ data: { storeId, name: "Test supplier" } })).id;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await db.sourceRow.deleteMany({ where: { storeId: { in: stores } } });
  await db.import.deleteMany({ where: { storeId: { in: stores } } });
  await db.supplier.deleteMany({ where: { storeId: { in: stores } } });
  await db.store.deleteMany({ where: { id: { in: stores } } });
  stores.length = 0;
  await rm(directory, { recursive: true, force: true });
});
afterAll(disconnectDatabase);

describe("registration and immutable evidence", () => {
  it("atomically registers durable dispatch and preserves the exact original", async () => {
    const imported = await register();
    expect(await readOriginal(storage, imported.storageKey)).toEqual(Buffer.from(csv));
    expect(await db.parseDispatch.findUnique({ where: { importId: imported.id } })).toMatchObject({ dispatchedAt: null });
    expect(imported).toMatchObject({ status: "PENDING", totalRows: null, parseRunId: null });
  });
  it("deduplicates simultaneous requests and removes the losing file", async () => {
    const key = crypto.randomUUID();
    const results = await Promise.all([register(csv, key), register(csv, key), register(csv, key)]);
    expect(new Set(results.map((item) => item.id)).size).toBe(1);
    expect(await readdir(directory)).toHaveLength(1);
    expect(await db.parseDispatch.count({ where: { import: { storeId } } })).toBe(1);
    await expect(register("SKU\nother", key)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", httpStatus: 409 });
    expect((await register(csv)).id).not.toBe(results[0].id);
  });
  it("allows another supplier's request scope but rejects a supplier from another store", async () => {
    const key = crypto.randomUUID();
    await register(csv, key);
    supplierId = (await db.supplier.create({ data: { storeId, name: "Second" } })).id;
    await register(csv, key);
    const other = await db.store.create({ data: { name: "Other" } });
    stores.push(other.id);
    await expect(registerImport(storage, { storeId: other.id, supplierId, idempotencyKey: key, filename: "a.csv", bytes: Buffer.from(csv) }))
      .rejects.toMatchObject({ code: "SUPPLIER_NOT_FOUND" });
    expect(await readdir(directory)).toHaveLength(2);
  });
  it("freezes finalized file identity and parsing configuration but allows progress updates", async () => {
    const imported = await register();
    for (const data of [ { storageKey: "changed" }, { fileSha256: "b".repeat(64) }, { originalFilename: "changed.csv" },
      { parserVersion: "changed" }, { mappingConfig: { changed: true } }, { supplierId: crypto.randomUUID() } ]) {
      await expect(db.import.update({ where: { id: imported.id }, data })).rejects.toThrow(/Import source metadata is immutable/);
    }
    await db.import.update({ where: { id: imported.id }, data: { status: "PROCESSING", totalRows: 3, errorCode: "TEST" } });
    expect((await db.import.findUniqueOrThrow({ where: { id: imported.id } })).storageKey).toBe(imported.storageKey);
  });
});

describe("two-pass persistence and fencing", () => {
  it("persists XLSX sheet coordinates and metadata deterministically across both passes", async () => {
    const book = new ExcelJS.Workbook();
    book.addWorksheet("Empty");
    const sheet = book.addWorksheet("Pots");
    sheet.getRow(2).values = ["SKU", "Notes", "Notes", "Formula"];
    sheet.getRow(5).values = ["0007", "first", "second", { formula: "1+1", result: 2 }];
    const other = book.addWorksheet("Other");
    other.addRow(["SKU"]); other.addRow(["0008"]);
    const { imported } = await registerImport(storage, { storeId, supplierId, idempotencyKey: crypto.randomUUID(), filename: "supplier.xlsx", bytes: new Uint8Array(await book.xlsx.writeBuffer()) });
    await processParseImport(imported.id, storeId, storage, { batchSize: 1 });
    const result = await importDetails(storeId, imported.id, 1, 100);
    expect(result.imported).toMatchObject({ status: "COMPLETED", totalRows: 2 });
    expect(result.rows.map((row) => [row.sheetIndex, row.sheetName, row.rowNumber, row.status])).toEqual([[1, "Pots", 5, "PENDING"], [2, "Other", 2, "PENDING"]]);
    expect(result.rows[0]!.rawCells).toMatchObject([{ value: "0007" }, { header: "Notes" }, { header: "Notes" }, { value: { formula: "1+1", result: 2 } }]);
    expect(result.rows[0]!.issues).toMatchObject([{ code: "FORMULA_UNTRUSTED", columnIndex: 3 }]);
  });
  it("persists 10,000 accepted records with exact totals and bounded batches", async () => {
    const imported = await register("SKU\n" + "001\n".repeat(10000));
    let batches = 0;
    await processParseImport(imported.id, storeId, storage, { afterBatch: async () => { batches++; } });
    expect(batches).toBe(40);
    expect(await db.sourceRow.count({ where: { importId: imported.id, status: "PENDING" } })).toBe(10000);
    expect(await db.import.findUniqueOrThrow({ where: { id: imported.id } })).toMatchObject({ status: "COMPLETED", totalRows: 10000 });
  }, 30000);
  it("completes a header-only spreadsheet with zero accepted rows", async () => {
    const imported = await register("SKU,Notes\n\n");
    await processParseImport(imported.id, storeId, storage);
    expect(await db.import.findUniqueOrThrow({ where: { id: imported.id } })).toMatchObject({ status: "COMPLETED", totalRows: 0 });
  });
  it("preserves repeated ordered evidence and completes ingestion with source rows still PENDING", async () => {
    const imported = await register();
    await processParseImport(imported.id, storeId, storage);
    const { imported: result, rows } = await importDetails(storeId, imported.id, 1, 100);
    expect(result).toMatchObject({ status: "COMPLETED", totalRows: 3, errorCode: null, _count: { sourceRows: 3 } });
    expect(result.startedAt).toBeInstanceOf(Date);
    expect(result.finishedAt).toBeInstanceOf(Date);
    expect(rows.map((row) => [row.rowNumber, row.status])).toEqual([[2, "PENDING"], [3, "PENDING"], [4, "PENDING"]]);
    expect(rows[0]!.rawCells).toEqual(rows[1]!.rawCells);
    expect(rows[0]!.rawCells).toEqual([
      { columnIndex: 0, header: "SKU", value: "00123", metadata: {} },
      { columnIndex: 1, header: "Notes", value: "first", metadata: {} },
      { columnIndex: 2, header: "Notes", value: "second", metadata: {} }
    ]);
    await processParseImport(imported.id, storeId, storage);
    expect((await importDetails(storeId, imported.id, 1, 100)).rows).toEqual(rows);
    await expect(db.sourceRow.update({ where: { id: rows[0]!.id }, data: { rawCells: [] } })).rejects.toThrow(/immutable/);
  });
  it.each([ ["SKU\n\"unclosed", "MALFORMED_CSV"], ["SKU\n" + "x\n".repeat(10001), "ROW_LIMIT"] ])(
    "validates the whole file before any writes", async (text, code) => {
      const imported = await register(text);
      await expect(processParseImport(imported.id, storeId, storage)).rejects.toMatchObject({ code });
      expect(await db.sourceRow.count({ where: { importId: imported.id } })).toBe(0);
      expect(await db.import.findUniqueOrThrow({ where: { id: imported.id } })).toMatchObject({ status: "FAILED", totalRows: null, errorCode: code });
    }
  );
  it("retries a partial write without duplicates or changes to original evidence", async () => {
    const imported = await register();
    await expect(processParseImport(imported.id, storeId, storage, { batchSize: 1, afterBatch: async () => { throw new Error("simulated connection loss"); } }))
      .rejects.toBeInstanceOf(RetryableParseError);
    const partial = await db.sourceRow.findMany({ where: { importId: imported.id } });
    expect(partial).toHaveLength(1);
    const interrupted = await db.import.findUniqueOrThrow({ where: { id: imported.id } });
    expect(interrupted).toMatchObject({ status: "PROCESSING", totalRows: 3, finishedAt: null, errorCode: "PARSE_RETRY_PENDING" });
    await processParseImport(imported.id, storeId, storage);
    expect(await db.sourceRow.count({ where: { importId: imported.id } })).toBe(3);
    expect(await db.sourceRow.findUnique({ where: { id: partial[0]!.id } })).toEqual(partial[0]);
    await failParseRun(imported.id, interrupted.parseRunId, "STALE_FAILURE", "Stale attempt");
    expect(await db.import.findUniqueOrThrow({ where: { id: imported.id } })).toMatchObject({ status: "COMPLETED", errorCode: null });
  });
  it("fences an overlapping attempt after a replacement run takes ownership", async () => {
    const imported = await register();
    let release!: () => void;
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { reached = resolve; });
    const first = processParseImport(imported.id, storeId, storage, { batchSize: 1, afterBatch: async () => { reached(); await paused; } });
    await ready;
    try {
      await processParseImport(imported.id, storeId, storage);
    } finally { release(); }
    await first;
    expect(await db.import.findUniqueOrThrow({ where: { id: imported.id } })).toMatchObject({ status: "COMPLETED", totalRows: 3, parseRunId: null });
    expect(await db.sourceRow.count({ where: { importId: imported.id } })).toBe(3);
  });
  it("ignores validation errors from a superseded run instead of failing the replacement job", async () => {
    const imported = await register();
    let release!: () => void;
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { reached = resolve; });
    const old = processParseImport(imported.id, storeId, {
      save: (bytes) => storage.save(bytes), remove: (key) => storage.remove(key),
      open: async () => { reached(); await paused; return Readable.from([Buffer.from("changed")]); }
    });
    await ready;
    try { await processParseImport(imported.id, storeId, storage); }
    finally { release(); }
    await expect(old).resolves.toBeUndefined();
    expect(await db.import.findUniqueOrThrow({ where: { id: imported.id } })).toMatchObject({ status: "COMPLETED", errorCode: null });
  });
  it("rejects a coordinate collision with different evidence instead of overwriting it", async () => {
    const imported = await register();
    const original = await db.sourceRow.create({ data: { importId: imported.id, storeId, sheetIndex: 0, sheetName: "CSV", rowNumber: 2, rawCells: [], rowFingerprint: "a".repeat(64) } });
    await expect(processParseImport(imported.id, storeId, storage)).rejects.toMatchObject({ code: "SOURCE_MISMATCH" });
    expect(await db.sourceRow.findMany({ where: { importId: imported.id } })).toEqual([original]);
    expect((await db.import.findUniqueOrThrow({ where: { id: imported.id } })).status).toBe("FAILED");
  });
  it("detects modified file bytes using the finalized hash", async () => {
    const imported = await register();
    await writeFile(join(directory, imported.storageKey), "SKU\nchanged");
    await expect(processParseImport(imported.id, storeId, storage)).rejects.toMatchObject({ code: "FILE_HASH_MISMATCH" });
    expect(await db.sourceRow.count({ where: { importId: imported.id } })).toBe(0);
  });
});

describe("local import HTTP contract", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEV_INGESTION_ENABLED", "true");
    vi.stubEnv("DEV_STORE_ID", storeId);
    vi.stubEnv("LOCAL_UPLOAD_DIR", directory);
    vi.stubEnv("VERCEL", "");
  });
  function upload(filename = "supplier.csv", text = csv, key = "request-1") {
    const form = new FormData();
    form.set("file", new File([text], filename));
    form.set("supplierId", supplierId);
    form.set("idempotencyKey", key);
    return new Request("http://localhost:3000/api/imports", { method: "POST", body: form });
  }
  it("accepts uploads, returns scoped paginated details and omits private storage metadata", async () => {
    const response = await importEndpoint(upload());
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toMatchObject({ status: "PENDING", reused: false });
    if (!body || typeof body !== "object" || !("importId" in body) || typeof body.importId !== "string") throw new Error("Missing import ID");
    expect((await importEndpoint(upload())).status).toBe(200);
    await processParseImport(body.importId, storeId, storage);
    const list = await importEndpoint(new Request("http://localhost:3000/api/imports"));
    const listed = await list.json();
    expect(listed).toMatchObject({ imports: [{ id: body.importId, status: "COMPLETED" }] });
    expect(JSON.stringify(listed)).not.toContain("storageKey");
    expect(JSON.stringify(listed)).not.toContain("parseRunId");
    const detail = await importEndpoint(new Request("http://localhost:3000/api/imports?pageSize=1&page=2"), body.importId);
    expect(await detail.json()).toMatchObject({ rows: [{ rowNumber: 3, status: "PENDING" }], page: 2, pageSize: 1 });
    const other = await db.store.create({ data: { name: "Other" } });
    stores.push(other.id);
    vi.stubEnv("DEV_STORE_ID", other.id);
    expect((await importEndpoint(new Request("http://localhost:3000/api/imports"), body.importId)).status).toBe(404);
  });
  it("rejects invalid fields, types, ids and pagination without registering work", async () => {
    expect((await importEndpoint(upload("payload.exe"))).status).toBe(415);
    expect((await importEndpoint(upload("a.csv", ""))).status).toBe(422);
    expect((await importEndpoint(upload("a.csv", csv, " "))).status).toBe(400);
    expect((await importEndpoint(new Request("http://localhost:3000/api/imports?pageSize=101"))).status).toBe(400);
    expect((await importEndpoint(new Request("http://localhost:3000/api/imports"), "invalid")).status).toBe(400);
    expect(await db.import.count({ where: { storeId } })).toBe(0);
  });
  it("enforces both the file limit and a streamed body limit without Content-Length", async () => {
    expect((await importEndpoint(upload("a.csv", "x".repeat(LIMITS.fileBytes + 1)))).status).toBe(413);
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(LIMITS.fileBytes + 65537)); controller.close(); } });
    const request = new Request("http://localhost:3000/api/imports", { method: "POST", body: stream, headers: { "content-type": "multipart/form-data; boundary=x" }, duplex: "half" } as RequestInit);
    expect((await importEndpoint(request)).status).toBe(413);
    expect(await db.import.count({ where: { storeId } })).toBe(0);
  });
  it("blocks production, Vercel, disabled access, remote hosts and cross-origin requests", async () => {
    const local = () => new Request("http://localhost:3000/api/imports");
    vi.stubEnv("NODE_ENV", "production");
    expect((await importEndpoint(local())).status).toBe(404);
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL", "1");
    expect((await importEndpoint(local())).status).toBe(404);
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("DEV_INGESTION_ENABLED", "false");
    expect((await importEndpoint(local())).status).toBe(404);
    vi.stubEnv("DEV_INGESTION_ENABLED", "true");
    expect((await importEndpoint(new Request("http://example.com/api/imports"))).status).toBe(403);
    expect((await importEndpoint(new Request(local(), { headers: { origin: "https://example.com" } }))).status).toBe(403);
    expect((await importEndpoint(new Request(local(), { headers: { "sec-fetch-site": "cross-site" } }))).status).toBe(403);
  });
});
