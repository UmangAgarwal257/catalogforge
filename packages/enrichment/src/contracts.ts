import { z } from "zod";
export const PROMPT_VERSION = "enrichment-prompt-v2-gemini";
export const VALIDATOR_VERSION = "source-exact-v1";
const rates = z.object({ model: z.string().min(1), inputMicroUsdPerMillion: z.number().int().nonnegative().max(1000000000),
  outputMicroUsdPerMillion: z.number().int().nonnegative().max(1000000000) }).strict();
export const policySchema = z.object({
  provider: z.enum(["test", "gemini"]), primary: rates, escalation: rates.nullable(),
  pricingVersion: z.string().min(1), budgetMicroUsd: z.literal(0), freeTierBillingDisabled: z.literal(true),
  requestsPerDay: z.number().int().min(1).max(20), inputTokensPerMinute: z.number().int().min(1000).max(24000),
  maxOutputTokens: z.number().int().min(256).max(2000), maxInputBytes: z.number().int().min(1000).max(24000),
  confidenceThreshold: z.number().int().min(0).max(100),
  categories: z.array(z.string().min(1).max(100)).max(32)
 }).strict().refine(p => [p.primary, ...(p.escalation ? [p.escalation] : [])].every(r => r.inputMicroUsdPerMillion === 0 && r.outputMicroUsdPerMillion === 0) && (p.provider === "test" || p.escalation === null), "PAID_API_FORBIDDEN");
export type Policy = z.infer<typeof policySchema>;
export const candidateSchema = z.object({
  fields: z.array(z.object({ path: z.string().max(100), value: z.string().max(6000),
    origin: z.enum(["SUPPLIER_FACT", "CONFIGURATION", "AI_WORDING", "INFERRED_SUGGESTION"]),
    confidence: z.number().int().min(0).max(100), factIds: z.array(z.string().max(100)).max(100) }).strict()).max(64),
  issues: z.array(z.string().max(300)).max(32)
}).strict();
export type Candidate = z.infer<typeof candidateSchema>;
export type CellEvidence = { sourceRowId: string; importId: string; cleaningResultId: string; columnIndex: number;
  valuePointer: string; quote: string; start: number; end: number };
export type Fact = { id: string; path: string; value: string; variantId: string | null; origin: "SUPPLIER_FACT" | "CONFIGURATION";
  evidence: CellEvidence[]; transformations: string[]; configuration: string[] };
export type Packet = { facts: Fact[]; existingIssues: unknown; variants: unknown; manualFieldPaths: string[]; blockedFields: string[] };
export type Issue = { code: string; field: string };
export type Validated = { accepted: Candidate["fields"]; withheld: Candidate["fields"]; issues: Issue[]; applied?: Candidate["fields"] };
export class EnrichmentError extends Error { constructor(public readonly code: string) { super(code); } }
export function estimate(tokens: number, rate: number): number {
  return Number((BigInt(tokens) * BigInt(rate) + 999999n) / 1000000n);
}
