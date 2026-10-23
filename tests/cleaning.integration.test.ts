import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { getDb, disconnectDatabase } from "@catalogforge/db";
import { cleanSourceRow, configIdentity } from "@catalogforge/cleaning/persistence";
import { exampleConfig, exampleSource } from "@catalogforge/cleaning/example";
import { cleaningConfigSchema, cleaningOutputSchema, type CleaningConfig } from "@catalogforge/cleaning/contracts";

const db = getDb();
let storeId: string;
let supplierId: string;
let importId: string;
let sourceRowId: string;
let mapping: CleaningConfig;
const stores: string[] = [];
beforeEach(async () => {
  storeId = (await db.store.create({ data: { name: "Cleaning fixture" } })).id; stores.push(storeId);
  supplierId = (await db.supplier.create({ data: { storeId, name: "Explicit cleaning policy" } })).id;
  importId = (await db.import.create({ data: { storeId, supplierId, originalFilename: "cleaning.csv", storageKey: crypto.randomUUID(),
    fileSha256: "a".repeat(64), idempotencyKey: crypto.randomUUID(), parserVersion: "spreadsheet-v1", status: "COMPLETED", totalRows: 1 } })).id;
  sourceRowId = (await db.sourceRow.create({ data: { storeId, importId, sheetIndex: 0, sheetName: "Pots", rowNumber: 14, rawCells: exampleSource.rawCells } })).id;
  mapping = { ...structuredClone(exampleConfig), storeId, supplierId };
});
afterEach(async () => {
  await db.rowCleaningResult.deleteMany({ where: { storeId: { in: stores } } });
  await db.product.updateMany({ where: { storeId: { in: stores } }, data: { publishedRevisionId: null } });
  await db.variantRevision.deleteMany({ where: { storeId: { in: stores } } });
  await db.productRevision.deleteMany({ where: { storeId: { in: stores } } });
  await db.variant.deleteMany({ where: { storeId: { in: stores } } });
  await db.product.deleteMany({ where: { storeId: { in: stores } } });
  await db.sourceRow.deleteMany({ where: { storeId: { in: stores } } });
  await db.import.deleteMany({ where: { storeId: { in: stores } } });
  await db.supplier.deleteMany({ where: { storeId: { in: stores } } });
  await db.store.deleteMany({ where: { id: { in: stores } } });
  stores.length = 0;
});
afterAll(disconnectDatabase);
const clean = () => cleanSourceRow(storeId, sourceRowId, mapping);
// Prisma read JSON permits top-level null; validate stored objects before reuse
// as write inputs instead of asserting away that distinction in constraint tests.
function storedData(result: Awaited<ReturnType<typeof clean>>) {
  return { ...result, configSnapshot: cleaningConfigSchema.parse(result.configSnapshot), ...cleaningOutputSchema.parse(result) };
}

