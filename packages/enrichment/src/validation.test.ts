import { expect, it } from "vitest";
import { estimate, candidateSchema, policySchema, type Packet, type Candidate } from "./contracts";
import { stubOutput, testProvider, testPolicy } from "./test-stub";
import { z } from "zod";
import { geminiProvider, responseSchema } from "./providers";
import { geminiPolicyFromEnv } from "./config";
import { validateCandidate, measureValidation } from "./validation";
const description = "<p>Frost-resistant, not frost-proof.</p><p>Bring indoors below 0 °C.</p><ul><li>Indoor use</li></ul>";
const packet: Packet = { existingIssues: [], variants: [], manualFieldPaths: [], blockedFields: [], facts: [
  { id: "title", path: "title", value: "Terracotta Pot", variantId: null, origin: "SUPPLIER_FACT", evidence: [], transformations: [], configuration: [] },
  { id: "description", path: "descriptionHtml", value: description, variantId: null, origin: "SUPPLIER_FACT", evidence: [], transformations: [], configuration: [] },
  { id: "colour", path: "attributes.colour", value: "terracota", variantId: null, origin: "SUPPLIER_FACT", evidence: [], transformations: [], configuration: [] }
] };
const field = (changes: Partial<Candidate["fields"][number]> = {}): Candidate => ({ fields: [{ path: "descriptionHtml", value: description, factIds: ["description"], origin: "SUPPLIER_FACT", confidence: 100, ...changes }], issues: [] });
it("preserves whole paragraphs, lists, warnings and negations with exact fact references", () => {
  const result = validateCandidate(stubOutput(packet), packet, testPolicy);
  expect(result.accepted.find(f => f.path === "descriptionHtml")?.value).toBe(description);
  expect(result.withheld[0]?.path).toBe("categoryKey");
  expect(measureValidation(result, { supported: ["Terracotta Pot", description, "terracota"], requiredQualifications: ["not frost-proof", "Bring indoors below 0 °C"] })).toEqual({
    acceptedClaims: 4, supportedClaimPrecision: 1, qualificationRetention: 1, fieldCoverage: 0.8, withheldFields: 1, abstainedFields: ["categoryKey"] });
});
it.each(["<p>Frost-proof.</p>", "<p>Frost-resistant.</p>", "Handmade organic dishwasher-safe pot", "Compatible with all heaters", "20 cm", "not frost-proof"])("withholds unsupported or incomplete wording even at confidence 100: %s", value => {
  const result = validateCandidate(field({ value }), packet, testPolicy);
  expect(result.accepted).toHaveLength(0); expect(result.issues).toContainEqual({ code: "UNSUPPORTED_CLAIM", field: "descriptionHtml" });
});
it.each(["AI_WORDING", "INFERRED_SUGGESTION"] as const)("never accepts %s as proven supplier fact", origin => {
  expect(validateCandidate(field({ origin }), packet, testPolicy).withheld).toHaveLength(1);
});
it("rejects invented citations and citations to another field", () => {
  for (const factIds of [["missing"], ["title"], ["description", "missing"]]) expect(validateCandidate(field({ factIds }), packet, testPolicy).accepted).toHaveLength(0);
});
it("cannot generalize a variant fact to product-wide content", () => {
  const p = structuredClone(packet); p.facts[1]!.variantId = "variant-a";
  expect(validateCandidate(field(), p, testPolicy).accepted).toHaveLength(0);
});
it("cannot resolve conflicts by selecting one row", () => {
  expect(validateCandidate(field(), { ...packet, blockedFields: ["descriptionHtml"] }, testPolicy).accepted).toHaveLength(0);
});
it("configuration values cannot be presented as supplier-provided", () => {
  const p = structuredClone(packet); p.facts[1]!.origin = "CONFIGURATION";
  expect(validateCandidate(field(), p, testPolicy).accepted).toHaveLength(0);
  expect(validateCandidate(field({ origin: "CONFIGURATION" }), p, testPolicy).accepted).toHaveLength(1);
});
it("low confidence requires review independently of evidence correctness", () => {
  expect(validateCandidate(field({ confidence: 84 }), packet, testPolicy).issues).toContainEqual({ code: "LOW_CONFIDENCE", field: "descriptionHtml" });
});
it("rejects duplicate fields rather than choosing first/last", () => {
  const f = field(); f.fields.push(f.fields[0]!);
  expect(validateCandidate(f, packet, testPolicy).accepted).toHaveLength(0);
});
it("rejects arbitrary field paths, unknown keys and invalid confidence", () => {
  expect(validateCandidate(field({ path: "priceMinor" }), packet, testPolicy).accepted).toHaveLength(0);
  expect(candidateSchema.safeParse({ ...field(), executable: "alert(1)" }).success).toBe(false);
  expect(candidateSchema.safeParse(field({ confidence: 101 })).success).toBe(false);
});
it("sanitizes generated HTML again even if a malformed fixture supplies a matching fact", () => {
  const p = structuredClone(packet); p.facts[1]!.value = '<p onclick="attack()">not frost-proof</p>';
  expect(validateCandidate(field({ value: p.facts[1]!.value }), p, testPolicy).accepted).toHaveLength(0);
});
it("validates taxonomy membership instead of trusting provider confidence", () => {
  const p = structuredClone(packet); p.facts[0] = { ...p.facts[0]!, path: "categoryKey", value: "Invented category" };
  expect(validateCandidate(field({ path: "categoryKey", value: "Invented category", factIds: ["title"] }), p, testPolicy).issues).toContainEqual({ code: "INVALID_CATEGORY", field: "categoryKey" });
});
it("cost arithmetic uses exact integer round-up and policies cap spend", () => {
  expect(estimate(3000, 750000) + estimate(1000, 4500000)).toBe(6750);
  expect(estimate(1, 750000)).toBe(1);
  expect(policySchema.safeParse({ ...testPolicy, budgetMicroUsd: 100001 }).success).toBe(false);
  expect(policySchema.safeParse({ ...testPolicy, provider: "gemini", primary: { ...testPolicy.primary, inputMicroUsdPerMillion: 1 } }).success).toBe(false);
});
it("reports abstentions rather than perfect accuracy when no claims pass", () => {
  expect(measureValidation({ accepted: [], withheld: [], issues: [] }, { supported: [], requiredQualifications: [] }).supportedClaimPrecision).toBeNull();
});
it("requires Gemini credentials and project billing confirmation in production without a test fallback", async () => {
  expect(() => geminiPolicyFromEnv({ NODE_ENV: "production" })).toThrow("GEMINI_API_KEY_REQUIRED");
  expect(() => geminiPolicyFromEnv({ GEMINI_API_KEY: "test-key" })).toThrow("GEMINI_BILLING_MUST_BE_DISABLED");
  expect(() => geminiPolicyFromEnv({ GEMINI_API_KEY: "test-key", GEMINI_BILLING_DISABLED: "true", GEMINI_MODEL: "paid-model" })).toThrow("FREE_MODEL_NOT_APPROVED");
  expect(geminiPolicyFromEnv({ GEMINI_API_KEY: "test-key", GEMINI_BILLING_DISABLED: "true" }).budgetMicroUsd).toBe(0);
  const previous = process.env.NODE_ENV; process.env.NODE_ENV = "production";
  try { await expect(testProvider.generate(packet, testPolicy, "test", new AbortController().signal)).rejects.toThrow("TEST_STUB_ONLY"); }
  finally { process.env.NODE_ENV = previous; }
});
it.each(["completed", "refusal", "incomplete", "invalid-json"])("handles Gemini %s through the official SDK adapter", async scenario => {
  const original = globalThis.fetch;
  let request: Record<string, unknown> = {};
  globalThis.fetch = (async (_url, init) => {
    request = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ responseId: "gemini-test-response", modelVersion: "gemini-2.5-flash-lite",
      promptFeedback: scenario === "refusal" ? { blockReason: "SAFETY" } : undefined,
      candidates: [{ finishReason: scenario === "incomplete" ? "MAX_TOKENS" : "STOP", content: { role: "model", parts: [{ text: scenario === "invalid-json" ? "{" : JSON.stringify(stubOutput(packet)) }] } }],
      usageMetadata: { promptTokenCount: 123, candidatesTokenCount: 45, thoughtsTokenCount: 5, totalTokenCount: 173 }
    }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const result = await geminiProvider("test-key", true).generate(packet, testPolicy, "gemini-2.5-flash-lite", new AbortController().signal);
    expect(request.tools).toBeUndefined();
    expect(request.generationConfig).toMatchObject({ responseMimeType: "application/json", responseJsonSchema: { additionalProperties: false }, candidateCount: 1, thinkingConfig: { thinkingBudget: 0 } });
    expect(result.inputTokens).toBe(123); expect(result.outputTokens).toBe(50);
    if (scenario === "completed") expect(result.output).toEqual(stubOutput(packet));
    else expect(result.error).toBe(scenario === "refusal" ? "REFUSAL" : scenario === "incomplete" ? "INCOMPLETE_RESPONSE" : "INVALID_JSON");
  } finally { globalThis.fetch = original; }
});
it.each([401, 403, 429, 503])("records sanitized HTTP %s and disables SDK retries", async status => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify({ error: { code: status, message: "private diagnostic", status: "RESOURCE_EXHAUSTED", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "75s" }] } }), { status, headers: { "content-type": "application/json" } }); }) as typeof fetch;
  try {
    const result = await geminiProvider("test-key", true).generate(packet, testPolicy, "gemini-2.5-flash-lite", new AbortController().signal);
    expect(result.error).toBe(`HTTP_${status}`); expect(JSON.stringify(result)).not.toContain("private diagnostic"); expect(calls).toBe(1);
    if (status === 429) expect(result.retryAfterMs).toBe(75000);
  } finally { globalThis.fetch = original; }
});
it("supports the reviewed Gemini 3.5 model with minimal thinking and the unchanged zero-budget policy", async () => {
  const policy = geminiPolicyFromEnv({ GEMINI_API_KEY: "test-key", GEMINI_BILLING_DISABLED: "true", GEMINI_MODEL: "gemini-3.5-flash-lite" });
  expect(policy.budgetMicroUsd).toBe(0); expect(policy.escalation).toBeNull();
  const original = globalThis.fetch;
  let request: Record<string, unknown> = {};
  globalThis.fetch = (async (_url, init) => { request = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(stubOutput(packet)) }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, thoughtsTokenCount: 5 } }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const response = await geminiProvider("test-key", true).generate(packet, policy, policy.primary.model, new AbortController().signal);
    expect(request.generationConfig).toMatchObject({ thinkingConfig: { thinkingLevel: "MINIMAL" } });
    expect(request.generationConfig).not.toHaveProperty("candidateCount");
    expect(request.generationConfig).not.toHaveProperty("temperature");
    expect(response.outputTokens).toBe(25); expect(response.output).toEqual(stubOutput(packet));
  } finally { globalThis.fetch = original; }
});

it("relaxes only two provider array bounds while preserving the canonical contract", () => {
  const expected = z.toJSONSchema(candidateSchema);
  delete expected.$schema;
  const fields = expected.properties!.fields as typeof expected;
  delete fields.maxItems;
  const item = fields.items as typeof expected;
  delete (item.properties!.factIds as typeof expected).maxItems;
  expect(responseSchema).toEqual(expected);
  const valid = field().fields[0]!;
  expect(candidateSchema.safeParse({ fields: Array(65).fill(valid), issues: [] }).success).toBe(false);
  expect(candidateSchema.safeParse(field({ factIds: Array(101).fill("description") })).success).toBe(false);
  expect(candidateSchema.safeParse(field({ value: "x".repeat(6001) })).success).toBe(false);
  expect(candidateSchema.safeParse({ fields: [], issues: Array(33).fill("issue") }).success).toBe(false);
});
