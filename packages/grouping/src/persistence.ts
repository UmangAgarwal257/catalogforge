import { createHash } from "node:crypto";
import { getDb, type Prisma } from "@catalogforge/db";
import { canonicalJson, configIdentity } from "@catalogforge/cleaning/persistence";
import { cleaningOutputSchema, cleaningConfigSchema } from "@catalogforge/cleaning/contracts";
import { z } from "zod";
import { GROUPER_VERSION, groupingConfigSchema, GroupingConflict, type GroupingConfig, type InputRow, type Catalog, type FamilyPlan } from "./contracts";
import { familyKey, planGrouping } from "./plan";

const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v));
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(json(value))).digest("hex");
// Sequential relation reads avoid Prisma scheduling multiple queries on the
// same pg transaction connection. Ordering is part of the baseline hash.
async function loadBaseline(tx: Prisma.TransactionClient, id: string) {
  const revision = await tx.productRevision.findUniqueOrThrow({ where: { id } });
  const variants = await tx.variantRevision.findMany({ where: { productRevisionId: id }, orderBy: { variantId: "asc" } });
  const sourceRows = await tx.revisionSourceRow.findMany({ where: { productRevisionId: id }, orderBy: { sourceRowId: "asc" } });
  return { ...revision, variants, sourceRows };
}
async function editedDrafts(tx: Prisma.TransactionClient, productId: string, publishedId: string | null) {
  const drafts = await tx.productRevision.findMany({ where: { productId, id: { not: publishedId ?? "00000000-0000-0000-0000-000000000000" }, status: { not: "REJECTED" } } });
  const variantEdits = await tx.variantRevision.count({ where: { productRevisionId: { in: drafts.map(d => d.id) }, manualFieldPaths: { isEmpty: false } } });
  return { drafts, edited: Boolean(variantEdits || drafts.some(r => r.editVersion > 1 || r.manualFieldPaths.length)) };
}
const manual = (paths: string[], field: string) => paths.some(p => p === field || p === `/${field}` || p.startsWith(`${field}.`) || p.startsWith(`/${field}/`));
const planSchema = z.object({ groups: z.array(z.object({
  key: z.string(), productKey: z.string().nullable(), productId: z.string().nullable(), baselineId: z.string().nullable(), baselineHash: z.string().nullable(),
  rowIds: z.array(z.string()), blocked: z.array(z.string()), issues: z.array(z.object({ code: z.string(), field: z.string(), sourceRowIds: z.array(z.string()) })),
  title: z.string().nullable(), descriptionHtml: z.string().nullable(), attributes: z.record(z.string(), z.string().nullable()),
  variants: z.array(z.object({ sku: z.string(), rowIds: z.array(z.string()), options: z.record(z.string(), z.string().nullable()), priceMinor: z.string().nullable(), currency: z.string().nullable(), weightGrams: z.number().nullable() }))
})) });

async function canonicalize(values: string[]): Promise<Map<string, string>> {
  const output = new Map<string, string>();
  for (let start = 0; start < values.length; start += 250) {
    const batch = values.slice(start, start + 250);
    const rows = await getDb().$queryRaw<{ raw: string; sku: string }[]>`
      SELECT value AS raw, public.catalogforge_canonical_sku(value) AS sku FROM jsonb_array_elements_text(${JSON.stringify(batch)}::jsonb)`;
    rows.forEach(row => output.set(row.raw, row.sku));
  }
  return output;
}

