import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { disconnectDatabase, getDb } from "@catalogforge/db";

const db = getDb();
const stores: string[] = [];
let storeId: string;
let supplierId: string;
let importId: string;

const cells = [
  { columnIndex: 0, header: "SKU", value: "00123" },
  { columnIndex: 1, header: "Notes", value: "frost-resistant" },
  { columnIndex: 2, header: "Notes", value: "not frost-proof" }
];

async function createStore() {
  const id = crypto.randomUUID();
  stores.push(id);
  return db.store.create({ data: { id, name: `Supplier data test ${id}` } });
}

function importData(ownerId: string, sourceId: string) {
  return {
    storeId: ownerId,
    supplierId: sourceId,
    originalFilename: "supplier.csv",
    storageKey: `private/test/${crypto.randomUUID()}/supplier.csv`,
    fileSha256: "a".repeat(64),
    idempotencyKey: crypto.randomUUID(),
    parserVersion: "test-v1",
    mappingConfig: [{ columnIndex: 0, targetField: "sku" }]
  };
}

function rowData(rowNumber = 2) {
  return { importId, storeId, sheetIndex: 0, sheetName: "Sheet 1", rowNumber, rawCells: cells };
}

beforeEach(async () => {
  storeId = (await createStore()).id;
  supplierId = (await db.supplier.create({ data: { storeId, name: "Test supplier" } })).id;
  importId = (await db.import.create({ data: importData(storeId, supplierId) })).id;
});

afterEach(async () => {
  // Delete only fixtures owned by stores created by this suite, in FK order.
  await db.sourceRow.deleteMany({ where: { storeId: { in: stores } } });
  await db.import.deleteMany({ where: { storeId: { in: stores } } });
  await db.supplier.deleteMany({ where: { storeId: { in: stores } } });
  await db.store.deleteMany({ where: { id: { in: stores } } });
  stores.length = 0;
});

afterAll(async () => { await disconnectDatabase(); });

