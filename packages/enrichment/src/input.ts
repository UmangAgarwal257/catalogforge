import { getDb, type Prisma } from "@catalogforge/db";
import { cleanRow } from "@catalogforge/cleaning";
import { cleaningConfigSchema, CLEANER_VERSION } from "@catalogforge/cleaning/contracts";
import { canonicalJson, configIdentity } from "@catalogforge/cleaning/persistence";
import { createHash } from "node:crypto";
import { EnrichmentError, type Fact, type Packet } from "./contracts";
export const json = (v: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(v, (_, x) => typeof x === "bigint" ? x.toString() : x));
export const hash = (v: unknown) => createHash("sha256").update(canonicalJson(json(v))).digest("hex");
export async function snapshot(storeId: string, revisionId: string, db: Prisma.TransactionClient = getDb()) {
  const revision = await db.productRevision.findFirstOrThrow({ where: { id: revisionId, storeId } });
  const product = await db.product.findFirstOrThrow({ where: { id: revision.productId, storeId } });
  if (!revision.groupingRunId || !["DRAFT", "NEEDS_REVIEW"].includes(revision.status) || product.publishedRevisionId === revisionId || product.archivedAt) throw new EnrichmentError("INELIGIBLE_PROPOSAL");
  const grouping = await db.groupingRun.findUniqueOrThrow({ where: { id: revision.groupingRunId } });
  if (grouping.status !== "COMPLETED") throw new EnrichmentError("GROUPING_INCOMPLETE");
  // The grouping manifest freezes complete cleaning interpretations, not merely
  // their IDs. Validate that manifest before accepting a new enrichment input.
  const selections = await db.groupingRowResult.findMany({ where: { runId: grouping.id }, select: { sourceRowId: true, cleaningResultId: true } });
  const manifest: { sourceRowId: string; resultId: string; hash: string }[] = [];
  for (let start = 0; start < selections.length; start += 250) {
    const results = await db.rowCleaningResult.findMany({ where: { id: { in: selections.slice(start, start + 250).map(r => r.cleaningResultId) } } });
    for (const result of results) manifest.push({ sourceRowId: result.sourceRowId, resultId: result.id, hash: hash(result) });
  }
  manifest.sort((a, b) => a.sourceRowId.localeCompare(b.sourceRowId));
  if (manifest.length !== selections.length || hash(manifest) !== grouping.inputHash) throw new EnrichmentError("GROUPING_INPUT_CHANGED");
  const variants = await db.variantRevision.findMany({ where: { productRevisionId: revisionId }, orderBy: { variantId: "asc" } });
  const identities = await db.variant.findMany({ where: { productId: product.id }, orderBy: { id: "asc" } });
  if (identities.some(v => v.archivedAt)) throw new EnrichmentError("ARCHIVED_VARIANT");
  const links = await db.revisionSourceRow.findMany({ where: { productRevisionId: revisionId }, orderBy: { sourceRowId: "asc" } });
  if (!links.length || links.length > 100) throw new EnrichmentError("ONE_PRODUCT_EVIDENCE_LIMIT");
  const facts: Fact[] = [], blocked = new Set<string>();
  const interpretations = [];
  for (const link of links) {
    if (!link.cleaningResultId) throw new EnrichmentError("EXACT_CLEANING_EVIDENCE_REQUIRED");
    const result = await db.rowCleaningResult.findUniqueOrThrow({ where: { id: link.cleaningResultId } });
    const source = await db.sourceRow.findUniqueOrThrow({ where: { id: link.sourceRowId } });
    const imported = await db.import.findUniqueOrThrow({ where: { id: source.importId } });
    if (result.sourceRowId !== source.id || result.storeId !== storeId || imported.supplierId !== product.supplierId || source.storeId !== storeId) throw new EnrichmentError("EVIDENCE_OWNERSHIP");
    const config = cleaningConfigSchema.parse(result.configSnapshot);
    if (config.storeId !== storeId || config.supplierId !== product.supplierId || config.sheetIndex !== source.sheetIndex || configIdentity(config).configHash !== result.configHash || result.cleanerVersion !== CLEANER_VERSION) throw new EnrichmentError("CLEANER_POLICY_MISMATCH");
    const output = cleanRow({ ...source, rawCells: source.rawCells } as Parameters<typeof cleanRow>[0], config);
    if (hash(output) !== hash({ normalized: result.normalized, evidence: result.evidence, issues: result.issues, outcome: result.outcome })) throw new EnrichmentError("CLEANING_CONTENT_CHANGED");
    interpretations.push({ id: result.id, hash: hash(result), sourceId: source.id });
    if (output.outcome === "FAILED") continue;
    const values: Record<string, string | null> = { title: output.normalized.title, descriptionHtml: output.normalized.descriptionHtml,
      ...Object.fromEntries(Object.entries(output.normalized.attributes).filter(([key]) => key !== "familyId").map(([k, v]) => [`attributes.${k}`, v])) };
    for (const [path, value] of Object.entries(values)) {
      const field = path === "descriptionHtml" ? "description" : path;
      if (output.issues.some(i => i.field === field && i.severity !== "WARNING")) { blocked.add(path); continue; }
      if (!value) continue;
      const evidence = output.evidence[field] ?? [];
      const cells = evidence.flatMap(e => {
        if (e.kind !== "cell") return [];
        if (e.sourceRowId !== source.id || e.valuePointer !== "/value") throw new EnrichmentError("EVIDENCE_POINTER");
        const cell = (source.rawCells as unknown as { value: unknown }[])[e.columnIndex];
        if (!cell || typeof cell.value !== "string") return [];
        return [{ sourceRowId: source.id, importId: imported.id, cleaningResultId: result.id, columnIndex: e.columnIndex,
          valuePointer: e.valuePointer, quote: cell.value, start: 0, end: cell.value.length }];
      });
      if (!cells.length) continue;
      // A product-wide fact must agree across all contributing rows. Variant
      // evidence remains separately scoped and cannot supply a product claim.
      const fact: Fact = { id: hash({ path, value }).slice(0, 24), path, value, variantId: null, origin: "SUPPLIER_FACT", evidence: cells,
        transformations: evidence.filter(e => e.kind === "transformation").map(e => e.rule),
        configuration: evidence.filter(e => e.kind === "configuration").map(e => e.path) };
      const existing = facts.find(f => f.id === fact.id);
      if (existing) existing.evidence.push(...cells); else facts.push(fact);
    }
  }
  for (const path of new Set(facts.map(f => f.path))) {
    if (facts.filter(f => f.path === path).length !== 1 || new Set(facts.find(f => f.path === path)!.evidence.map(e => e.sourceRowId)).size < links.length) blocked.add(path);
  }
  const packet: Packet = { facts: facts.sort((a, b) => a.id.localeCompare(b.id)), existingIssues: revision.reviewReasons,
    variants: json(variants), manualFieldPaths: revision.manualFieldPaths, blockedFields: [...blocked].sort() };
  return { revision, product, variants: json(variants), identities: json(identities), links, grouping: { id: grouping.id, inputHash: grouping.inputHash, configHash: grouping.configHash }, interpretations, packet };
}
export const owned = (paths: string[], path: string) => paths.some(p => {
  const canonical = p.replace(/^\//, "").replaceAll("/", ".");
  return path === canonical || path.startsWith(`${canonical}.`) || canonical.startsWith(`${path}.`);
});
