import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { getDb, disconnectDatabase } from "@catalogforge/db";
import { cleanSourceRow } from "@catalogforge/cleaning/persistence";
import { groupImport } from "@catalogforge/grouping/persistence";
import { exampleCleaningConfig, exampleGroupingConfig, exampleGroupingSources } from "@catalogforge/grouping/example";
import { familyKey } from "@catalogforge/grouping";
import { labeledSpecs, labeledConfig } from "@catalogforge/grouping/labeled-fixture";
const db = getDb();
let storeId: string, supplierId: string;
const stores: string[] = [];
beforeEach(async () => {
  storeId = (await db.store.create({ data: { name: "Grouping integration" } })).id; stores.push(storeId);
  supplierId = (await db.supplier.create({ data: { storeId, name: "Grouping supplier" } })).id;
});
afterEach(async () => {
  const where = { storeId: { in: stores } };
  await db.groupingRowResult.deleteMany({ where });
  await db.revisionSourceRow.deleteMany({ where });
  await db.variantRevision.deleteMany({ where });
  await db.product.updateMany({ where, data: { publishedRevisionId: null } });
  await db.productRevision.updateMany({ where, data: { basePublishedRevisionId: null } });
  await db.productRevision.deleteMany({ where });
  await db.variant.deleteMany({ where }); await db.product.deleteMany({ where });
  await db.groupingRun.deleteMany({ where }); await db.rowCleaningResult.deleteMany({ where });
  await db.sourceRow.deleteMany({ where }); await db.import.deleteMany({ where });
  await db.supplier.deleteMany({ where }); await db.store.deleteMany({ where: { id: { in: stores } } }); stores.length = 0;
});
afterAll(disconnectDatabase);
type Spec = { sku?: string | number | null; family?: string | null; price?: string | null; diameter?: string };
async function seed(specs?: Spec[]) {
  const imported = await db.import.create({ data: { storeId, supplierId, originalFilename: "grouping.csv", storageKey: crypto.randomUUID(), fileSha256: "a".repeat(64),
    idempotencyKey: crypto.randomUUID(), parserVersion: "spreadsheet-v1", status: "COMPLETED", totalRows: specs?.length ?? 3 } });
  const selection = [];
  const sources = [];
  const inputs = specs ? specs.map((s, i) => ({ rowNumber: i + 2, source: structuredClone(exampleGroupingSources[0]!.source), spec: s })) : exampleGroupingSources.map(s => ({ ...s, spec: {} as Spec }));
  for (const input of inputs) {
    const cells = structuredClone(input.source.rawCells), spec = input.spec;
    if ("sku" in spec) cells[0]!.value = spec.sku ?? null;
    if ("family" in spec) cells[9]!.value = spec.family ?? null;
    if ("price" in spec) cells[3]!.value = spec.price ?? null;
    if ("diameter" in spec) cells[6]!.value = spec.diameter!;
    const source = await db.sourceRow.create({ data: { storeId, importId: imported.id, sheetIndex: 0, sheetName: "Pots", rowNumber: input.rowNumber, rawCells: cells } });
    sources.push(source);
    selection.push(await cleanSourceRow(storeId, source.id, { ...exampleCleaningConfig, storeId, supplierId }));
  }
  return { imported, sources, selection, ids: selection.map(s => s.id) };
}
const run = (s: Awaited<ReturnType<typeof seed>>, config = exampleGroupingConfig, options: Parameters<typeof groupImport>[4] = {}) => groupImport(storeId, s.imported.id, s.ids, config, options);
async function published() {
  const s = await seed(); const result = await run(s);
  const revision = await db.productRevision.findFirstOrThrow({ where: { originImportId: s.imported.id } });
  await db.productRevision.update({ where: { id: revision.id }, data: { status: "APPROVED", approvedAt: new Date() } });
  const product = await db.product.update({ where: { id: revision.productId }, data: { publishedRevisionId: revision.id } });
  return { ...s, result, revision: await db.productRevision.findUniqueOrThrow({ where: { id: revision.id }, include: { variants: true, sourceRows: true } }), product };
}
it("persists exactly one product, two variants, three source links and one unpublished review proposal", async () => {
  const s = await seed(); const result = await run(s);
  expect(result.status).toBe("COMPLETED"); expect(result.rows).toHaveLength(3);
  expect(result.rows.every(r => r.outcome === "NEEDS_REVIEW")).toBe(true);
  expect(await db.product.count({ where: { storeId } })).toBe(1); expect(await db.variant.count({ where: { storeId } })).toBe(2);
  const proposal = await db.productRevision.findFirstOrThrow({ where: { originImportId: s.imported.id }, include: { variants: true, sourceRows: true, product: true } });
  expect(proposal.status).toBe("NEEDS_REVIEW"); expect(proposal.approvedAt).toBeNull(); expect(proposal.product.publishedRevisionId).toBeNull();
  expect(proposal.variants.map(v => v.priceMinor).sort()).toEqual([2499n, null].sort());
  expect(proposal.sourceRows).toHaveLength(3);
  expect(new Set(proposal.sourceRows.map(r => r.cleaningResultId))).toEqual(new Set(s.ids));
  expect(await db.sourceRow.findMany({ where: { importId: s.imported.id }, orderBy: { rowNumber: "asc" } })).toEqual(s.sources);
});
it("reuses a frozen run under concurrent calls, reversed selections and retries without duplicate effects", async () => {
  const s = await seed(); const results = await Promise.all(Array.from({ length: 5 }, () => run(s)));
  expect(new Set(results.map(r => r.id)).size).toBe(1);
  expect(await run({ ...s, ids: [...s.ids].reverse() })).toEqual(results[0]);
  expect(await db.productRevision.count({ where: { storeId } })).toBe(1);
  expect(await db.variantRevision.count({ where: { storeId } })).toBe(2);
  expect(await db.revisionSourceRow.count({ where: { storeId } })).toBe(3);
});
it("detects full-import conflicting SKU families without leaving any catalog identities", async () => {
  const s = await seed([{ family: "A" }, { family: "B" }]); const result = await run(s);
  expect(result.rows.every(r => r.outcome === "NEEDS_REVIEW")).toBe(true);
  expect(await db.product.count({ where: { storeId } })).toBe(0);
  expect(await db.variant.count({ where: { storeId } })).toBe(0);
});
it("keeps conflicting repeated prices null instead of choosing an occurrence", async () => {
  const s = await seed([{ price: "24,99 €" }, { price: "35,00 €" }]); await run(s);
  const v = await db.variantRevision.findFirstOrThrow({ where: { storeId } }); expect(v.priceMinor).toBeNull();
  expect(await db.revisionSourceRow.count({ where: { storeId } })).toBe(2);
});
it("allows NEEDS_REVIEW content with reliable identity but refuses numeric/missing identities", async () => {
  const good = await seed([{ price: null }]); await run(good);
  expect(await db.variant.count({ where: { storeId } })).toBe(1);
  const bad = await seed([{ sku: 123, family: "BAD" }, { sku: null, family: "BAD" }]); const result = await run(bad);
  expect(result.rows.every(r => r.productRevisionId === null)).toBe(true);
  expect(await db.product.count({ where: { storeId } })).toBe(1);
});
it("does not use business values of FAILED results", async () => {
  const s = await seed([{ family: "FAILED" }]);
  await db.rowCleaningResult.update({ where: { id: s.ids[0]! }, data: { outcome: "FAILED" } });
  const result = await run(s); expect(result.rows[0]?.outcome).toBe("FAILED");
  expect(await db.product.count({ where: { storeId } })).toBe(0);
});
it("refuses incomplete selections, wrong stores and another import's cleaning results", async () => {
  const s = await seed(); await expect(run({ ...s, ids: s.ids.slice(0, 2) })).rejects.toThrow("COMPLETE_IMPORT_SELECTION_REQUIRED");
  const other = await seed(); await expect(run({ ...s, ids: other.ids })).rejects.toThrow("INVALID_SELECTION_SCOPE");
  const st = await db.store.create({ data: { name: "Other" } }); stores.push(st.id);
  await expect(groupImport(st.id, s.imported.id, s.ids, exampleGroupingConfig)).rejects.toThrow();
});
it("rejects changed configuration, changed selection and modified cleaning content on retry", async () => {
  const s = await seed(); await run(s);
  await expect(run(s, { ...exampleGroupingConfig, namespace: "other" })).rejects.toThrow("FROZEN_RUN_REQUIRES_NEW_IMPORT");
  const old = s.selection[0]!;
  const alternate = await db.rowCleaningResult.create({ data: { sourceRowId: old.sourceRowId, storeId, cleanerVersion: "test-new-version", configHash: old.configHash,
    configSnapshot: exampleCleaningConfig, normalized: {}, evidence: {}, issues: [], outcome: "FAILED" } });
  await expect(run({ ...s, ids: [alternate.id, ...s.ids.slice(1)] })).rejects.toThrow();
  await db.rowCleaningResult.update({ where: { id: old.id }, data: { outcome: "FAILED" } });
  await expect(run(s)).rejects.toThrow("FROZEN_RUN_REQUIRES_NEW_IMPORT");
});
it("recovers an interruption after family commit without duplicating that family", async () => {
  const s = await seed([{ sku: "A", family: "A" }, { sku: "B", family: "B" }]);
  await expect(run(s, exampleGroupingConfig, { afterFamily: async n => { if (n === 1) throw Error("interrupted"); } })).rejects.toThrow("interrupted");
  expect((await db.groupingRun.findUniqueOrThrow({ where: { importId: s.imported.id } })).status).toBe("PENDING");
  expect(await db.productRevision.count({ where: { storeId } })).toBe(1);
  const result = await run(s); expect(result.rows.every(r => r.outcome !== "PENDING")).toBe(true);
  expect(await db.product.count({ where: { storeId } })).toBe(2); expect(await db.productRevision.count({ where: { storeId } })).toBe(2);
});
it("rolls back all family writes on a failure before commit and safely retries", async () => {
  const s = await seed();
  await expect(run(s, exampleGroupingConfig, { beforeFamilyCommit: async () => { throw Error("transaction interrupted"); } })).rejects.toThrow("transaction interrupted");
  expect(await db.product.count({ where: { storeId } })).toBe(0);
  expect(await db.variant.count({ where: { storeId } })).toBe(0);
  expect(await db.productRevision.count({ where: { storeId } })).toBe(0);
  expect(await db.groupingRowResult.count({ where: { storeId, outcome: "PENDING" } })).toBe(3);
  const recovered = await run(s);
  expect(recovered.status).toBe("COMPLETED");
  expect(await db.productRevision.count({ where: { storeId } })).toBe(1);
});
it("reuses identities across concurrent separate imports and keeps their proposals separate", async () => {
  const a = await seed(), b = await seed(); await Promise.all([run(a), run(b)]);
  expect(await db.product.count({ where: { storeId } })).toBe(1); expect(await db.variant.count({ where: { storeId } })).toBe(2);
  expect(await db.productRevision.count({ where: { storeId } })).toBe(2);
});
it("preserves published snapshots, manual fields, absent variants and inherited evidence", async () => {
  const old = await published(); const v = old.revision.variants.find(v => v.priceMinor !== null)!;
  await db.productRevision.update({ where: { id: old.revision.id }, data: { title: "Merchant title", manualFieldPaths: ["title"] } });
  await db.variantRevision.update({ where: { productRevisionId_variantId: { productRevisionId: old.revision.id, variantId: v.variantId } }, data: { priceMinor: 999n, manualFieldPaths: ["priceMinor"] } });
  const before = await db.productRevision.findUniqueOrThrow({ where: { id: old.revision.id }, include: { variants: true, sourceRows: true } });
  const s = await seed([{ price: "29,99 €" }]); await run(s);
  const next = await db.productRevision.findFirstOrThrow({ where: { originImportId: s.imported.id }, include: { variants: true, sourceRows: true } });
  expect(next.title).toBe("Merchant title"); expect(next.manualFieldPaths).toEqual(["title"]); expect(next.variants).toHaveLength(2);
  expect(next.variants.find(x => x.variantId === v.variantId)?.priceMinor).toBe(999n);
  expect(next.sourceRows).toHaveLength(4);
  expect(await db.productRevision.findUniqueOrThrow({ where: { id: old.revision.id }, include: { variants: true, sourceRows: true } })).toEqual(before);
  expect((await db.product.findUniqueOrThrow({ where: { id: old.product.id } })).publishedRevisionId).toBe(old.revision.id);
});
it("records explicit merge/rebase handling for an edited merchant draft", async () => {
  const first = await seed(); await run(first);
  const draft = await db.productRevision.findFirstOrThrow({ where: { originImportId: first.imported.id } });
  const edited = await db.productRevision.update({ where: { id: draft.id }, data: { title: "Merchant draft", editVersion: 2, manualFieldPaths: ["title"] } });
  const s = await seed(); const result = await run(s);
  expect(result.rows.every(r => r.productRevisionId === null && r.outcome === "NEEDS_REVIEW")).toBe(true);
  expect(await db.productRevision.findUnique({ where: { id: draft.id } })).toEqual(edited);
});
it("does not omit existing unpublished variants by arbitrarily selecting an older draft", async () => {
  const first = await seed(); await run(first);
  const partial = await seed([{ price: "29,99 €" }]); const result = await run(partial);
  expect(result.rows[0]?.issues).toEqual([expect.objectContaining({ code: "UNPUBLISHED_VARIANT_BASELINE_REQUIRED" })]);
  expect(await db.productRevision.count({ where: { storeId } })).toBe(1);
  expect(await db.variant.count({ where: { storeId } })).toBe(2);
});
it("detects a published baseline changed after planning", async () => {
  const old = await published(); const s = await seed(); let changed = false;
  const result = await run(s, exampleGroupingConfig, { beforeFamily: async () => {
    if (changed) return; changed = true;
    const newer = await db.productRevision.create({ data: { storeId, productId: old.product.id, title: "New approved baseline", status: "APPROVED" } });
    await db.product.update({ where: { id: old.product.id }, data: { publishedRevisionId: newer.id } });
  } });
  expect(result.rows[0]?.issues).toEqual([expect.objectContaining({ code: "STALE_BASELINE" })]);
  expect(await db.productRevision.count({ where: { originImportId: s.imported.id } })).toBe(0);
});
it.each(["product", "variant"] as const)("does not recreate archived %s identities", async kind => {
  const s = await seed(); await run(s);
  if (kind === "product") await db.product.updateMany({ where: { storeId }, data: { archivedAt: new Date() } });
  else await db.variant.updateMany({ where: { storeId }, data: { archivedAt: new Date() } });
  const again = await seed(); const result = await run(again);
  expect(result.rows.every(r => r.productRevisionId === null)).toBe(true);
  expect(await db.product.count({ where: { storeId } })).toBe(1); expect(await db.variant.count({ where: { storeId } })).toBe(2);
});
it("rejects cross-supplier reuse and existing SKU reassignment without orphan products", async () => {
  const first = await seed(); await run(first);
  const wrongFamily = await seed([{ family: "WRONG" }]); await run(wrongFamily);
  supplierId = (await db.supplier.create({ data: { storeId, name: "Another supplier" } })).id;
  const other = await seed(); const result = await run(other);
  expect(result.rows.every(r => r.outcome === "NEEDS_REVIEW" && !r.productRevisionId)).toBe(true);
  expect(await db.product.count({ where: { storeId } })).toBe(1);
});
it("requires explicit adoption of legacy supplier keys, including archived products without SKUs", async () => {
  await db.product.create({ data: { storeId, supplierId, supplierProductKey: "TC-POT", archivedAt: new Date() } });
  const s = await seed([{ sku: "NEW-SKU" }]); const result = await run(s);
  expect(result.rows[0]?.issues).toEqual([expect.objectContaining({ code: "LEGACY_PRODUCT_KEY_REBASE_REQUIRED" })]);
  expect(await db.product.count({ where: { storeId } })).toBe(1);
  expect(await db.variant.count({ where: { storeId } })).toBe(0);
});
it("enforces frozen inputs, selection ownership, evidence FKs and completion totals in PostgreSQL", async () => {
  const s = await seed();
  await expect(run(s, exampleGroupingConfig, { afterFamily: async () => { throw Error("stop before completion"); } })).rejects.toThrow();
  const r = await db.groupingRun.findUniqueOrThrow({ where: { importId: s.imported.id } });
  await expect(db.groupingRun.update({ where: { id: r.id }, data: { configHash: "b".repeat(64) } })).rejects.toThrow(/immutable/);
  const row = await db.groupingRowResult.findFirstOrThrow({ where: { runId: r.id } });
  await expect(db.groupingRowResult.update({ where: { runId_sourceRowId: { runId: r.id, sourceRowId: row.sourceRowId } }, data: { cleaningResultId: s.ids.find(id => id !== row.cleaningResultId)! } })).rejects.toThrow();
  const link = await db.revisionSourceRow.findFirstOrThrow({ where: { storeId } });
  await expect(db.revisionSourceRow.update({ where: { sourceRowId_productRevisionId: { sourceRowId: link.sourceRowId, productRevisionId: link.productRevisionId } }, data: { cleaningResultId: s.ids.find(id => id !== link.cleaningResultId)! } })).rejects.toThrow(/Foreign key constraint/);
  // Normal child deletion remains possible, but incomplete work cannot complete.
  await db.groupingRowResult.delete({ where: { runId_sourceRowId: { runId: r.id, sourceRowId: row.sourceRowId } } });
  await expect(db.groupingRun.update({ where: { id: r.id }, data: { status: "COMPLETED", finishedAt: new Date() } })).rejects.toThrow(/exact terminal row/);
});
it("creates a stable empty run for an empty completed import", async () => {
  const s = await seed([]); const result = await run(s); expect(result.status).toBe("COMPLETED"); expect(result.rows).toEqual([]);
});
it("keeps mapped-but-missing reimport prices null and leaves unowned published data unchanged", async () => {
  const old = await published(); const s = await seed([{ price: null }]); await run(s);
  const next = await db.productRevision.findFirstOrThrow({ where: { originImportId: s.imported.id }, include: { variants: true } });
  const sku = await db.variant.findUniqueOrThrow({ where: { storeId_sku: { storeId, sku: "tc-pl-20" } } });
  expect(next.variants.find(v => v.variantId === sku.id)?.priceMinor).toBeNull();
  expect(await db.productRevision.findUniqueOrThrow({ where: { id: old.revision.id }, include: { variants: true, sourceRows: true } })).toEqual(old.revision);
});
it("carries forward unmapped fields rather than treating them as supplied null updates", async () => {
  const old = await published(); const s = await seed([{ price: "29,99 €" }]);
  const mapping = { ...structuredClone(exampleCleaningConfig), storeId, supplierId, requiredFields: [] };
  for (const field of ["title", "description", "price", "weight"]) delete mapping.columns[field];
  const selected = await cleanSourceRow(storeId, s.sources[0]!.id, mapping);
  await run({ ...s, ids: [selected.id] });
  const next = await db.productRevision.findFirstOrThrow({ where: { originImportId: s.imported.id }, include: { variants: true } });
  expect(next.title).toBe(old.revision.title); expect(next.descriptionHtml).toBe(old.revision.descriptionHtml);
  const before = old.revision.variants.find(v => v.priceMinor === 2499n)!;
  const after = next.variants.find(v => v.variantId === before.variantId)!;
  expect(after.priceMinor).toBe(before.priceMinor); expect(after.weightGrams).toBe(before.weightGrams);
  expect(next.status).toBe("DRAFT");
});
it("honors PostgreSQL normalization in mapping keys and guards conflicting canonical mappings", async () => {
  const s = await seed([{ family: null }]);
  const result = await run(s, { ...exampleGroupingConfig, skuFamilies: { " \tTC-PL-20\n": "Mapped" } });
  expect(result.rows[0]?.productRevisionId).not.toBeNull();
  expect((await db.product.findFirstOrThrow({ where: { storeId } })).supplierProductKey).toBe(familyKey(exampleGroupingConfig.namespace, "Mapped"));
  const again = await seed([{ family: null }]);
  await expect(run(again, { ...exampleGroupingConfig, skuFamilies: { "TC-PL-20": "One", "tc-pl-20": "Two" } })).rejects.toThrow("CONFLICTING_SKU_MAPPING");
});
it("matches labeled fixture coverage in the actual database without false automatic family merges", async () => {
  const s = await seed(labeledSpecs); const result = await run(s, labeledConfig);
  expect(result.rows.filter(r => r.outcome === "APPLIED")).toHaveLength(4);
  expect(result.rows.filter(r => r.outcome === "NEEDS_REVIEW")).toHaveLength(4);
  expect(await db.product.count({ where: { storeId } })).toBe(3);
  expect(await db.variant.count({ where: { storeId } })).toBe(4);
  expect(await db.revisionSourceRow.count({ where: { storeId } })).toBe(5);
  const links = new Map(result.rows.map(r => [r.sourceRowId, r]));
  const a = s.sources.slice(0, 3).map(r => links.get(r.id)!.productRevisionId);
  expect(new Set(a).size).toBe(1);
  expect(a[0]).not.toBe(links.get(s.sources[3]!.id)!.productRevisionId);
  for (const index of [4, 5, 6]) expect(links.get(s.sources[index]!.id)?.productRevisionId).toBeNull();
});
it("rejects cross-import selections and cross-run proposal references in PostgreSQL", async () => {
  const a = await seed(), b = await seed(); const first = await run(a), second = await run(b);
  const foreign = b.selection[0]!;
  await expect(db.groupingRowResult.create({ data: { runId: first.id, importId: a.imported.id, storeId,
    sourceRowId: foreign.sourceRowId, cleaningResultId: foreign.id, groupKey: "wrong-import" } })).rejects.toThrow(/Foreign key constraint/);
  const revision = await db.productRevision.findFirstOrThrow({ where: { groupingRunId: second.id } });
  const source = await db.sourceRow.create({ data: { storeId, importId: a.imported.id, sheetIndex: 0, sheetName: "Test", rowNumber: 500, rawCells: [] } });
  const cleaned = await cleanSourceRow(storeId, source.id, { ...exampleCleaningConfig, storeId, supplierId });
  await expect(db.groupingRowResult.create({ data: { runId: first.id, importId: a.imported.id, storeId,
    sourceRowId: source.id, cleaningResultId: cleaned.id, groupKey: "wrong-run", productRevisionId: revision.id } })).rejects.toThrow(/Foreign key constraint/);
});
