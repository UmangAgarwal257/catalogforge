import type { Candidate, Packet, Policy } from "./contracts";
import type { Provider } from "./providers";
// Automated tests only. The application never imports this module.
export function stubOutput(packet: Packet): Candidate {
  const fields: Candidate["fields"] = [];
  for (const path of ["title", "descriptionHtml", ...new Set(packet.facts.filter(f => f.path.startsWith("attributes.")).map(f => f.path))]) {
    const fact = packet.facts.find(f => f.path === path && f.variantId === null);
    if (fact) fields.push({ path, value: fact.value, confidence: 95, origin: fact.origin, factIds: [fact.id] });
  }
  const colour = packet.facts.find(f => f.path === "attributes.colour" && f.variantId === null);
  if (colour) fields.push({ path: "tags.0", value: colour.value, confidence: 95, origin: colour.origin, factIds: [colour.id] });
  fields.push({ path: "categoryKey", value: "Home & Garden > Planters", confidence: 90, origin: "INFERRED_SUGGESTION", factIds: [] });
  return { fields, issues: [] };
}
export const testProvider: Provider = { name: "test", async generate(packet) { if (process.env.NODE_ENV !== "test") throw new Error("TEST_STUB_ONLY"); return { output: stubOutput(packet), model: "deterministic-test-v1", usageKind: "MOCK" }; } };

export const testPolicy: Policy = { provider: "test", primary: { model: "deterministic-test-v1", inputMicroUsdPerMillion: 0, outputMicroUsdPerMillion: 0 },
  escalation: null, pricingVersion: "test-zero-v1", budgetMicroUsd: 0, freeTierBillingDisabled: true, requestsPerDay: 5, inputTokensPerMinute: 10000, maxOutputTokens: 1500, maxInputBytes: 24000,
  confidenceThreshold: 85, categories: ["Home & Garden > Planters"] };