async function prepare(storeId: string, importId: string, ids: string[], configInput: unknown) {
  z.uuid().parse(storeId); z.uuid().parse(importId);
  if (ids.length > 10000 || new Set(ids).size !== ids.length) throw new GroupingConflict("INVALID_SELECTION");
  ids.forEach(id => z.uuid().parse(id));
  const imported = await getDb().import.findFirstOrThrow({ where: { id: importId, storeId } });
  const sourceCount = await getDb().sourceRow.count({ where: { importId, storeId } });
  if (imported.status !== "COMPLETED" || imported.totalRows !== sourceCount || sourceCount !== ids.length) throw new GroupingConflict("COMPLETE_IMPORT_SELECTION_REQUIRED");
  const config = groupingConfigSchema.parse(configInput);
  const mappings = await canonicalize(Object.keys(config.skuFamilies));
  const mapped: Record<string, string> = {};
  for (const [raw, family] of Object.entries(config.skuFamilies)) {
    const sku = mappings.get(raw)!;
    if (!sku || (Object.hasOwn(mapped, sku) && mapped[sku] !== family)) throw new GroupingConflict("CONFLICTING_SKU_MAPPING");
    Object.defineProperty(mapped, sku, { value: family, enumerable: true, configurable: true, writable: true });
  }
  config.skuFamilies = mapped;
  const rows: InputRow[] = [];
  const fingerprints: { sourceRowId: string; resultId: string; hash: string }[] = [];
  const sourceIds = new Set<string>();
  for (let start = 0; start < ids.length; start += 250) {
    const selected = await getDb().rowCleaningResult.findMany({ where: { id: { in: ids.slice(start, start + 250) }, storeId }, include: { sourceRow: true } });
    if (selected.length !== ids.slice(start, start + 250).length) throw new GroupingConflict("INVALID_SELECTION_SCOPE");
    const skus = await canonicalize(selected.flatMap(r => {
      const output = cleaningOutputSchema.parse(r); return output.outcome === "FAILED" || !output.normalized.sku ? [] : [output.normalized.sku];
    }));
    for (const result of selected) {
      if (result.sourceRow.importId !== importId || sourceIds.has(result.sourceRowId)) throw new GroupingConflict("INVALID_SELECTION_SCOPE");
      sourceIds.add(result.sourceRowId);
      const policy = cleaningConfigSchema.parse(result.configSnapshot);
      if (policy.storeId !== storeId || policy.supplierId !== imported.supplierId || policy.sheetIndex !== result.sourceRow.sheetIndex || configIdentity(policy).configHash !== result.configHash) throw new GroupingConflict("CLEANING_POLICY_SCOPE");
      const output = cleaningOutputSchema.parse(result);
      const cells = output.outcome === "FAILED" ? [] : z.array(z.object({ value: z.unknown() }).passthrough()).parse(result.sourceRow.rawCells);
      const trusted = (field: string) => output.outcome !== "FAILED" && !output.issues.some(i => i.field === field && i.severity !== "WARNING") &&
        (output.evidence[field] ?? []).some(e => e.kind === "cell" && e.sourceRowId === result.sourceRowId && typeof cells[e.columnIndex]?.value === "string");
      rows.push({ ...output, id: result.id, sourceRowId: result.sourceRowId, canonicalSku: output.outcome === "FAILED" ? null : skus.get(output.normalized.sku ?? "") ?? null,
        mappedFields: Object.keys(policy.columns), trustedSku: trusted("sku"), trustedFamily: config.familyAttribute !== null && trusted(`attributes.${config.familyAttribute}`) });
      const { sourceRow, ...interpretation } = result; void sourceRow;
      fingerprints.push({ sourceRowId: result.sourceRowId, resultId: result.id, hash: hash(interpretation) });
    }
  }
  rows.sort((a, b) => a.sourceRowId.localeCompare(b.sourceRowId));
  fingerprints.sort((a, b) => a.sourceRowId.localeCompare(b.sourceRowId));
  // Fingerprint each complete result separately; never materialize another
  // import-sized copy of configuration/evidence just to hash the selection.
  return { imported, config, configHash: hash(config), inputHash: hash(fingerprints), rows };
}