describe("supplier ownership and import identity", () => {
  it("lets a store own multiple suppliers", async () => {
    await db.supplier.create({ data: { storeId, name: "Another supplier" } });
    const store = await db.store.findUniqueOrThrow({ where: { id: storeId }, include: { suppliers: true } });
    expect(store.suppliers).toHaveLength(2);
  });

  it("lets a supplier have multiple imports, including identical file hashes", async () => {
    await db.import.create({ data: importData(storeId, supplierId) });
    const supplier = await db.supplier.findUniqueOrThrow({ where: { id: supplierId }, include: { imports: true } });
    expect(supplier.imports).toHaveLength(2);
    expect(new Set(supplier.imports.map((item) => item.fileSha256)).size).toBe(1);
  });

  it("rejects a cross-store supplier/import relationship on insert and update", async () => {
    const otherStore = await createStore();
    await expect(db.import.create({ data: importData(otherStore.id, supplierId) })).rejects.toMatchObject({ code: "P2003" });
    await expect(db.import.update({ where: { id: importId }, data: { storeId: otherStore.id } })).rejects.toMatchObject({ code: "P2003" });
  });

  it("rejects source rows whose store differs from their import", async () => {
    const otherStore = await createStore();
    await expect(db.sourceRow.create({ data: { ...rowData(), storeId: otherStore.id } })).rejects.toMatchObject({ code: "P2003" });
  });

  it("rejects repeated idempotency keys in the same store/supplier scope", async () => {
    const existing = await db.import.findUniqueOrThrow({ where: { id: importId } });
    await expect(db.import.create({ data: { ...importData(storeId, supplierId), idempotencyKey: existing.idempotencyKey } })).rejects.toMatchObject({ code: "P2002" });
  });

  it("allows the same idempotency key for another supplier or store", async () => {
    const original = await db.import.findUniqueOrThrow({ where: { id: importId } });
    const otherSupplier = await db.supplier.create({ data: { storeId, name: "Other supplier" } });
    const otherStore = await createStore();
    const externalSupplier = await db.supplier.create({ data: { storeId: otherStore.id, name: "External supplier" } });
    await db.import.create({ data: { ...importData(storeId, otherSupplier.id), idempotencyKey: original.idempotencyKey } });
    await db.import.create({ data: { ...importData(otherStore.id, externalSupplier.id), idempotencyKey: original.idempotencyKey } });
    expect(await db.import.count({ where: { storeId: { in: stores }, idempotencyKey: original.idempotencyKey } })).toBe(3);
  });

  it("enforces request uniqueness for concurrent insert attempts", async () => {
    const data = importData(storeId, supplierId);
    const results = await Promise.allSettled([
      db.import.create({ data }),
      db.import.create({ data })
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await db.import.count({ where: { storeId, supplierId, idempotencyKey: data.idempotencyKey } })).toBe(1);
  });
});

describe("source records and progress", () => {
  it("lets an import have multiple rows with identical content and fingerprints", async () => {
    await db.sourceRow.create({ data: { ...rowData(2), rowFingerprint: "identical-content" } });
    await db.sourceRow.create({ data: { ...rowData(3), rowFingerprint: "identical-content" } });
    const imported = await db.import.findUniqueOrThrow({ where: { id: importId }, include: { sourceRows: { orderBy: { rowNumber: "asc" } } } });
    expect(imported.sourceRows).toHaveLength(2);
    expect(imported.sourceRows[0]?.rawCells).toEqual(imported.sourceRows[1]?.rawCells);
  });

  it("rejects duplicate physical coordinates in one import", async () => {
    await db.sourceRow.create({ data: rowData() });
    await expect(db.sourceRow.create({ data: rowData() })).rejects.toMatchObject({ code: "P2002" });
  });

  it("allows a row number on another sheet or in another import", async () => {
    await db.sourceRow.create({ data: rowData() });
    await db.sourceRow.create({ data: { ...rowData(), sheetIndex: 1, sheetName: "Sheet 2" } });
    const otherImport = await db.import.create({ data: importData(storeId, supplierId) });
    await db.sourceRow.create({ data: { ...rowData(), importId: otherImport.id } });
    expect(await db.sourceRow.count({ where: { storeId } })).toBe(3);
  });

  it("preserves cell order, duplicate headers, and leading-zero text", async () => {
    const row = await db.sourceRow.create({ data: rowData() });
    const restored = await db.sourceRow.findUniqueOrThrow({ where: { id: row.id } });
    expect(restored.rawCells).toEqual(cells);
    expect(restored.sheetIndex).toBe(0);
    expect(restored.rowNumber).toBe(2);
    expect(restored.rowFingerprint).toBeNull();
    expect(restored.issues).toEqual([]);
  });

  it("keeps all import statuses independent of all row statuses", async () => {
    const row = await db.sourceRow.create({ data: rowData() });
    expect(row.status).toBe("PENDING");
    expect((await db.import.findUniqueOrThrow({ where: { id: importId } })).status).toBe("PENDING");
    for (const status of ["PENDING", "PROCESSING", "PAUSED", "COMPLETED", "FAILED"] as const) {
      await db.import.update({ where: { id: importId }, data: { status } });
      expect((await db.sourceRow.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("PENDING");
    }
    for (const status of ["PENDING", "PROCESSING", "DONE", "NEEDS_REVIEW", "FAILED"] as const) {
      await db.sourceRow.update({ where: { id: row.id }, data: { status } });
      expect((await db.import.findUniqueOrThrow({ where: { id: importId } })).status).toBe("FAILED");
    }
  });

  it("allows an unknown total before parsing and zero or positive totals later", async () => {
    expect((await db.import.findUniqueOrThrow({ where: { id: importId } })).totalRows).toBeNull();
    for (const totalRows of [0, 3]) {
      const updated = await db.import.update({ where: { id: importId }, data: { totalRows } });
      expect(updated.totalRows).toBe(totalRows);
    }
  });
});

describe("foreign keys and deletion", () => {
  it("rejects nonexistent store, supplier, and import references", async () => {
    const missing = crypto.randomUUID();
    await expect(db.supplier.create({ data: { storeId: missing, name: "Invalid owner" } })).rejects.toMatchObject({ code: "P2003" });
    await expect(db.import.create({ data: importData(missing, supplierId) })).rejects.toMatchObject({ code: "P2003" });
    await expect(db.import.create({ data: importData(storeId, missing) })).rejects.toMatchObject({ code: "P2003" });
    await expect(db.sourceRow.create({ data: { ...rowData(), importId: missing } })).rejects.toMatchObject({ code: "P2003" });
  });

  it("restricts parent deletion but allows explicit child-first cleanup", async () => {
    const row = await db.sourceRow.create({ data: rowData() });
    await expect(db.import.delete({ where: { id: importId } })).rejects.toMatchObject({ code: "P2003" });
    await expect(db.supplier.delete({ where: { id: supplierId } })).rejects.toMatchObject({ code: "P2003" });
    await expect(db.store.delete({ where: { id: storeId } })).rejects.toMatchObject({ code: "P2003" });
    await db.sourceRow.delete({ where: { id: row.id } });
    await db.import.delete({ where: { id: importId } });
    await db.supplier.delete({ where: { id: supplierId } });
    await db.store.delete({ where: { id: storeId } });
    expect(await db.store.findUnique({ where: { id: storeId } })).toBeNull();
  });
});

describe("PostgreSQL checks", () => {
  it("rejects negative total row counts", async () => {
    await expect(db.$executeRaw`UPDATE "Import" SET "totalRows" = -1 WHERE "id" = ${importId}::uuid`).rejects.toThrow(/Import_totalRows_nonnegative/);
  });

  it("rejects invalid SHA-256 values and blank request keys", async () => {
    await expect(db.$executeRaw`UPDATE "Import" SET "fileSha256" = 'not-a-sha256' WHERE "id" = ${importId}::uuid`).rejects.toThrow(/Import_fileSha256_format/);
    await expect(db.$executeRaw`UPDATE "Import" SET "idempotencyKey" = '   ' WHERE "id" = ${importId}::uuid`).rejects.toThrow(/Import_idempotencyKey_nonblank/);
  });

  it("rejects negative sheet indexes and nonpositive physical rows", async () => {
    await expect(db.sourceRow.create({ data: { ...rowData(), sheetIndex: -1 } })).rejects.toThrow(/SourceRow_sheetIndex_nonnegative/);
    await expect(db.sourceRow.create({ data: rowData(0) })).rejects.toThrow(/SourceRow_rowNumber_positive/);
    await expect(db.sourceRow.create({ data: rowData(-1) })).rejects.toThrow(/SourceRow_rowNumber_positive/);
  });

  it("rejects object-shaped source cells and issues", async () => {
    await expect(db.sourceRow.create({ data: { ...rowData(), rawCells: { SKU: "would lose duplicate headers" } } })).rejects.toThrow(/SourceRow_rawCells_array/);
    await expect(db.sourceRow.create({ data: { ...rowData(), issues: {} } })).rejects.toThrow(/SourceRow_issues_array/);
  });

  it("rejects JSON null as the source-cell array", async () => {
    const id = crypto.randomUUID();
    await expect(db.$executeRaw`
      INSERT INTO "SourceRow" ("id", "importId", "storeId", "sheetIndex", "sheetName", "rowNumber", "rawCells")
      VALUES (${id}::uuid, ${importId}::uuid, ${storeId}::uuid, 0, 'Sheet 1', 2, 'null'::jsonb)
    `).rejects.toThrow(/SourceRow_rawCells_array/);
  });
});

describe("source immutability", () => {
  const changes = [
    ["id", (id: string) => db.$executeRaw`UPDATE "SourceRow" SET "id" = ${crypto.randomUUID()}::uuid WHERE "id" = ${id}::uuid`],
    ["import identity", (id: string) => db.$executeRaw`UPDATE "SourceRow" SET "importId" = ${crypto.randomUUID()}::uuid WHERE "id" = ${id}::uuid`],
    ["store identity", (id: string) => db.$executeRaw`UPDATE "SourceRow" SET "storeId" = ${crypto.randomUUID()}::uuid WHERE "id" = ${id}::uuid`],
    ["sheet index", (id: string) => db.$executeRaw`UPDATE "SourceRow" SET "sheetIndex" = 1 WHERE "id" = ${id}::uuid`],
    ["sheet name", (id: string) => db.$executeRaw`UPDATE "SourceRow" SET "sheetName" = 'Different sheet' WHERE "id" = ${id}::uuid`],
    ["row number", (id: string) => db.$executeRaw`UPDATE "SourceRow" SET "rowNumber" = 3 WHERE "id" = ${id}::uuid`],
    ["original cells", (id: string) => db.$executeRaw`UPDATE "SourceRow" SET "rawCells" = '[]'::jsonb WHERE "id" = ${id}::uuid`],
    ["fingerprint", (id: string) => db.$executeRaw`UPDATE "SourceRow" SET "rowFingerprint" = 'replacement' WHERE "id" = ${id}::uuid`],
    ["creation time", (id: string) => db.$executeRaw`UPDATE "SourceRow" SET "createdAt" = "createdAt" + interval '1 second' WHERE "id" = ${id}::uuid`]
  ] as const;

  it.each(changes)("blocks direct SQL changes to %s", async (_field, change) => {
    const original = await db.sourceRow.create({ data: rowData() });
    await expect(change(original.id)).rejects.toThrow(/SourceRow source fields are immutable/);
    expect(await db.sourceRow.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original);
  });

  it("also blocks original-cell changes through Prisma", async () => {
    const row = await db.sourceRow.create({ data: rowData() });
    await expect(db.sourceRow.update({ where: { id: row.id }, data: { rawCells: [] } })).rejects.toThrow(/SourceRow source fields are immutable/);
    expect((await db.sourceRow.findUniqueOrThrow({ where: { id: row.id } })).rawCells).toEqual(cells);
  });

  it("allows status, structured issues, and updatedAt updates without changing evidence", async () => {
    const original = await db.sourceRow.create({ data: rowData() });
    const updatedAt = new Date(original.updatedAt.getTime() + 1000);
    const issues = [{ code: "MISSING_PRICE", columnIndex: 3, message: "Price requires review" }];
    const updated = await db.sourceRow.update({
      where: { id: original.id }, data: { status: "NEEDS_REVIEW", issues, updatedAt }
    });
    expect(updated).toEqual({ ...original, status: "NEEDS_REVIEW", issues, updatedAt });
  });

  it("allows unchanged source fields and automatic updatedAt updates", async () => {
    const original = await db.sourceRow.create({ data: rowData() });
    await db.$executeRaw`UPDATE "SourceRow" SET "updatedAt" = '2000-01-01'::timestamptz WHERE "id" = ${original.id}::uuid`;
    const updated = await db.sourceRow.update({
      where: { id: original.id }, data: { rawCells: cells, status: "PROCESSING" }
    });
    expect(updated.rawCells).toEqual(cells);
    expect(updated.status).toBe("PROCESSING");
    expect(updated.updatedAt.getTime()).toBeGreaterThan(new Date("2000-01-01").getTime());
  });
});
