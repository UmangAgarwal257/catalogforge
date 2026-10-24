import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { getDb, disconnectDatabase } from "@catalogforge/db";
import { createEnrichmentRun, processEnrichmentRun } from "@catalogforge/enrichment";
import { createTerracottaFixture, removeFixture } from "@catalogforge/enrichment/fixture";
import type { Provider } from "@catalogforge/enrichment/providers";
import { testProvider, stubOutput, testPolicy } from "@catalogforge/enrichment/test-stub";
import type { Packet, Policy, Validated } from "@catalogforge/enrichment/contracts";
const db = getDb();
let fixture: Awaited<ReturnType<typeof createTerracottaFixture>>;
beforeEach(async () => { fixture = await createTerracottaFixture(); });
afterEach(async () => { await removeFixture(fixture.storeId); });
afterAll(disconnectDatabase);
const create = (policy: Policy = testPolicy) => createEnrichmentRun(fixture.storeId, fixture.revisionId, policy);
const processRun = (id: string, provider = testProvider, hooks: Parameters<typeof processEnrichmentRun>[3] = {}) => processEnrichmentRun(fixture.storeId, id, provider, hooks);
const revision = () => db.productRevision.findUniqueOrThrow({ where: { id: fixture.revisionId }, include: { variants: true, sourceRows: true } });
const due = async (id: string) => db.aIEnrichmentRun.update({ where: { id }, data: { leaseUntil: new Date(0), nextAttemptAt: new Date(0) } });
it("enriches the real three-row grouped fixture with exact evidence and no changes to variants, sources or existing reasons", async () => {
  const before = await revision(), sources = await db.sourceRow.findMany({ where: { storeId: fixture.storeId }, orderBy: { id: "asc" } });
  const run = await create(), result = await processRun(run.id), after = await revision();
  expect(result.state).toBe("COMPLETED"); expect(after.editVersion).toBe(before.editVersion + 1); expect(after.status).toBe("NEEDS_REVIEW");
  expect(after.variants).toEqual(before.variants); expect(after.sourceRows).toEqual(before.sourceRows);
  expect(after.variants.some(v => v.priceMinor === null)).toBe(true); expect(after.tags).toEqual(["terracota"]); expect(after.categoryKey).toBeNull();
  expect(after.title).toBe("Terracotta Pot"); expect(after.descriptionHtml).toContain("not frost-proof"); expect(after.descriptionHtml).toContain("Bring indoors below 0 °C");
  expect((after.reviewReasons as unknown[]).slice(0, (before.reviewReasons as unknown[]).length)).toEqual(before.reviewReasons);
  expect(await db.sourceRow.findMany({ where: { storeId: fixture.storeId }, orderBy: { id: "asc" } })).toEqual(sources);
  const packet = (run.inputSnapshot as unknown as { packet: Packet }).packet;
  for (const fact of packet.facts) for (const e of fact.evidence) {
    const source = sources.find(s => s.id === e.sourceRowId)!;
    const value = (source.rawCells as unknown as { value: string }[])[e.columnIndex]!.value;
    expect(value.slice(e.start, e.end)).toBe(e.quote); expect(e.cleaningResultId).toBeTruthy();
  }
  const attempt = await db.aIEnrichmentAttempt.findFirstOrThrow({ where: { runId: run.id } });
  expect(attempt.usageKind).toBe("MOCK"); expect(attempt.estimatedMicroUsd).toBe(0);
});
it("deduplicates concurrent creation and processing, including retries after successful application", async () => {
  const runs = await Promise.all(Array.from({ length: 5 }, () => create()));
  expect(new Set(runs.map(r => r.id)).size).toBe(1);
  await Promise.all(runs.map(r => processRun(r.id)));
  const after = await revision();
  await processRun(runs[0]!.id); expect(await revision()).toEqual(after);
  expect(await db.aIEnrichmentAttempt.count({ where: { runId: runs[0]!.id } })).toBe(1);
});
it("preserves manually owned parent/nested fields and markers", async () => {
  await db.productRevision.update({ where: { id: fixture.revisionId }, data: { title: "Merchant title", tags: ["merchant"], attributes: { colour: "Merchant colour" }, manualFieldPaths: ["/title", "attributes.colour", "tags"] } });
  const run = await create(); await processRun(run.id); const after = await revision();
  expect(after.title).toBe("Merchant title"); expect(after.attributes).toEqual({ colour: "Merchant colour" }); expect(after.tags).toEqual(["merchant"]);
  expect(after.manualFieldPaths).toEqual(["/title", "attributes.colour", "tags"]);
});
it.each(["merchant", "published", "archived", "variant", "cleaner"])("rejects stale inputs after provider generation: %s", async change => {
  const before = await revision(), run = await create();
  const result = await processRun(run.id, testProvider, { beforeApply: async () => {
    if (change === "merchant") await db.productRevision.update({ where: { id: fixture.revisionId }, data: { title: "Changed", editVersion: { increment: 1 } } });
    if (change === "published") await db.product.update({ where: { id: fixture.productId }, data: { publishedRevisionId: fixture.revisionId } });
    if (change === "archived") await db.product.update({ where: { id: fixture.productId }, data: { archivedAt: new Date() } });
    if (change === "variant") await db.variantRevision.update({ where: { productRevisionId_variantId: { productRevisionId: fixture.revisionId, variantId: before.variants[0]!.variantId } }, data: { priceMinor: 999n } });
    if (change === "cleaner") await db.rowCleaningResult.update({ where: { id: before.sourceRows[0]!.cleaningResultId! }, data: { outcome: "FAILED" } });
  } });
  expect(result.state).toBe("STALE"); expect((await revision()).tags).toEqual(before.tags);
});
it("preserves an existing published snapshot and pointer while enriching a separate proposal", async () => {
  const published = await db.productRevision.create({ data: { storeId: fixture.storeId, productId: fixture.productId, title: "Published original", status: "APPROVED", manualFieldPaths: ["title"] } });
  await db.product.update({ where: { id: fixture.productId }, data: { publishedRevisionId: published.id } });
  const run = await create(); await processRun(run.id);
  expect(await db.productRevision.findUnique({ where: { id: published.id } })).toEqual(published);
  expect((await db.product.findUniqueOrThrow({ where: { id: fixture.productId } })).publishedRevisionId).toBe(published.id);
});
it.each(["REFUSAL", "HTTP_401", "INVALID_SCHEMA"])("does not alter a proposal on %s", async code => {
  const before = await revision(), run = await create();
  const provider: Provider = { name: "test", async generate() { return code === "INVALID_SCHEMA" ? { output: { title: "broken" }, usageKind: "MOCK" } : { error: code, usageKind: "MOCK" }; } };
  await processRun(run.id, provider); expect(await revision()).toEqual(before);
});
it("persists rate-limit delay and stops after exactly three audited calls", async () => {
  const run = await create(), before = await revision(); let calls = 0;
  const provider: Provider = { name: "test", async generate() { calls++; return { error: "HTTP_429", retryable: true, retryAfterMs: 1234, usageKind: "UNKNOWN" }; } };
  const first = await processRun(run.id, provider); expect(first.state).toBe("RETRY_WAIT"); expect(first.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
  await processRun(run.id, provider); expect(calls).toBe(1);
  await due(run.id); await processRun(run.id, provider); await due(run.id); const last = await processRun(run.id, provider);
  expect(last.state).toBe("FAILED"); expect(calls).toBe(3); expect(await revision()).toEqual(before);
  expect(await db.aIEnrichmentAttempt.count({ where: { runId: run.id } })).toBe(3);
});
it("reuses a saved response after interruption without a second provider charge", async () => {
  const run = await create();
  await expect(processRun(run.id, testProvider, { afterResponseSaved: async () => { throw Error("caller interrupted"); } })).rejects.toThrow("caller interrupted");
  await due(run.id); expect((await processRun(run.id)).state).toBe("COMPLETED");
  expect(await db.aIEnrichmentAttempt.count({ where: { runId: run.id } })).toBe(1);
});
it("fences an expired caller while a replacement completes; no duplicate draft writes", async () => {
  const run = await create(); let release!: () => void, started!: () => void;
  const running = new Promise<void>(r => { started = r; });
  const provider: Provider = { name: "test", async generate(packet) { started(); await new Promise<void>(r => { release = r; }); return { output: stubOutput(packet), usageKind: "MOCK" }; } };
  const original = processRun(run.id, provider); await running; await due(run.id);
  const recovered = await processRun(run.id); expect(recovered.state).toBe("COMPLETED");
  const before = await revision(); release(); await original; expect(await revision()).toEqual(before);
  const attempts = await db.aIEnrichmentAttempt.findMany({ where: { runId: run.id }, orderBy: { number: "asc" } });
  expect(attempts.map(a => a.state)).toEqual(["UNKNOWN", "RESPONSE_SAVED"]);
});
it("rejects any nonzero budget or paid rates before a run is created", async () => {
  await expect(create({ ...testPolicy, budgetMicroUsd: 1 } as unknown as Policy)).rejects.toThrow();
  await expect(create({ ...testPolicy, provider: "gemini", primary: { model: "gemini-2.5-flash-lite", inputMicroUsdPerMillion: 1, outputMicroUsdPerMillion: 0 } })).rejects.toThrow("PAID_API_FORBIDDEN");
  expect(await db.aIEnrichmentRun.count({ where: { storeId: fixture.storeId } })).toBe(0);
});
it("reserves quotas across concurrent runs and preserves real usage independently of zero free-tier price", async () => {
  const policy: Policy = { ...testPolicy, provider: "gemini", primary: { model: "gemini-2.5-flash-lite", inputMicroUsdPerMillion: 0, outputMicroUsdPerMillion: 0 } };
  const first = await create(policy);
  const second = await create({ ...policy, confidenceThreshold: 86 });
  let calls = 0;
  const provider: Provider = { name: "gemini", async generate(packet) { calls++; return { output: stubOutput(packet), inputTokens: 1234, outputTokens: 567, usageKind: "REPORTED", requestId: "isolated-gemini-request" }; } };
  const results = await Promise.all([processRun(first.id, provider), processRun(second.id, provider)]);
  expect(calls).toBe(1);
  // A second caller can be stale if the first applied before its snapshot check,
  // or durably quota-paused if both snapshots preceded application.
  expect(results.filter(r => r.state === "COMPLETED")).toHaveLength(1);
  const a = await db.aIEnrichmentAttempt.findFirstOrThrow({ where: { storeId: fixture.storeId } });
  expect(a.inputTokens).toBe(1234); expect(a.outputTokens).toBe(567); expect(a.usageKind).toBe("REPORTED"); expect(a.estimatedMicroUsd).toBe(0);
  await processRun(first.id, provider); expect(calls).toBe(1);
});
it("pauses daily quota without a request or paid fallback and counts failed/unknown calls", async () => {
  const policy: Policy = { ...testPolicy, provider: "gemini", requestsPerDay: 1, primary: { model: "gemini-2.5-flash-lite", inputMicroUsdPerMillion: 0, outputMicroUsdPerMillion: 0 } };
  const run = await create(policy); let calls = 0;
  const provider: Provider = { name: "gemini", async generate() { calls++; return { error: "HTTP_429", retryable: true, retryAfterMs: 60000, usageKind: "UNKNOWN" }; } };
  await processRun(run.id, provider); await due(run.id);
  const paused = await processRun(run.id, provider);
  expect(paused.state).toBe("RETRY_WAIT"); expect(paused.errorCode).toBe("FREE_TIER_QUOTA");
  expect(paused.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 23 * 3600000); expect(calls).toBe(1);
  const attempt = await db.aIEnrichmentAttempt.findFirstOrThrow({ where: { runId: run.id } }); expect(attempt.estimatedMicroUsd).toBeNull(); expect(attempt.usageKind).toBe("UNKNOWN");
});
it("withholds invented high-confidence claims without accepting or clearing existing issues", async () => {
  const run = await create();
  const provider: Provider = { name: "test", async generate(packet) { const output = stubOutput(packet); output.fields.find(f => f.path === "descriptionHtml")!.value = "<p>Organic, handmade and frost-proof.</p>"; return { output, usageKind: "MOCK" }; } };
  const before = await revision(), result = await processRun(run.id, provider);
  expect((await revision()).descriptionHtml).toBe(before.descriptionHtml);
  expect((result.result as unknown as Validated).withheld.some(f => f.value.includes("Organic"))).toBe(true);
});
it("enforces audit scope, frozen inputs, attempt limit and immutable recorded usage in PostgreSQL", async () => {
  const run = await create();
  await expect(db.aIEnrichmentRun.update({ where: { id: run.id }, data: { inputHash: "b".repeat(64) } })).rejects.toThrow(/immutable/);
  await expect(db.aIEnrichmentRun.create({ data: { revisionId: fixture.revisionId, productId: crypto.randomUUID(), storeId: fixture.storeId, inputHash: "b".repeat(64), policyHash: "c".repeat(64), inputSnapshot: {}, policySnapshot: {} } })).rejects.toThrow(/Foreign key/);
  await expect(db.aIEnrichmentAttempt.create({ data: { runId: run.id, storeId: crypto.randomUUID(), number: 1, fence: 1, model: "test", reservedMicroUsd: 0 } })).rejects.toThrow(/Foreign key/);
  await expect(db.aIEnrichmentAttempt.create({ data: { runId: run.id, storeId: fixture.storeId, number: 4, fence: 1, model: "test", reservedMicroUsd: 0 } })).rejects.toThrow();
  await processRun(run.id);
  const attempt = await db.aIEnrichmentAttempt.findFirstOrThrow({ where: { runId: run.id } });
  await expect(db.aIEnrichmentAttempt.update({ where: { id: attempt.id }, data: { estimatedMicroUsd: 99 } })).rejects.toThrow(/immutable/);
  await expect(db.aIEnrichmentRun.update({ where: { id: run.id }, data: { state: "PENDING" } })).rejects.toThrow(/immutable/);
  await expect(processEnrichmentRun(crypto.randomUUID(), run.id, testProvider)).rejects.toThrow();
});
it("uses at most one configured escalation for supported low-confidence wording", async () => {
  const policy = { ...testPolicy, escalation: { model: "stronger-mock", inputMicroUsdPerMillion: 0, outputMicroUsdPerMillion: 0 } };
  const run = await create(policy); const models: string[] = [];
  const provider: Provider = { name: "test", async generate(packet, _policy, model) {
    models.push(model); const output = stubOutput(packet); if (model !== "stronger-mock") output.fields[0]!.confidence = 50;
    return { output, usageKind: "MOCK" };
  } };
  expect((await processRun(run.id, provider)).state).toBe("RETRY_WAIT"); await due(run.id);
  expect((await processRun(run.id, provider)).state).toBe("COMPLETED"); expect(models).toEqual(["deterministic-test-v1", "stronger-mock"]);
});
it("does not pay for escalation to repair unsupported facts", async () => {
  const run = await create({ ...testPolicy, escalation: { model: "stronger-mock", inputMicroUsdPerMillion: 0, outputMicroUsdPerMillion: 0 } });
  const provider: Provider = { name: "test", async generate(packet) { const output = stubOutput(packet); output.fields[0]!.confidence = 20;
    output.fields[1]!.value = "Frost-proof"; return { output, usageKind: "MOCK" }; } };
  expect((await processRun(run.id, provider)).state).toBe("COMPLETED"); expect(await db.aIEnrichmentAttempt.count({ where: { runId: run.id } })).toBe(1);
});
it("rejects unrelated same-store supplier evidence and another store before any provider call", async () => {
  const supplier = await db.supplier.create({ data: { storeId: fixture.storeId, name: "Unrelated" } });
  const imported = await db.import.create({ data: { storeId: fixture.storeId, supplierId: supplier.id, originalFilename: "unrelated.csv", storageKey: crypto.randomUUID(), fileSha256: "c".repeat(64), idempotencyKey: crypto.randomUUID(), parserVersion: "test" } });
  const source = await db.sourceRow.create({ data: { storeId: fixture.storeId, importId: imported.id, sheetIndex: 0, sheetName: "Other", rowNumber: 1, rawCells: [] } });
  const cleaned = await db.rowCleaningResult.create({ data: { sourceRowId: source.id, storeId: fixture.storeId, cleanerVersion: "test", configHash: "c".repeat(64), configSnapshot: {}, normalized: {}, evidence: {}, issues: [], outcome: "FAILED" } });
  await db.revisionSourceRow.create({ data: { productRevisionId: fixture.revisionId, sourceRowId: source.id, storeId: fixture.storeId, cleaningResultId: cleaned.id } });
  await expect(create()).rejects.toThrow("EVIDENCE_OWNERSHIP");
  await expect(createEnrichmentRun(crypto.randomUUID(), fixture.revisionId, testPolicy)).rejects.toThrow();
});
it("rejects modified cleaning interpretations before creating a run even when their values remain valid", async () => {
  const source = await db.revisionSourceRow.findFirstOrThrow({ where: { productRevisionId: fixture.revisionId } });
  await db.rowCleaningResult.update({ where: { id: source.cleaningResultId! }, data: { createdAt: new Date(0) } });
  await expect(create()).rejects.toThrow("GROUPING_INPUT_CHANGED"); expect(await db.aIEnrichmentRun.count({ where: { storeId: fixture.storeId } })).toBe(0);
});
it("rolls back draft writes on transaction interruption and reuses the durable response on retry", async () => {
  const before = await revision(), run = await create();
  await expect(processRun(run.id, testProvider, { beforeCommit: async () => { throw Error("commit interrupted"); } })).rejects.toThrow("commit interrupted");
  expect(await revision()).toEqual(before); await due(run.id);
  expect((await processRun(run.id)).state).toBe("COMPLETED");
  expect(await db.aIEnrichmentAttempt.count({ where: { runId: run.id } })).toBe(1);
});
