import { expect, it } from "vitest";
import { planGrouping, familyKey } from "./plan";
import { exampleGroupingRows, exampleGroupingConfig as config } from "./example";
import { labeledConfig, labeledRows, groupingLabels } from "./labeled-fixture";
import { measureAccuracy } from "./accuracy";
import type { Catalog } from "./contracts";
const empty: Catalog = { supplierId: "supplier", products: [], variants: [] };
const rows = () => structuredClone(exampleGroupingRows);
it("plans the three-row fixture as one family and two variants with a missing price", () => {
  const plan = planGrouping(rows(), config, empty);
  expect(plan.groups).toHaveLength(1);
  expect(plan.groups[0]).toMatchObject({ blocked: [], rowIds: expect.arrayContaining(rows().map(r => r.sourceRowId)),
    variants: [expect.objectContaining({ sku: "tc-pl-20", priceMinor: "2499" }), expect.objectContaining({ sku: "tc-pl-30", priceMinor: null })] });
  expect(plan.groups[0]?.variants[0]?.rowIds).toHaveLength(2);
  expect(plan.groups[0]?.issues.map(i => i.code)).toContain("PRICE_REQUIRED");
});
it("is deterministic across row order and leaves input untouched", () => {
  const input = rows(), before = structuredClone(input);
  expect(planGrouping(input, config, empty)).toEqual(planGrouping([...input].reverse(), config, empty));
  expect(input).toEqual(before);
});
it("blocks every family involved in a shared-SKU conflict before writes", () => {
  const input = rows(); input[2]!.normalized.attributes.familyId = "OTHER";
  expect(planGrouping(input, config, empty).groups.every(g => g.blocked.includes("SKU_MULTIPLE_FAMILIES"))).toBe(true);
});
it("keeps conflicting repeated prices unresolved and never sums quantity", () => {
  const input = rows(); input[2]!.normalized.priceMinor = "3500"; input[2]!.normalized.quantity = 24;
  const group = planGrouping(input, config, empty).groups[0]!;
  expect(group.variants[0]?.priceMinor).toBeNull();
  expect(group.issues).toEqual(expect.arrayContaining([expect.objectContaining({ field: "quantity" }), expect.objectContaining({ field: "priceMinor" })]));
});
it("does not infer a family from identical titles", () => {
  const input = rows(); input.forEach(r => { r.normalized.attributes.familyId = null; r.trustedFamily = false; });
  expect(planGrouping(input, config, empty).groups.every(g => g.blocked.includes("FAMILY_REQUIRED"))).toBe(true);
});
it("supports only explicit standalone and SKU mapping policies", () => {
  const input = rows(); input.forEach(r => { r.normalized.attributes.familyId = null; r.trustedFamily = false; });
  expect(planGrouping(input, { ...config, missingFamily: "STANDALONE" }, empty).groups).toHaveLength(2);
  expect(planGrouping(input, { ...config, skuFamilies: { "tc-pl-20": "TC-POT", "tc-pl-30": "TC-POT" } }, empty).groups).toHaveLength(1);
});
it("does not consume FAILED cleaning business values", () => {
  const input = rows(); input[0]!.outcome = "FAILED"; input[0]!.trustedFamily = false; input[0]!.trustedSku = false;
  const group = planGrouping(input.slice(0, 1), config, empty).groups[0]!;
  expect(group.variants).toEqual([]); expect(group.title).toBeNull(); expect(group.blocked).toContain("CLEANING_FAILED");
});
it("rejects cross-supplier collisions and SKU reassignment", () => {
  const catalog: Catalog = { ...empty, variants: [{ sku: "tc-pl-20", productId: "other", supplierId: "another", archived: false }] };
  expect(planGrouping(rows(), config, catalog).groups[0]?.blocked).toContain("CROSS_SUPPLIER_SKU");
  catalog.variants[0]!.supplierId = "supplier";
  expect(planGrouping(rows(), config, catalog).groups[0]?.blocked).toContain("SKU_PRODUCT_CONFLICT");
});
it("reuses known SKU associations with null supplier keys even under standalone policy", () => {
  const input = rows().filter(r => r.canonicalSku === "tc-pl-20");
  input.forEach(r => { r.normalized.attributes.familyId = null; r.trustedFamily = false; });
  const catalog: Catalog = { supplierId: "supplier", products: [{ id: "known", key: null, archived: false, baselineId: null, baselineHash: null, editedDraft: false }],
    variants: [{ sku: "tc-pl-20", productId: "known", supplierId: "supplier", archived: false }] };
  expect(planGrouping(input, { ...config, missingFamily: "STANDALONE" }, catalog).groups[0]).toMatchObject({ productId: "known", productKey: null, blocked: [] });
});
it.each(["archived", "editedDraft"] as const)("blocks %s product", field => {
  const catalog: Catalog = { ...empty, products: [{ id: "p", key: familyKey(config.namespace, "TC-POT"), archived: false, editedDraft: false, baselineId: null, baselineHash: null, [field]: true }] };
  expect(planGrouping(rows(), config, catalog).groups[0]?.blocked.length).toBeGreaterThan(0);
});
it("flags duplicate option tuples and conflicting product descriptions", () => {
  const input = rows(); input[1]!.normalized.dimensionsCm.diameter = "20"; input[1]!.normalized.descriptionHtml = "Not frost-proof: indoors only.";
  const group = planGrouping(input, config, empty).groups[0]!;
  expect(group.descriptionHtml).toBeNull(); expect(group.issues.map(i => i.code)).toContain("DUPLICATE_OPTIONS");
});
it("records one bounded duplicate-options issue for a large collision set", () => {
  const input = Array.from({ length: 1000 }, (_, i) => ({ ...structuredClone(exampleGroupingRows[0]!), sourceRowId: `row-${i}`, canonicalSku: `sku-${i}` }));
  const group = planGrouping(input, config, empty).groups[0]!;
  const issues = group.issues.filter(i => i.code === "DUPLICATE_OPTIONS");
  expect(issues).toHaveLength(1); expect(issues[0]?.sourceRowIds).toHaveLength(1000);
});
it("measures the hand-labeled fixture without hiding abstentions", () => {
  const score = measureAccuracy(planGrouping(labeledRows, labeledConfig, empty), groupingLabels);
  expect(score).toEqual({ rows: 8, falseMerges: 0, falseSplits: 0, truePairs: 3, expectedPairs: 3, pairPrecision: 1, pairRecall: 1,
    variantAssigned: 5, variantAssignmentAccuracy: 1, identityCoverage: 0.625, automaticCoverage: 0.5, reviewRate: 0.5 });
  // Ensure the evaluator catches deliberately incorrect family decisions too.
  const wrong = planGrouping(labeledRows, labeledConfig, empty); wrong.groups.forEach(g => { g.key = "same"; g.blocked = []; g.issues = []; });
  expect(measureAccuracy(wrong, groupingLabels).falseMerges).toBeGreaterThan(0);
  const split = planGrouping(labeledRows, labeledConfig, empty);
  split.groups = split.groups.flatMap(g => g.variants.map(v => ({ ...g, key: v.sku, variants: [v] })));
  expect(measureAccuracy(split, groupingLabels).falseSplits).toBeGreaterThan(0);
});
it.each([100, 1000, 10000])("plans %i shuffled rows independently of family batch boundaries", count => {
  const input = Array.from({ length: count }, (_, i) => {
    const row = structuredClone(exampleGroupingRows[0]!); row.id = `clean-${i}`; row.sourceRowId = `row-${i}`;
    row.canonicalSku = `sku-${i}`; row.normalized.attributes.familyId = `family-${Math.floor(i / 10)}`; return row;
  });
  const plan = planGrouping(input, { ...config, optionFields: {} }, empty);
  expect(plan.groups).toHaveLength(count / 10);
  expect(plan.groups.reduce((n, g) => n + g.variants.length, 0)).toBe(count);
  expect(plan).toEqual(planGrouping(input.reverse(), { ...config, optionFields: {} }, empty));
});