async function catalog(tx: Prisma.TransactionClient, storeId: string, supplierId: string, rows: InputRow[], config: GroupingConfig): Promise<Catalog> {
  const skus = rows.flatMap(r => r.canonicalSku ? [r.canonicalSku] : []);
  const variants = await tx.variant.findMany({ where: { storeId, sku: { in: skus } }, include: { product: true } });
  const keys = rows.flatMap(r => {
    const family = config.familyAttribute ? r.normalized.attributes[config.familyAttribute] : null;
    return [family, Object.hasOwn(config.skuFamilies, r.canonicalSku ?? "") ? config.skuFamilies[r.canonicalSku ?? ""] : null].filter((f): f is string => typeof f === "string" && Boolean(f)).flatMap(f => [familyKey(config.namespace, f), f]);
  });
  if (config.missingFamily === "STANDALONE") skus.forEach(s => keys.push(`sku:${JSON.stringify([config.namespace, s])}`));
  const products = await tx.product.findMany({ where: { storeId, supplierId, OR: [{ supplierProductKey: { in: keys } }, { id: { in: variants.map(v => v.productId) } }] } });
  const productIds = products.map(p => p.id);
  const baselineIds = products.flatMap(p => p.publishedRevisionId ? [p.publishedRevisionId] : []);
  // Batch catalog facts: row count must not produce one history query per product.
  const revisions = await tx.productRevision.findMany({ where: { productId: { in: productIds } }, select: { id: true, productId: true, status: true, editVersion: true, manualFieldPaths: true } });
  const baselines = await tx.productRevision.findMany({ where: { id: { in: baselineIds } } });
  const baselineVariants = await tx.variantRevision.findMany({ where: { productRevisionId: { in: baselineIds } }, orderBy: { variantId: "asc" } });
  const baselineSources = await tx.revisionSourceRow.findMany({ where: { productRevisionId: { in: baselineIds } }, orderBy: { sourceRowId: "asc" } });
  const ownedVariants = await tx.variantRevision.findMany({ where: { productRevisionId: { in: revisions.map(r => r.id) }, manualFieldPaths: { isEmpty: false } }, select: { productRevisionId: true } });
  const editedVariantRevisions = new Set(ownedVariants.map(v => v.productRevisionId));
  const byProduct = new Map(products.map(p => [p.id, p]));
  const editedProducts = new Set(revisions.filter(r => r.id !== byProduct.get(r.productId)?.publishedRevisionId && r.status !== "REJECTED" &&
    (r.editVersion > 1 || r.manualFieldPaths.length || editedVariantRevisions.has(r.id))).map(r => r.productId));
  function index<T>(items: T[], key: (item: T) => string) {
    const map = new Map<string, T[]>();
    for (const item of items) { const id = key(item), list = map.get(id) ?? []; list.push(item); map.set(id, list); }
    return map;
  }
  const byBaseline = new Map(baselines.map(r => [r.id, r]));
  const variantLists = index(baselineVariants, v => v.productRevisionId), sourceLists = index(baselineSources, s => s.productRevisionId);
  const facts: Catalog["products"] = products.map(p => {
    const r = p.publishedRevisionId ? byBaseline.get(p.publishedRevisionId) : null;
    return { id: p.id, key: p.supplierProductKey, archived: Boolean(p.archivedAt), baselineId: p.publishedRevisionId,
      baselineHash: r ? hash({ ...r, variants: variantLists.get(r.id) ?? [], sourceRows: sourceLists.get(r.id) ?? [] }) : null, editedDraft: editedProducts.has(p.id) };
  });
  return { supplierId, variants: variants.map(v => ({ sku: v.sku, productId: v.productId, supplierId: v.product.supplierId, archived: Boolean(v.archivedAt) })), products: facts };
}

async function retry<T>(action: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await action(); }
    catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      if (attempt >= 2 || !["P2002", "P2034"].includes(String(code))) throw error;
    }
  }
}

