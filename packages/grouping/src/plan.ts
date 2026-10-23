import { canonicalJson } from "@catalogforge/cleaning/persistence";
import type { Catalog, FamilyPlan, GroupingConfig, GroupingPlan, InputRow } from "./contracts";

export const familyKey = (namespace: string, value: string) => `family:${JSON.stringify([namespace, value])}`;
const own = <T>(map: Record<string, T>, key: string) => Object.hasOwn(map, key) ? map[key] : undefined;
export function optionValue(row: InputRow, path: string): string | null {
  const [parent, field] = path.split(".");
  const map = parent === "attributes" ? row.normalized.attributes : row.normalized.dimensionsCm;
  return own(map, field!) ?? null;
}

/** Pure planner. Canonical SKU tokens and catalog facts come from the DB adapter. */
export function planGrouping(input: InputRow[], config: GroupingConfig, catalog: Catalog): GroupingPlan {
  const rows = [...input].sort((a, b) => a.sourceRowId.localeCompare(b.sourceRowId));
  const variants = new Map(catalog.variants.map(v => [v.sku, v]));
  const products = new Map(catalog.products.map(p => [p.id, p]));
  const productKeys = new Map(catalog.products.filter(p => p.key !== null).map(p => [p.key!, p]));
  const groups = new Map<string, FamilyPlan>();
  const assigned = new Map<string, InputRow[]>();
  for (const row of rows) {
    const sku = row.outcome !== "FAILED" && row.trustedSku ? row.canonicalSku : null;
    const existing = sku ? variants.get(sku) : undefined;
    const mapped = sku ? own(config.skuFamilies, sku) : undefined;
    const supplied = row.outcome !== "FAILED" && config.familyAttribute && row.trustedFamily ? own(row.normalized.attributes, config.familyAttribute) : null;
    const family = supplied || mapped || null;
    const knownProduct = existing && existing.supplierId === catalog.supplierId ? products.get(existing.productId) : undefined;
    const productKey = family ? familyKey(config.namespace, family) : knownProduct ? knownProduct.key :
      (sku && config.missingFamily === "STANDALONE" ? `sku:${JSON.stringify([config.namespace, sku])}` : null);
    const product = productKey ? productKeys.get(productKey) : knownProduct;
    const key = productKey ?? (knownProduct ? `existing:${knownProduct.id}` : `unresolved:${row.sourceRowId}`);
    let group = groups.get(key);
    if (!group) {
      group = { key, productKey, productId: product?.id ?? null, baselineId: product?.baselineId ?? null,
        baselineHash: product?.baselineHash ?? null, rowIds: [], blocked: [], issues: [], variants: [], title: null, descriptionHtml: null, attributes: {} };
      groups.set(key, group); assigned.set(key, []);
    }
    group.rowIds.push(row.sourceRowId); assigned.get(key)!.push(row);
    const block = (code: string) => { group!.blocked.push(code); };
    if (row.outcome === "FAILED") block("CLEANING_FAILED");
    if (!sku) block("IDENTITY_SKU_REVIEW");
    if (!family && !knownProduct && config.missingFamily !== "STANDALONE") block("FAMILY_REQUIRED");
    if (config.familyAttribute && !row.trustedFamily && (row.issues.some(i => i.field === `attributes.${config.familyAttribute}` && i.severity !== "WARNING") || own(row.normalized.attributes, config.familyAttribute) != null)) block("FAMILY_IDENTITY_REVIEW");
    if (family && productKeys.has(family) && productKeys.get(family)?.id !== product?.id) block("LEGACY_PRODUCT_KEY_REBASE_REQUIRED");
    if (supplied && mapped && supplied !== mapped) block("FAMILY_MAPPING_CONFLICT");
    if (existing && existing.supplierId !== catalog.supplierId) block("CROSS_SUPPLIER_SKU");
    if (existing && existing.supplierId === catalog.supplierId && (product?.id ?? null) !== existing.productId) block("SKU_PRODUCT_CONFLICT");
    if (existing?.archived || product?.archived) block("ARCHIVED_IDENTITY");
    if (product?.editedDraft) block("MERCHANT_DRAFT_REBASE_REQUIRED");
  }
  // Detect all edges before any identities are written: neither row nor batch wins.
  const skuGroups = new Map<string, Set<string>>();
  for (const [key, members] of assigned) for (const row of members) {
    if (!row.trustedSku || !row.canonicalSku || row.outcome === "FAILED") continue;
    const keys = skuGroups.get(row.canonicalSku) ?? new Set<string>(); keys.add(key); skuGroups.set(row.canonicalSku, keys);
  }
  for (const keys of skuGroups.values()) if (keys.size > 1) for (const key of keys) groups.get(key)!.blocked.push("SKU_MULTIPLE_FAMILIES");
  for (const group of groups.values()) {
    const members = assigned.get(group.key)!;
    const issue = (code: string, field: string, sourceRows = members) => group.issues.push({ code, field, sourceRowIds: sourceRows.map(r => r.sourceRowId) });
    // FAILED results never contribute content, even to a review plan.
    const usable = members.filter(r => r.outcome !== "FAILED");
    function consensus<T>(values: T[], field: string, sourceRows = usable): T | null {
      const distinct = new Map(values.map(v => [canonicalJson(v), v]));
      if (distinct.size !== 1) { issue("CONFLICTING_VALUES", field, sourceRows); return null; }
      return values[0] ?? null;
    }
    group.title = consensus(usable.map(r => r.normalized.title), "title");
    group.descriptionHtml = consensus(usable.map(r => r.normalized.descriptionHtml), "descriptionHtml");
    if (!group.title && (!group.baselineId || usable.some(r => r.mappedFields.includes("title")))) issue("TITLE_REQUIRED", "title");
    for (const attr of config.productAttributes) group.attributes[attr] = consensus(usable.map(r => own(r.normalized.attributes, attr) ?? null), `attributes.${attr}`);
    const bySku = new Map<string, InputRow[]>();
    for (const row of usable) {
      if (row.outcome === "NEEDS_REVIEW") issue("CLEANING_REVIEW", "source", [row]);
      if (!row.trustedSku || !row.canonicalSku) continue;
      const repeated = bySku.get(row.canonicalSku) ?? []; repeated.push(row); bySku.set(row.canonicalSku, repeated);
    }
    for (const [sku, repeated] of [...bySku].sort(([a], [b]) => a.localeCompare(b))) {
      const n = repeated.map(r => r.normalized);
      const options = Object.fromEntries(Object.entries(config.optionFields).sort().map(([name, path]) => [name, consensus(repeated.map(r => optionValue(r, path)), `options.${name}`, repeated)]));
      if (Object.values(options).some(v => v === null)) issue("OPTION_REQUIRED", "options", repeated);
      const currency = consensus(n.map(r => r.currency), "currency", repeated);
      const price = consensus(n.map(r => r.priceMinor), "priceMinor", repeated);
      if ((price === null || currency === null) && (!variants.has(sku) || repeated.some(r => r.mappedFields.includes("price") || r.mappedFields.includes("currency")))) issue("PRICE_REQUIRED", "priceMinor", repeated);
      // Quantity is not inventory and is never summed across repeats.
      consensus(n.map(r => r.quantity), "quantity", repeated);
      group.variants.push({ sku, rowIds: repeated.map(r => r.sourceRowId), options, priceMinor: currency ? price : null,
        currency, weightGrams: consensus(n.map(r => r.weightGrams), "weightGrams", repeated) });
    }
    if (new Set(group.variants.map(v => v.currency).filter(Boolean)).size > 1) issue("MIXED_CURRENCIES", "currency");
    const combinations = new Map<string, typeof group.variants>();
    if (Object.keys(config.optionFields).length) {
      for (const variant of group.variants) {
        const combination = canonicalJson(variant.options);
        const matching = combinations.get(combination) ?? [];
        matching.push(variant); combinations.set(combination, matching);
      }
      const byRow = new Map(members.map(r => [r.sourceRowId, r]));
      for (const matching of combinations.values()) if (matching.length > 1)
        issue("DUPLICATE_OPTIONS", "options", matching.flatMap(v => v.rowIds.map(id => byRow.get(id)!)));
    }
    group.blocked = [...new Set(group.blocked)].sort();
  }
  return { groups: [...groups.values()].sort((a, b) => a.key.localeCompare(b.key)) };
}
