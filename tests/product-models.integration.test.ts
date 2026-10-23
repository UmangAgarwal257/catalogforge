import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { disconnectDatabase, findVariantBySku, getDb } from "@catalogforge/db";

const db = getDb();
const storeIds: string[] = [];

async function fixture() {
  const storeId = crypto.randomUUID();
  storeIds.push(storeId);
  const store = await db.store.create({ data: { id: storeId, name: `Catalog test ${storeId}` } });
  const supplier = await db.supplier.create({ data: { storeId, name: "Catalog supplier" } });
  const imported = await db.import.create({ data: {
    storeId, supplierId: supplier.id, originalFilename: "pots.csv",
    storageKey: `private/test/${crypto.randomUUID()}`, fileSha256: "b".repeat(64),
    idempotencyKey: crypto.randomUUID(), parserVersion: "test-v1"
  } });
  const row = await db.sourceRow.create({ data: {
    storeId, importId: imported.id, sheetIndex: 0, sheetName: "Pots", rowNumber: 2,
    rawCells: [{ columnIndex: 0, header: "SKU", value: " TC-PL-20 " }]
  } });
  const product = await db.product.create({ data: { storeId, supplierId: supplier.id, supplierProductKey: "POT-TC" } });
  const variant = await db.variant.create({ data: { storeId, productId: product.id, sku: " TC-PL-20 " } });
  const revision = await db.productRevision.create({ data: { storeId, productId: product.id, originImportId: imported.id } });
  return { store, supplier, imported, row, product, variant, revision };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
let f: Fixture;

function snapshotData(owner = f) {
  return {
    productRevisionId: owner.revision.id, variantId: owner.variant.id,
    storeId: owner.store.id, productId: owner.product.id,
    options: { size: "20 cm" }, priceMinor: 2499n, currency: "EUR", weightGrams: 1800
  };
}

function evidenceData(owner = f) {
  return {
    sourceRowId: owner.row.id, productRevisionId: owner.revision.id,
    variantId: owner.variant.id, storeId: owner.store.id
  };
}

async function anotherProduct() {
  return db.product.create({ data: { storeId: f.store.id, supplierId: f.supplier.id } });
}

beforeEach(async () => { f = await fixture(); });
afterEach(async () => {
  const where = { storeId: { in: storeIds } };
  // Clear circular references before deleting only this suite's fixture graph.
  await db.revisionSourceRow.deleteMany({ where });
  await db.variantRevision.deleteMany({ where });
  await db.product.updateMany({ where, data: { publishedRevisionId: null } });
  await db.productRevision.updateMany({ where, data: { basePublishedRevisionId: null } });
  await db.productRevision.deleteMany({ where });
  await db.variant.deleteMany({ where });
  await db.product.deleteMany({ where });
  await db.sourceRow.deleteMany({ where });
  await db.import.deleteMany({ where });
  await db.supplier.deleteMany({ where });
  await db.store.deleteMany({ where: { id: { in: storeIds } } });
  storeIds.length = 0;
});
afterAll(async () => { await disconnectDatabase(); });

describe("product and variant identities", () => {
  it("creates stable identities and several variants for one product", async () => {
    await db.variant.create({ data: { storeId: f.store.id, productId: f.product.id, sku: "TC-PL-30" } });
    const product = await db.product.findUniqueOrThrow({ where: { id: f.product.id }, include: { variants: true } });
    expect(product.variants).toHaveLength(2);
    expect(product.publishedRevisionId).toBeNull();
    expect(product.archivedAt).toBeNull();
    expect(product.variants.map((variant) => variant.sku).sort()).toEqual(["tc-pl-20", "tc-pl-30"]);
  });

  it("enforces supplier product keys in store/supplier scope", async () => {
    await expect(db.product.create({ data: { storeId: f.store.id, supplierId: f.supplier.id, supplierProductKey: "POT-TC" } })).rejects.toMatchObject({ code: "P2002" });
    const supplier = await db.supplier.create({ data: { storeId: f.store.id, name: "Another supplier" } });
    await db.product.create({ data: { storeId: f.store.id, supplierId: supplier.id, supplierProductKey: "POT-TC" } });
    const other = await fixture();
    expect(other.product.supplierProductKey).toBe("POT-TC");
    await anotherProduct();
    await anotherProduct(); // Unknown supplier identifiers must not collide as fake values.
  });

  it("keeps archived supplier identities reserved", async () => {
    await db.product.update({ where: { id: f.product.id }, data: { archivedAt: new Date() } });
    await expect(db.product.create({ data: { storeId: f.store.id, supplierId: f.supplier.id, supplierProductKey: "POT-TC" } })).rejects.toMatchObject({ code: "P2002" });
  });

  it("rejects a product owned by a supplier in another store", async () => {
    const other = await fixture();
    await expect(db.product.create({ data: { storeId: f.store.id, supplierId: other.supplier.id } })).rejects.toMatchObject({ code: "P2003" });
  });

  it("rejects a variant whose store differs from its product", async () => {
    const other = await fixture();
    await expect(db.variant.create({ data: { storeId: other.store.id, productId: f.product.id, sku: "NEW" } })).rejects.toMatchObject({ code: "P2003" });
  });
});

describe("database SKU canonicalization", () => {
  it.each(["TC-PL-20", "tc-pl-20", " \tTc-Pl-20\r\n"])("rejects equivalent SKU %j", async (sku) => {
    const product = await anotherProduct();
    await expect(db.variant.create({ data: { storeId: f.store.id, productId: product.id, sku } })).rejects.toMatchObject({ code: "P2002" });
  });

  it("uses the same normalization for inserts, explicit updates, and lookups", async () => {
    expect(f.variant.sku).toBe("tc-pl-20");
    expect((await findVariantBySku(f.store.id, "\tTC-Pl-20 \n"))?.id).toBe(f.variant.id);
    const updated = await db.variant.update({ where: { id: f.variant.id }, data: { sku: " \tRenamed-20\n" } });
    expect(updated.sku).toBe("renamed-20");
    expect((await findVariantBySku(f.store.id, " RENAMED-20 "))?.id).toBe(f.variant.id);
    expect(await findVariantBySku(f.store.id, "TC-PL-20")).toBeNull();
    expect(await findVariantBySku(f.store.id, "unknown-sku")).toBeNull();
    expect((await db.sourceRow.findUniqueOrThrow({ where: { id: f.row.id } })).rawCells).toEqual([
      { columnIndex: 0, header: "SKU", value: " TC-PL-20 " }
    ]);
  });

  it("canonicalizes direct SQL writes and preserves internal whitespace/punctuation", async () => {
    const id = crypto.randomUUID();
    await db.$executeRaw`INSERT INTO "Variant" ("id", "productId", "storeId", "sku") VALUES (${id}::uuid, ${f.product.id}::uuid, ${f.store.id}::uuid, E'\tRaw  SKU-01\n')`;
    expect((await findVariantBySku(f.store.id, " RAW  SKU-01 "))?.sku).toBe("raw  sku-01");
    await db.$executeRaw`UPDATE "Variant" SET "sku" = E'\nUpdated-SKU\t' WHERE "id" = ${id}::uuid`;
    expect((await findVariantBySku(f.store.id, " Updated-SKU "))?.id).toBe(id);
  });

  it("normalizes accented case consistently through PostgreSQL", async () => {
    const variant = await db.variant.create({ data: { storeId: f.store.id, productId: f.product.id, sku: " ÉTÉ-20 " } });
    expect(variant.sku).toBe("été-20");
    expect((await findVariantBySku(f.store.id, "\tÉtÉ-20 "))?.id).toBe(variant.id);
  });

  it("rejects updates that collide with another canonical SKU", async () => {
    const variant = await db.variant.create({ data: { storeId: f.store.id, productId: f.product.id, sku: "OTHER" } });
    await expect(db.variant.update({ where: { id: variant.id }, data: { sku: " TC-PL-20 " } })).rejects.toMatchObject({ code: "P2002" });
    expect((await db.variant.findUniqueOrThrow({ where: { id: variant.id } })).sku).toBe("other");
  });

  it("rejects concurrent collisions after canonicalization", async () => {
    const results = await Promise.allSettled([" Race-SKU ", "\tRACE-sku\n"].map((sku) =>
      db.variant.create({ data: { storeId: f.store.id, productId: f.product.id, sku } })
    ));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await db.variant.count({ where: { storeId: f.store.id, sku: "race-sku" } })).toBe(1);
  });

  it("reserves archived SKUs and returns archived identities from lookup", async () => {
    await db.variant.update({ where: { id: f.variant.id }, data: { archivedAt: new Date() } });
    expect((await findVariantBySku(f.store.id, " TC-PL-20 "))?.archivedAt).toBeInstanceOf(Date);
    await expect(db.variant.create({ data: { storeId: f.store.id, productId: f.product.id, sku: "TC-PL-20" } })).rejects.toMatchObject({ code: "P2002" });
  });

  it("allows matching SKUs in another store and scopes lookups", async () => {
    const other = await fixture();
    expect((await findVariantBySku(other.store.id, "TC-PL-20"))?.id).toBe(other.variant.id);
    expect((await findVariantBySku(f.store.id, "TC-PL-20"))?.id).toBe(f.variant.id);
  });

  it.each(["", " \t\r\n"])("rejects empty normalized SKU %j", async (sku) => {
    await expect(db.variant.create({ data: { storeId: f.store.id, productId: f.product.id, sku } })).rejects.toThrow(/Variant_sku_canonical/);
  });
});