it("persists the exact tested example and distinguishes cells, defaults and transformations", async () => {
  const result = await clean();
  expect(result.outcome).toBe("READY");
  expect(result.normalized).toMatchObject({ sku: "00123", priceMinor: "129900", currency: "EUR", quantity: 12,
    weightGrams: 1800, dimensionsCm: { diameter: "20.32" }, attributes: { colour: "terracota" } });
  expect(result.evidence).toMatchObject({ priceMinor: expect.arrayContaining([
    { kind: "cell", sourceRowId, columnIndex: 3, valuePointer: "/value" },
    { kind: "configuration", path: "/symbolCurrencies/€" }, { kind: "transformation", rule: "money.minor-units.v1" }
  ]) });
  expect(result.configSnapshot).toEqual(mapping);
});
it.each([
  ["<p>Frost-resistant.</p><!-- Not frost-proof: bring indoors. -->", "NEEDS_REVIEW", "Frost-resistant."],
  ["Not<p>frost-proof.</p>", "READY", "Not\nfrost-proof."],
  ["Indoor use<ul><li>only</li></ul>", "READY", "Indoor use\n- only"]
])("persists safe descriptions and retains original qualification evidence: %s", async (value, outcome, text) => {
  const rawCells = structuredClone(exampleSource.rawCells); rawCells[2]!.value = value!;
  const source = await db.sourceRow.create({ data: { storeId, importId, sheetIndex: 0, sheetName: "Pots", rowNumber: 15, rawCells } });
  const result = await cleanSourceRow(storeId, source.id, mapping);
  expect(result.outcome).toBe(outcome);
  expect(result.normalized).toMatchObject({ descriptionText: text });
  expect(result.evidence).toMatchObject({ descriptionText: expect.arrayContaining([{ kind: "cell", sourceRowId: source.id, columnIndex: 2, valuePointer: "/value" }]) });
  if (outcome === "NEEDS_REVIEW") expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "DESCRIPTION_COMMENT_REVIEW", severity: "REVIEW" })]));
  expect(await cleanSourceRow(storeId, source.id, mapping)).toEqual(result);
  expect(await db.sourceRow.findUniqueOrThrow({ where: { id: source.id } })).toEqual(source);
});
it("uses database uniqueness for simultaneous retry attempts and leaves the source completely unchanged", async () => {
  const sourceBefore = await db.sourceRow.findUniqueOrThrow({ where: { id: sourceRowId } });
  const results = await Promise.all(Array.from({ length: 8 }, clean));
  expect(new Set(results.map((item) => item.id)).size).toBe(1);
  expect(await db.rowCleaningResult.count({ where: { sourceRowId } })).toBe(1);
  expect(await clean()).toEqual(results[0]);
  expect(await db.sourceRow.findUniqueOrThrow({ where: { id: sourceRowId } })).toEqual(sourceBefore);
  expect(sourceBefore.status).toBe("PENDING");
});
it("retains old results when mappings or supplier policy change", async () => {
  const first = await clean();
  const changed = structuredClone(mapping); changed.columns.description = [{ columnIndex: 8, expectedHeader: "Notes" }];
  const second = await cleanSourceRow(storeId, sourceRowId, changed);
  expect(second.id).not.toBe(first.id); expect(second.configHash).not.toBe(first.configHash);
  expect(second.normalized).toMatchObject({ descriptionText: "Supplier note in a duplicate header; not implicitly merged." });
  expect(await db.rowCleaningResult.findUnique({ where: { id: first.id } })).toEqual(first);
  expect(await db.rowCleaningResult.count({ where: { sourceRowId } })).toBe(2);
});
it("does not create another result just because configuration object keys were reordered", async () => {
  const first = await clean();
  expect(await cleanSourceRow(storeId, sourceRowId, Object.fromEntries(Object.entries(mapping).reverse()))).toEqual(first);
});
it("rejects cross-store references at both service and database boundaries", async () => {
  const other = await db.store.create({ data: { name: "Other cleaning store" } }); stores.push(other.id);
  await expect(cleanSourceRow(other.id, sourceRowId, { ...mapping, storeId: other.id })).rejects.toThrow(/not found/);
  const original = await clean();
  await expect(db.rowCleaningResult.create({ data: { ...storedData(original), id: crypto.randomUUID(), storeId: other.id, configHash: "b".repeat(64) } })).rejects.toThrow(/Foreign key constraint/);
});
it("rejects a nonexistent source reference in PostgreSQL", async () => {
  const original = await clean();
  await expect(db.rowCleaningResult.create({ data: { ...storedData(original), id: crypto.randomUUID(), sourceRowId: crypto.randomUUID() } })).rejects.toThrow(/Foreign key constraint/);
});
it("rejects another supplier's policy even inside the same store", async () => {
  const supplier = await db.supplier.create({ data: { storeId, name: "Another supplier" } });
  await expect(cleanSourceRow(storeId, sourceRowId, { ...mapping, supplierId: supplier.id })).rejects.toThrow(/supplier/);
  expect(await db.rowCleaningResult.count({ where: { sourceRowId } })).toBe(0);
});
it("requires ingestion completion without changing the ingestion or source status", async () => {
  await db.import.update({ where: { id: importId }, data: { status: "PROCESSING" } });
  await expect(clean()).rejects.toThrow(/completed spreadsheet ingestion/);
  expect(await db.rowCleaningResult.count({ where: { sourceRowId } })).toBe(0);
  expect(await db.import.findUnique({ where: { id: importId } })).toMatchObject({ status: "PROCESSING" });
  expect(await db.sourceRow.findUnique({ where: { id: sourceRowId } })).toMatchObject({ status: "PENDING" });
});
it("enforces the versioned uniqueness key directly in PostgreSQL", async () => {
  const result = await clean();
  await expect(db.rowCleaningResult.create({ data: { ...storedData(result), id: crypto.randomUUID() } })).rejects.toThrow(/Unique constraint/);
  await db.rowCleaningResult.create({ data: { ...storedData(result), id: crypto.randomUUID(), cleanerVersion: "future-test-version" } });
  expect(await db.rowCleaningResult.count({ where: { sourceRowId } })).toBe(2);
});
it("checks JSON shapes and hash format in PostgreSQL", async () => {
  const result = await clean();
  for (const invalid of [{ normalized: [] }, { evidence: [] }, { issues: {} }, { configSnapshot: [] }, { configHash: "invalid" }, { cleanerVersion: " " }]) {
    await expect(db.rowCleaningResult.create({ data: { ...storedData(result), id: crypto.randomUUID(), configHash: "b".repeat(64), ...invalid } })).rejects.toThrow(/check constraint/);
  }
});
it("keeps invalid/ambiguous business values reviewable without changing immutable cells", async () => {
  const cells = structuredClone(exampleSource.rawCells); cells[3]!.value = "1,299";
  const row = await db.sourceRow.create({ data: { storeId, importId, sheetIndex: 0, sheetName: "Pots", rowNumber: 15, rawCells: cells } });
  await db.import.update({ where: { id: importId }, data: { totalRows: 2 } });
  const result = await cleanSourceRow(storeId, row.id, { ...mapping, numberFormat: null, defaultCurrency: "EUR" });
  expect(result.outcome).toBe("NEEDS_REVIEW"); expect(result.normalized).toMatchObject({ priceMinor: null });
  expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "AMBIGUOUS_NUMBER" })]));
  expect(await db.sourceRow.findUnique({ where: { id: row.id } })).toEqual(row);
});
it("records malformed source evidence as FAILED without pretending it was normalized", async () => {
  const row = await db.sourceRow.create({ data: { storeId, importId, sheetIndex: 0, sheetName: "Pots", rowNumber: 15, rawCells: [{ columnIndex: 2, header: "SKU", value: "001" }] } });
  const result = await cleanSourceRow(storeId, row.id, mapping);
  expect(result.outcome).toBe("FAILED"); expect(result.issues).toEqual([expect.objectContaining({ code: "INVALID_SOURCE", severity: "ERROR" })]);
  expect(await db.sourceRow.findUnique({ where: { id: row.id } })).toEqual(row);
});
it("retains foreign-key protection and existing source immutability", async () => {
  await clean();
  await expect(db.sourceRow.delete({ where: { id: sourceRowId } })).rejects.toThrow(/Foreign key constraint/);
  await expect(db.sourceRow.update({ where: { id: sourceRowId }, data: { rawCells: [] } })).rejects.toThrow(/immutable/);
});
it("detects an existing result mismatch instead of silently replacing it", async () => {
  const original = await clean();
  const changed = await db.rowCleaningResult.update({ where: { id: original.id }, data: { normalized: { altered: true } } });
  await expect(clean()).rejects.toThrow(/differs/);
  expect(await db.rowCleaningResult.findUnique({ where: { id: original.id } })).toEqual(changed);
});
it("does not create or modify product identities, variants or published snapshots", async () => {
  const product = await db.product.create({ data: { storeId, supplierId, supplierProductKey: "existing-product" } });
  const variant = await db.variant.create({ data: { storeId, productId: product.id, sku: "Existing-001" } });
  const revision = await db.productRevision.create({ data: { storeId, productId: product.id, status: "APPROVED", title: "Merchant title", approvedAt: new Date() } });
  const variantRevision = await db.variantRevision.create({ data: { storeId, productId: product.id, productRevisionId: revision.id, variantId: variant.id, priceMinor: 999n, currency: "GBP" } });
  const publishedProduct = await db.product.update({ where: { id: product.id }, data: { publishedRevisionId: revision.id } });
  await clean();
  expect(await db.product.findUnique({ where: { id: product.id } })).toEqual(publishedProduct);
  expect(await db.variant.findUnique({ where: { id: variant.id } })).toEqual(variant);
  expect(await db.productRevision.findUnique({ where: { id: revision.id } })).toEqual(revision);
  expect(await db.variantRevision.findUnique({ where: { productRevisionId_variantId: { productRevisionId: revision.id, variantId: variant.id } } })).toEqual(variantRevision);
  expect(await db.product.count({ where: { storeId } })).toBe(1);
  expect(await db.variant.count({ where: { storeId } })).toBe(1);
});
it("rejects invalid config before inserting any result", async () => {
  await expect(cleanSourceRow(storeId, sourceRowId, { ...mapping, defaultCurrency: "JPY" })).rejects.toThrow();
  expect(await db.rowCleaningResult.count({ where: { sourceRowId } })).toBe(0);
  expect(configIdentity(mapping).configHash).toMatch(/^[0-9a-f]{64}$/);
});