/** Deterministic grouping; callers may atomically register continuation via onComplete. No approval or publication. */
export async function groupImport(storeId: string, importId: string, cleaningResultIds: string[], configInput: unknown,
  options: { afterFamily?: (completedFamilies: number) => Promise<void>; beforeFamily?: () => Promise<void>; beforeFamilyCommit?: () => Promise<void>; onComplete?: (tx: Prisma.TransactionClient) => Promise<void> } = {}) {
  const prepared = await prepare(storeId, importId, cleaningResultIds, configInput);
  const db = getDb();
  const run = await retry(() => db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Store" WHERE id = ${storeId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Import" WHERE id = ${importId}::uuid FOR SHARE`;
    const currentImport = await tx.import.findFirstOrThrow({ where: { id: importId, storeId } });
    if (currentImport.status !== "COMPLETED" || currentImport.totalRows !== prepared.rows.length) throw new GroupingConflict("COMPLETE_IMPORT_SELECTION_REQUIRED");
    const existing = await tx.groupingRun.findUnique({ where: { importId } });
    if (existing) {
      if (existing.configHash !== prepared.configHash || existing.inputHash !== prepared.inputHash || existing.grouperVersion !== GROUPER_VERSION) throw new GroupingConflict("FROZEN_RUN_REQUIRES_NEW_IMPORT");
      return existing;
    }
    // Store lock serializes cooperating grouping writers while reading catalog facts.
    const facts = await catalog(tx, storeId, prepared.imported.supplierId, prepared.rows, prepared.config);
    const plan = planGrouping(prepared.rows, prepared.config, facts);
    const created = await tx.groupingRun.create({ data: { importId, storeId, grouperVersion: GROUPER_VERSION,
      configHash: prepared.configHash, configSnapshot: json(prepared.config), inputHash: prepared.inputHash, plan: json(plan) } });
    const keys = new Map(plan.groups.flatMap(g => g.rowIds.map(id => [id, g.key] as const)));
    for (let start = 0; start < prepared.rows.length; start += 250) await tx.groupingRowResult.createMany({ data: prepared.rows.slice(start, start + 250).map(r => ({
      runId: created.id, importId, storeId, sourceRowId: r.sourceRowId, cleaningResultId: r.id, groupKey: keys.get(r.sourceRowId)!
    })) });
    return created;
  }, { timeout: 15000 }));
  const plan = planSchema.parse(run.plan);
  const byRow = new Map(prepared.rows.map(r => [r.sourceRowId, r]));
  let completed = 0;
  for (const group of plan.groups) {
    await options.beforeFamily?.();
    await retry(() => db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Store" WHERE id = ${storeId}::uuid FOR UPDATE`;
      const pending = await tx.groupingRowResult.count({ where: { runId: run.id, groupKey: group.key, outcome: "PENDING" } });
      if (!pending) return;
      if (pending !== group.rowIds.length) throw new GroupingConflict("INCOMPLETE_FAMILY_CHECKPOINT");
      try {
        if (group.blocked.length) throw new GroupingConflict(group.blocked.join("|"));
        await applyFamily(tx, run.id, storeId, importId, prepared.imported.supplierId, group, byRow);
        await options.beforeFamilyCommit?.();
      } catch (error) {
        // Only pre-write business conflicts are handled here. DB errors abort the
        // entire transaction; no catch-and-continue after partial catalog writes.
        if (!(error instanceof GroupingConflict)) throw error;
        await tx.groupingRowResult.updateMany({ where: { runId: run.id, groupKey: group.key }, data: {
          outcome: group.blocked.includes("CLEANING_FAILED") ? "FAILED" : "NEEDS_REVIEW",
          issues: json([{ code: error.code, field: "identity" }])
        } });
      }
    }, { timeout: 15000 }));
    await options.afterFamily?.(++completed);
  }
  await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "GroupingRun" WHERE id = ${run.id}::uuid FOR UPDATE`;
    const all = await tx.groupingRowResult.count({ where: { runId: run.id } });
    const pending = await tx.groupingRowResult.count({ where: { runId: run.id, outcome: "PENDING" } });
    if (all !== prepared.rows.length || pending) throw new GroupingConflict("GROUPING_COUNT_MISMATCH");
    const current = await tx.groupingRun.findUniqueOrThrow({ where: { id: run.id } });
    if (current.status !== "COMPLETED") await tx.groupingRun.update({ where: { id: run.id }, data: { status: "COMPLETED", finishedAt: new Date() } });
    await options.onComplete?.(tx);
  });
  return db.groupingRun.findUniqueOrThrow({ where: { id: run.id }, include: { rows: { orderBy: { sourceRowId: "asc" } } } });
}

async function applyFamily(tx: Prisma.TransactionClient, runId: string, storeId: string, importId: string, supplierId: string, group: FamilyPlan, byRow: Map<string, InputRow>) {
  const existing = group.productId ? await tx.product.findUnique({ where: { id: group.productId } }) :
    await tx.product.findUnique({ where: { storeId_supplierId_supplierProductKey: { storeId, supplierId, supplierProductKey: group.productKey! } } });
  if (existing) await tx.$queryRaw`SELECT id FROM "Product" WHERE id = ${existing.id}::uuid FOR UPDATE`;
  // Reload after locking; publication may have changed between lookup and lock.
  const product = existing ? await tx.product.findUniqueOrThrow({ where: { id: existing.id } }) : null;
  if (product && (product.storeId !== storeId || product.supplierId !== supplierId || product.archivedAt || product.supplierProductKey !== group.productKey)) throw new GroupingConflict("PRODUCT_OWNERSHIP_OR_ARCHIVE");
  if (group.productId && !product) throw new GroupingConflict("MISSING_PRODUCT");
  if ((product?.publishedRevisionId ?? null) !== group.baselineId) throw new GroupingConflict("STALE_BASELINE");
  if (group.baselineId) {
    await tx.$queryRaw`SELECT id FROM "ProductRevision" WHERE id = ${group.baselineId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT "variantId" FROM "VariantRevision" WHERE "productRevisionId" = ${group.baselineId}::uuid FOR SHARE`;
  }
  const base = group.baselineId ? await loadBaseline(tx, group.baselineId) : null;
  if ((base ? hash(base) : null) !== group.baselineHash) throw new GroupingConflict("STALE_BASELINE");
  if (product) {
    const { drafts, edited } = await editedDrafts(tx, product.id, group.baselineId);
    if (edited) throw new GroupingConflict("MERCHANT_DRAFT_REBASE_REQUIRED");
    if (drafts.some(r => r.originImportId === importId)) throw new GroupingConflict("EXISTING_PROPOSAL_REQUIRES_REVIEW");
  }
  await tx.$queryRaw`SELECT id FROM "Variant" WHERE
    ("productId" = ${product?.id ?? "00000000-0000-0000-0000-000000000000"}::uuid)
    OR ("storeId" = ${storeId}::uuid AND sku IN (SELECT jsonb_array_elements_text(${JSON.stringify(group.variants.map(v => v.sku))}::jsonb)))
    ORDER BY id FOR UPDATE`;
  const existingVariants = await tx.variant.findMany({ where: { storeId, sku: { in: group.variants.map(v => v.sku) } } });
  if (existingVariants.some(v => v.archivedAt || v.productId !== product?.id)) throw new GroupingConflict("SKU_OWNERSHIP_OR_ARCHIVE");
  if (product && !base && await tx.variant.count({ where: { productId: product.id, sku: { notIn: group.variants.map(v => v.sku) } } })) {
    throw new GroupingConflict("UNPUBLISHED_VARIANT_BASELINE_REQUIRED");
  }
  if (base) {
    const inherited = await tx.sourceRow.findMany({ where: { id: { in: base.sourceRows.map(s => s.sourceRowId) } }, include: { import: true } });
    if (inherited.some(r => r.import.supplierId !== supplierId)) throw new GroupingConflict("BASELINE_EVIDENCE_SUPPLIER");
    const inheritedVariants = await tx.variant.findMany({ where: { id: { in: base.variants.map(v => v.variantId) } } });
    if (inheritedVariants.some(v => v.archivedAt)) throw new GroupingConflict("ARCHIVED_BASELINE_VARIANT");
  }
  // All business guards above this point: no conflict can commit orphan identities.
  const target = product ?? await tx.product.create({ data: { storeId, supplierId, supplierProductKey: group.productKey } });
  const reasons = [...group.issues];
  const fields = { title: group.title, descriptionHtml: group.descriptionHtml, attributes: group.attributes };
  const mapped = (field: string, rowIds = group.rowIds) => rowIds.some(id => byRow.get(id)?.mappedFields.includes(field));
  const selected = { ...fields, attributes: { ...(base?.attributes as Record<string, unknown> ?? {}), ...fields.attributes } };
  if (base && !mapped("title")) selected.title = base.title;
  if (base && !mapped("description")) selected.descriptionHtml = base.descriptionHtml;
  if (base) for (const key of Object.keys(group.attributes)) if (!mapped(`attributes.${key}`)) {
    const prior = z.record(z.string(), z.unknown()).parse(base.attributes);
    if (Object.hasOwn(prior, key)) selected.attributes[key] = prior[key];
    else delete selected.attributes[key];
  }
  for (const field of ["title", "descriptionHtml", "attributes"] as const) if (base && manual(base.manualFieldPaths, field)) {
    if (canonicalJson(json(selected[field])) !== canonicalJson(json(base[field]))) reasons.push({ code: "MANUAL_OVERRIDE_PRESERVED", field, sourceRowIds: group.rowIds });
    // Parent or nested ownership conservatively protects the complete field.
    Object.assign(selected, { [field]: base[field] });
  }
  const plannedVariants = new Map(group.variants.map(v => [v.sku, v]));
  const actual = new Map(existingVariants.map(v => [v.sku, v]));
  const creating = group.variants.filter(v => !actual.has(v.sku));
  for (let start = 0; start < creating.length; start += 250) {
    const batch = creating.slice(start, start + 250);
    await tx.variant.createMany({ data: batch.map(v => ({ storeId, productId: target.id, sku: v.sku })) });
    const saved = await tx.variant.findMany({ where: { storeId, sku: { in: batch.map(v => v.sku) } } });
    saved.forEach(v => actual.set(v.sku, v));
  }
  const snapshots = new Map<string, { variantId: string; options: Prisma.InputJsonValue; priceMinor: bigint | null; currency: string | null; weightGrams: number | null; manualFieldPaths: string[] }>(base?.variants.map(v => [v.variantId, { variantId: v.variantId, options: json(v.options), priceMinor: v.priceMinor, currency: v.currency, weightGrams: v.weightGrams, manualFieldPaths: v.manualFieldPaths }]) ?? []);
  for (const [sku, variant] of actual) {
    const proposed = plannedVariants.get(sku)!;
    const old = snapshots.get(variant.id);
    const snapshot = { variantId: variant.id, options: json(proposed.options), priceMinor: proposed.priceMinor === null ? null : BigInt(proposed.priceMinor), currency: proposed.currency,
      weightGrams: proposed.weightGrams, manualFieldPaths: old?.manualFieldPaths ?? [] };
    if (old && !mapped("weight", proposed.rowIds)) snapshot.weightGrams = old.weightGrams;
    if (old && !mapped("price", proposed.rowIds) && !mapped("currency", proposed.rowIds)) { snapshot.priceMinor = old.priceMinor; snapshot.currency = old.currency; }
    for (const field of ["options", "priceMinor", "currency", "weightGrams"] as const) if (old && manual(old.manualFieldPaths, field)) {
      if (hash(snapshot[field]) !== hash(old[field])) reasons.push({ code: "MANUAL_OVERRIDE_PRESERVED", field: `${sku}.${field}`, sourceRowIds: proposed.rowIds });
      Object.assign(snapshot, { [field]: old[field] });
    }
    // Price and currency form one business value; preserve both if either is owned.
    if (old && (manual(old.manualFieldPaths, "priceMinor") || manual(old.manualFieldPaths, "currency"))) { snapshot.priceMinor = old.priceMinor; snapshot.currency = old.currency; }
    snapshots.set(variant.id, snapshot);
  }
  const revision = await tx.productRevision.create({ data: { productId: target.id, storeId, originImportId: importId, groupingRunId: runId,
    basePublishedRevisionId: base?.id ?? null, status: reasons.length ? "NEEDS_REVIEW" : "DRAFT", title: selected.title, descriptionHtml: selected.descriptionHtml,
    categoryKey: base?.categoryKey ?? null, tags: base?.tags ?? [], attributes: json(selected.attributes), manualFieldPaths: base?.manualFieldPaths ?? [], reviewReasons: json(reasons) } });
  const snapshotRows = [...snapshots.values()];
  for (let start = 0; start < snapshotRows.length; start += 250) await tx.variantRevision.createMany({ data: snapshotRows.slice(start, start + 250).map(v => ({ ...v, options: json(v.options), storeId, productId: target.id, productRevisionId: revision.id })) });
  const links = new Map(base?.sourceRows.map(s => [s.sourceRowId, { sourceRowId: s.sourceRowId, variantId: s.variantId, cleaningResultId: s.cleaningResultId }]) ?? []);
  for (const variant of group.variants) for (const rowId of variant.rowIds) links.set(rowId, { sourceRowId: rowId, variantId: actual.get(variant.sku)!.id, cleaningResultId: byRow.get(rowId)!.id });
  const evidence = [...links.values()];
  for (let start = 0; start < evidence.length; start += 250) await tx.revisionSourceRow.createMany({ data: evidence.slice(start, start + 250).map(l => ({ ...l, storeId, productRevisionId: revision.id })) });
  // Full cross-row reasons live once on the proposal/plan. Row outcomes retain
  // only local codes and fields, rather than duplicating an import-sized list.
  const localIssues = new Map(group.rowIds.map(id => [id, [] as { code: string; field: string }[]]));
  for (const issue of reasons) for (const id of issue.sourceRowIds) localIssues.get(id)?.push({ code: issue.code, field: issue.field });
  const outcomes = group.variants.flatMap(v => v.rowIds.map(id => ({ sourceRowId: id, variantId: actual.get(v.sku)!.id, issues: localIssues.get(id)! })));
  for (let start = 0; start < outcomes.length; start += 250) {
    await tx.$executeRaw`
      UPDATE "GroupingRowResult" AS r SET "productRevisionId" = ${revision.id}::uuid,
        "variantId" = x."variantId", issues = x.issues, outcome = ${reasons.length ? "NEEDS_REVIEW" : "APPLIED"}::"GroupingRowOutcome"
      FROM jsonb_to_recordset(${JSON.stringify(outcomes.slice(start, start + 250))}::jsonb) AS x("sourceRowId" uuid, "variantId" uuid, issues jsonb)
      WHERE r."runId" = ${runId}::uuid AND r."sourceRowId" = x."sourceRowId"`;
  }
}