describe("product snapshots and revision ownership", () => {
  it("allows incomplete drafts and multiple merchant-only revisions", async () => {
    expect(f.revision.status).toBe("DRAFT");
    expect(f.revision.title).toBeNull();
    expect(f.revision.editVersion).toBe(1);
    expect(f.revision.attributes).toEqual({});
    expect(f.revision.reviewReasons).toEqual([]);
    expect(f.revision.manualFieldPaths).toEqual([]);
    for (let i = 0; i < 2; i++) {
      await db.productRevision.create({ data: { productId: f.product.id, storeId: f.store.id } });
    }
    expect(await db.productRevision.count({ where: { productId: f.product.id } })).toBe(3);
  });

  it("prevents duplicate proposals from one import for one product", async () => {
    await expect(db.productRevision.create({ data: { productId: f.product.id, storeId: f.store.id, originImportId: f.imported.id } })).rejects.toMatchObject({ code: "P2002" });
    const product = await anotherProduct();
    await db.productRevision.create({ data: { productId: product.id, storeId: f.store.id, originImportId: f.imported.id } });
  });

  it("rejects revisions and origin imports across store boundaries", async () => {
    const other = await fixture();
    await expect(db.productRevision.create({ data: { productId: f.product.id, storeId: other.store.id } })).rejects.toMatchObject({ code: "P2003" });
    await expect(db.productRevision.create({ data: { productId: f.product.id, storeId: f.store.id, originImportId: other.imported.id } })).rejects.toMatchObject({ code: "P2003" });
  });

  it("rejects baseline and published pointers to another product in the same store", async () => {
    const product = await anotherProduct();
    const revision = await db.productRevision.create({ data: { productId: product.id, storeId: f.store.id } });
    await expect(db.product.update({ where: { id: f.product.id }, data: { publishedRevisionId: revision.id } })).rejects.toMatchObject({ code: "P2003" });
    await expect(db.productRevision.update({ where: { id: f.revision.id }, data: { basePublishedRevisionId: revision.id } })).rejects.toMatchObject({ code: "P2003" });
  });

  it("rejects baseline and published pointers to another store", async () => {
    const other = await fixture();
    await expect(db.product.update({ where: { id: f.product.id }, data: { publishedRevisionId: other.revision.id } })).rejects.toMatchObject({ code: "P2003" });
    await expect(db.productRevision.update({ where: { id: f.revision.id }, data: { basePublishedRevisionId: other.revision.id } })).rejects.toMatchObject({ code: "P2003" });
  });

  it("preserves published product/variant snapshots when a draft is created and edited", async () => {
    await db.productRevision.update({ where: { id: f.revision.id }, data: { title: "Approved pot", status: "APPROVED", approvedAt: new Date() } });
    const publishedVariant = await db.variantRevision.create({ data: snapshotData() });
    await db.product.update({ where: { id: f.product.id }, data: { publishedRevisionId: f.revision.id } });
    const before = await db.product.findUniqueOrThrow({ where: { id: f.product.id }, include: { publishedRevision: { include: { variants: true } } } });
    const draft = await db.productRevision.create({ data: { productId: f.product.id, storeId: f.store.id, basePublishedRevisionId: f.revision.id } });
    await db.variantRevision.create({ data: { ...snapshotData(), productRevisionId: draft.id, priceMinor: 3000n } });
    await db.productRevision.update({ where: { id: draft.id }, data: { title: "Edited draft", editVersion: { increment: 1 }, manualFieldPaths: ["title"] } });
    await db.variantRevision.update({ where: { productRevisionId_variantId: { productRevisionId: draft.id, variantId: f.variant.id } }, data: { priceMinor: 3500n, options: { size: "20 cm", color: "natural" }, manualFieldPaths: ["priceMinor"] } });
    expect(await db.product.findUniqueOrThrow({ where: { id: f.product.id }, include: { publishedRevision: { include: { variants: true } } } })).toEqual(before);
    expect(await db.variantRevision.findUniqueOrThrow({ where: { productRevisionId_variantId: { productRevisionId: f.revision.id, variantId: f.variant.id } } })).toEqual(publishedVariant);
    expect(await db.variant.findUniqueOrThrow({ where: { id: f.variant.id } })).toEqual(f.variant);
    expect((await db.variantRevision.findUniqueOrThrow({ where: { productRevisionId_variantId: { productRevisionId: draft.id, variantId: f.variant.id } } })).priceMinor).toBe(3500n);
  });

  it("uses only a revision's own variant set rather than all stable identities", async () => {
    await db.variant.create({ data: { productId: f.product.id, storeId: f.store.id, sku: "EXCLUDED" } });
    await db.variantRevision.create({ data: snapshotData() });
    const revision = await db.productRevision.findUniqueOrThrow({ where: { id: f.revision.id }, include: { variants: true } });
    expect(revision.variants).toHaveLength(1);
    expect(await db.variant.count({ where: { productId: f.product.id } })).toBe(2);
  });

  it("does not yet enforce approval status on the published pointer", async () => {
    const product = await db.product.update({ where: { id: f.product.id }, data: { publishedRevisionId: f.revision.id } });
    expect(product.publishedRevisionId).toBe(f.revision.id);
    expect(f.revision.status).toBe("DRAFT");
  });

  it("leaves approved-revision edit restrictions to the future publication workflow", async () => {
    await db.productRevision.update({ where: { id: f.revision.id }, data: { status: "APPROVED" } });
    expect((await db.productRevision.update({ where: { id: f.revision.id }, data: { title: "Explicit direct edit" } })).title).toBe("Explicit direct edit");
  });
});

