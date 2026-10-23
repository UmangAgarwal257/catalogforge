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

export async function cleanSourceRow(storeId: string, sourceRowId: string, configInput: unknown) {
  const { configSnapshot, configHash } = configIdentity(configInput);
  if (storeId !== configSnapshot.storeId) throw new Error("Cleaning configuration store does not match the requested scope");
  const db = getDb();
  const source = await db.sourceRow.findFirst({ where: { id: sourceRowId, storeId }, include: { import: true } });
  if (!source) throw new Error("Source row not found in the requested store");
  if (source.import.supplierId !== configSnapshot.supplierId) throw new Error("Cleaning configuration supplier does not match the source import");
  if (source.import.status !== "COMPLETED") throw new Error("Cleaning requires a completed spreadsheet ingestion");
  const output = cleanRow(source, configSnapshot);
  const data = { sourceRowId, storeId, cleanerVersion: CLEANER_VERSION, configHash, configSnapshot, ...output };
  // ON CONFLICT DO NOTHING: retries cannot update old results or source evidence.
  await db.rowCleaningResult.createMany({ data: [data], skipDuplicates: true });
  const result = await db.rowCleaningResult.findUniqueOrThrow({ where: {
    sourceRowId_cleanerVersion_configHash: { sourceRowId, cleanerVersion: CLEANER_VERSION, configHash }
  } });
  if (canonicalJson({ configSnapshot: result.configSnapshot, normalized: result.normalized, evidence: result.evidence, issues: result.issues, outcome: result.outcome }) !==
      canonicalJson({ configSnapshot, ...output })) throw new Error("Existing cleaning result differs; no evidence or result was overwritten");
  return result;
}
