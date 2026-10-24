import { createHash } from "node:crypto";
import { getDb } from "@catalogforge/db";
import { cleanRow } from "./clean";
import { CLEANER_VERSION, cleaningConfigSchema } from "./contracts";

// Object key order cannot change configuration identity; array order is explicit.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Configuration must contain only JSON values");
  return encoded;
}
export function configIdentity(input: unknown) {
  const configSnapshot = cleaningConfigSchema.parse(input);
  const configHash = createHash("sha256").update(canonicalJson(configSnapshot)).digest("hex");
  return { configSnapshot, configHash };
}

export async function cleanSourceRows(storeId: string, sourceRowIds: string[], configInput: unknown) {
  if (sourceRowIds.length > 100 || new Set(sourceRowIds).size !== sourceRowIds.length) throw new Error("Cleaning batches require at most 100 distinct source rows");
  const { configSnapshot, configHash } = configIdentity(configInput);
  if (storeId !== configSnapshot.storeId) throw new Error("Cleaning configuration store does not match the requested scope");
  if (!sourceRowIds.length) return [];
  const db = getDb();
  const sources = await db.sourceRow.findMany({ where: { id: { in: sourceRowIds }, storeId }, include: { import: true } });
  if (sources.length !== sourceRowIds.length) throw new Error("Source row not found in the requested store");
  const expected = new Map(sources.map(source => {
    if (source.import.supplierId !== configSnapshot.supplierId) throw new Error("Cleaning configuration supplier does not match the source import");
    if (source.import.status !== "COMPLETED") throw new Error("Cleaning requires a completed spreadsheet ingestion");
    const output = cleanRow(source, configSnapshot);
    return [source.id, { sourceRowId: source.id, storeId, cleanerVersion: CLEANER_VERSION, configHash, configSnapshot, ...output }] as const;
  }));
  const existing = await db.rowCleaningResult.findMany({ where: { sourceRowId: { in: sourceRowIds }, storeId, cleanerVersion: CLEANER_VERSION, configHash } });
  type Result = (typeof existing)[number];
  const verify = (result: Result) => {
    const data = expected.get(result.sourceRowId);
    if (!data || result.storeId !== storeId || result.cleanerVersion !== CLEANER_VERSION || result.configHash !== configHash ||
        canonicalJson({ configSnapshot: result.configSnapshot, normalized: result.normalized, evidence: result.evidence, issues: result.issues, outcome: result.outcome }) !==
        canonicalJson({ configSnapshot: data.configSnapshot, normalized: data.normalized, evidence: data.evidence, issues: data.issues, outcome: data.outcome })) {
      throw new Error("Existing cleaning result differs; no evidence or result was overwritten");
    }
  };
  // Presence alone is never trusted. Recompute from immutable source cells and
  // validate all reusable rows before attempting any writes for this batch.
  existing.forEach(verify);
  const saved = new Map(existing.map(result => [result.sourceRowId, result]));
  const missing = sourceRowIds.filter(id => !saved.has(id));
  if (missing.length) {
    await db.rowCleaningResult.createMany({ data: missing.map(id => expected.get(id)!), skipDuplicates: true });
    // Concurrent callers may have won an insertion. Read and verify their exact
    // values rather than overwriting them or assuming our insert succeeded.
    const inserted = await db.rowCleaningResult.findMany({ where: { sourceRowId: { in: missing }, storeId, cleanerVersion: CLEANER_VERSION, configHash } });
    inserted.forEach(result => { verify(result); saved.set(result.sourceRowId, result); });
  }
  return sourceRowIds.map(id => {
    const result = saved.get(id);
    if (!result) throw new Error("Cleaning checkpoint missing after persistence");
    return result;
  });
}

export async function cleanSourceRow(storeId: string, sourceRowId: string, configInput: unknown) {
  return (await cleanSourceRows(storeId, [sourceRowId], configInput))[0]!;
}