describe("variant snapshots and money", () => {
  it("round-trips BIGINT exactly above JavaScript's safe integer range", async () => {
    const priceMinor = 9007199254740993n;
    const snapshot = await db.variantRevision.create({ data: { ...snapshotData(), priceMinor } });
    const restored = await db.variantRevision.findUniqueOrThrow({ where: { productRevisionId_variantId: { productRevisionId: snapshot.productRevisionId, variantId: snapshot.variantId } } });
    expect(restored.priceMinor).toBe(priceMinor);
    expect(JSON.stringify({ priceMinor: restored.priceMinor?.toString() })).toBe('{"priceMinor":"9007199254740993"}');
  });

  it("preserves missing prices as null and permits known currency before price resolution", async () => {
    const snapshot = await db.variantRevision.create({ data: { productRevisionId: f.revision.id, variantId: f.variant.id, productId: f.product.id, storeId: f.store.id } });
    expect(snapshot.priceMinor).toBeNull();
    expect(snapshot.currency).toBeNull();
    expect(snapshot.weightGrams).toBeNull();
    expect(snapshot.options).toEqual({});
    const updated = await db.variantRevision.update({ where: { productRevisionId_variantId: { productRevisionId: f.revision.id, variantId: f.variant.id } }, data: { currency: "EUR" } });
    expect(updated.priceMinor).toBeNull();
  });

  it("rejects negative prices and weights while allowing zero", async () => {
    await expect(db.variantRevision.create({ data: { ...snapshotData(), priceMinor: -1n } })).rejects.toThrow(/VariantRevision_priceMinor_nonnegative/);
    await expect(db.variantRevision.create({ data: { ...snapshotData(), weightGrams: -1 } })).rejects.toThrow(/VariantRevision_weightGrams_nonnegative/);
    const snapshot = await db.variantRevision.create({ data: { ...snapshotData(), priceMinor: 0n, weightGrams: 0 } });
    expect(snapshot.priceMinor).toBe(0n);
  });

  it("rejects duplicate snapshots of a variant within one revision", async () => {
    await db.variantRevision.create({ data: snapshotData() });
    await expect(db.variantRevision.create({ data: snapshotData() })).rejects.toMatchObject({ code: "P2002" });
  });

  it("rejects attaching a different product's variant even within the same store", async () => {
    const product = await anotherProduct();
    const variant = await db.variant.create({ data: { productId: product.id, storeId: f.store.id, sku: "UNRELATED" } });
    await expect(db.variantRevision.create({ data: { ...snapshotData(), variantId: variant.id } })).rejects.toMatchObject({ code: "P2003" });
    await expect(db.variantRevision.create({ data: { ...snapshotData(), variantId: variant.id, productId: product.id } })).rejects.toMatchObject({ code: "P2003" });
  });

  it("rejects cross-store variant snapshots", async () => {
    const other = await fixture();
    await expect(db.variantRevision.create({ data: { ...snapshotData(), variantId: other.variant.id } })).rejects.toMatchObject({ code: "P2003" });
    await expect(db.variantRevision.create({ data: { ...snapshotData(), storeId: other.store.id } })).rejects.toMatchObject({ code: "P2003" });
  });
});

