import { CATEGORY_KEYS } from "@catalogforge/shared/catalog";
import { EnrichmentError, policySchema, type Policy } from "./contracts";
// Explicitly verified free Standard text models; changing this list requires
// checking Google's current pricing, not merely accepting a model name from env.
export const FREE_MODELS = ["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-3.5-flash-lite"] as const;
export function geminiPolicyFromEnv(env: NodeJS.ProcessEnv): Policy {
  if (!env.GEMINI_API_KEY?.trim()) throw new EnrichmentError("GEMINI_API_KEY_REQUIRED");
  if (env.GEMINI_BILLING_DISABLED !== "true") throw new EnrichmentError("GEMINI_BILLING_MUST_BE_DISABLED");
  const model = env.GEMINI_MODEL ?? "gemini-2.5-flash-lite";
  if (!(FREE_MODELS as readonly string[]).includes(model)) throw new EnrichmentError("FREE_MODEL_NOT_APPROVED");
  return policySchema.parse({ provider: "gemini", primary: { model, inputMicroUsdPerMillion: 0, outputMicroUsdPerMillion: 0 }, escalation: null,
    budgetMicroUsd: 0, freeTierBillingDisabled: true, pricingVersion: "gemini-free-standard-2026-10-23",
    requestsPerDay: Number(env.GEMINI_REQUESTS_PER_DAY ?? 5), inputTokensPerMinute: Number(env.GEMINI_INPUT_TOKENS_PER_MINUTE ?? 10000),
    maxOutputTokens: 1500, maxInputBytes: 24000, confidenceThreshold: 85, categories: CATEGORY_KEYS });
}