describe("evidence links", () => {
  it("links repeated rows to the same variant and allows product-only evidence", async () => {
    await db.variantRevision.create({ data: snapshotData() });
    await db.revisionSourceRow.create({ data: evidenceData() });
    const repeated = await db.sourceRow.create({ data: { storeId: f.store.id, importId: f.imported.id, sheetIndex: 0, sheetName: "Pots", rowNumber: 3, rawCells: f.row.rawCells ?? [] } });
    await db.revisionSourceRow.create({ data: { ...evidenceData(), sourceRowId: repeated.id } });
    const draft = await db.productRevision.create({ data: { storeId: f.store.id, productId: f.product.id } });
    await db.revisionSourceRow.create({ data: { ...evidenceData(), productRevisionId: draft.id, variantId: null } });
    expect(await db.revisionSourceRow.count({ where: { productRevisionId: f.revision.id, variantId: f.variant.id } })).toBe(2);
  });

  it("rejects duplicate revision/source links even when the optional variant changes", async () => {
    await db.revisionSourceRow.create({ data: { ...evidenceData(), variantId: null } });
    await db.variantRevision.create({ data: snapshotData() });
    await expect(db.revisionSourceRow.create({ data: evidenceData() })).rejects.toMatchObject({ code: "P2002" });
  });

  it("rejects evidence from another store and mismatched evidence store fields", async () => {
    const other = await fixture();
    await expect(db.revisionSourceRow.create({ data: { ...evidenceData(), sourceRowId: other.row.id, variantId: null } })).rejects.toMatchObject({ code: "P2003" });
    await expect(db.revisionSourceRow.create({ data: { ...evidenceData(), storeId: other.store.id, variantId: null } })).rejects.toMatchObject({ code: "P2003" });
    await expect(db.revisionSourceRow.create({ data: { ...evidenceData(), productRevisionId: other.revision.id, variantId: null } })).rejects.toMatchObject({ code: "P2003" });
  });

  it("requires the referenced variant to be included in the exact revision", async () => {
    await expect(db.revisionSourceRow.create({ data: evidenceData() })).rejects.toMatchObject({ code: "P2003" });
    const product = await anotherProduct();
    const variant = await db.variant.create({ data: { productId: product.id, storeId: f.store.id, sku: "UNRELATED" } });
    await expect(db.revisionSourceRow.create({ data: { ...evidenceData(), variantId: variant.id } })).rejects.toMatchObject({ code: "P2003" });
    await db.variantRevision.create({ data: snapshotData() });
    await db.revisionSourceRow.create({ data: evidenceData() });
    const draft = await db.productRevision.create({ data: { productId: f.product.id, storeId: f.store.id } });
    await expect(db.revisionSourceRow.update({ where: { sourceRowId_productRevisionId: { sourceRowId: f.row.id, productRevisionId: f.revision.id } }, data: { productRevisionId: draft.id } })).rejects.toMatchObject({ code: "P2003" });
  });

  it("rejects removal or reparenting that would leave stale variant evidence", async () => {
    await db.variantRevision.create({ data: snapshotData() });
    await db.revisionSourceRow.create({ data: evidenceData() });
    await expect(db.variantRevision.delete({ where: { productRevisionId_variantId: { productRevisionId: f.revision.id, variantId: f.variant.id } } })).rejects.toMatchObject({ code: "P2003" });
    const product = await anotherProduct();
    await expect(db.variant.update({ where: { id: f.variant.id }, data: { productId: product.id } })).rejects.toMatchObject({ code: "P2003" });
    await expect(db.productRevision.update({ where: { id: f.revision.id }, data: { productId: product.id } })).rejects.toMatchObject({ code: "P2003" });
  });

  it("retains original rows when catalog records are deleted in dependency order", async () => {
    await db.variantRevision.create({ data: snapshotData() });
    await db.revisionSourceRow.create({ data: evidenceData() });
    await expect(db.sourceRow.delete({ where: { id: f.row.id } })).rejects.toMatchObject({ code: "P2003" });
    await db.revisionSourceRow.deleteMany({ where: { productRevisionId: f.revision.id } });
    await db.variantRevision.deleteMany({ where: { productRevisionId: f.revision.id } });
    await db.productRevision.delete({ where: { id: f.revision.id } });
    await db.variant.delete({ where: { id: f.variant.id } });
    await db.product.delete({ where: { id: f.product.id } });
    expect(await db.sourceRow.findUniqueOrThrow({ where: { id: f.row.id } })).toEqual(f.row);
  });
});

describe("SQL value constraints", () => {
  it("requires currency for a supplied price and uppercase three-letter currency syntax", async () => {
    await expect(db.variantRevision.create({ data: { ...snapshotData(), currency: null } })).rejects.toThrow(/VariantRevision_price_requires_currency/);
    await expect(db.variantRevision.create({ data: { ...snapshotData(), currency: "eur" } })).rejects.toThrow(/VariantRevision_currency_format/);
  });

  it("enforces JSON container shapes", async () => {
    await expect(db.variantRevision.create({ data: { ...snapshotData(), options: [] } })).rejects.toThrow(/VariantRevision_options_object/);
    await expect(db.productRevision.update({ where: { id: f.revision.id }, data: { attributes: [] } })).rejects.toThrow(/ProductRevision_attributes_object/);
    await expect(db.productRevision.update({ where: { id: f.revision.id }, data: { reviewReasons: {} } })).rejects.toThrow(/ProductRevision_reviewReasons_array/);
  });

  it("rejects blank supplier keys, nonpositive edit versions, and self baselines", async () => {
    await expect(db.product.create({ data: { storeId: f.store.id, supplierId: f.supplier.id, supplierProductKey: " " } })).rejects.toThrow(/Product_supplierProductKey_nonblank/);
    await expect(db.productRevision.update({ where: { id: f.revision.id }, data: { editVersion: 0 } })).rejects.toThrow(/ProductRevision_editVersion_positive/);
    await expect(db.productRevision.update({ where: { id: f.revision.id }, data: { basePublishedRevisionId: f.revision.id } })).rejects.toThrow(/ProductRevision_baseline_not_self/);
  });
});
