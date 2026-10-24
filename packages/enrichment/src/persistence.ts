import { nextGeminiCapacity } from "./quota";
import { getDb } from "@catalogforge/db";
import { z } from "zod";
import { policySchema, PROMPT_VERSION, VALIDATOR_VERSION, candidateSchema, estimate, EnrichmentError, type Packet, type Policy } from "./contracts";
import { hash, json, owned, snapshot } from "./input";
import { inputBound, type Provider, type ProviderResult } from "./providers";
import { validateCandidate } from "./validation";
import { FREE_MODELS } from "./config";
const db = () => getDb();
const terminal = ["COMPLETED", "FAILED", "BUDGET_EXHAUSTED", "STALE"];
const invalidInput = (error: unknown) => error instanceof EnrichmentError || error instanceof z.ZodError ||
  (typeof error === "object" && error !== null && "code" in error && error.code === "P2025");
export async function createEnrichmentRun(storeId: string, revisionId: string, policyInput: unknown) {
  z.uuid().parse(storeId); z.uuid().parse(revisionId);
  const policy = policySchema.parse(policyInput);
  if (policy.provider === "test" && process.env.NODE_ENV !== "test") throw new EnrichmentError("TEST_STUB_ONLY");
  if (policy.provider === "gemini" && !(FREE_MODELS as readonly string[]).includes(policy.primary.model)) throw new EnrichmentError("FREE_MODEL_NOT_APPROVED");
  const input = await snapshot(storeId, revisionId);
  if (inputBound(input.packet, policy) > policy.maxInputBytes) throw new EnrichmentError("INPUT_BUDGET_EXCEEDED");
  if (policy.provider === "gemini" && inputBound(input.packet, policy) > policy.inputTokensPerMinute) throw new EnrichmentError("TOKEN_QUOTA_EXCEEDED");
  const inputHash = hash(input), policySnapshot = { ...policy, promptVersion: PROMPT_VERSION, validatorVersion: VALIDATOR_VERSION };
  const policyHash = hash(policySnapshot);
  await db().aIEnrichmentRun.createMany({ data: [{ revisionId, productId: input.product.id, storeId, inputHash, policyHash, inputSnapshot: json(input), policySnapshot: json(policySnapshot) }], skipDuplicates: true });
  return db().aIEnrichmentRun.findUniqueOrThrow({ where: { revisionId_inputHash_policyHash: { revisionId, inputHash, policyHash } } });
}
export async function processEnrichmentRun(storeId: string, runId: string, provider: Provider, hooks: { beforeApply?: () => Promise<void>; afterResponseSaved?: () => Promise<void>; beforeCommit?: () => Promise<void> } = {}) {
  // Claim under a row lock. An expired provider call retains its full reservation.
  const claimed = await db().$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "AIEnrichmentRun" WHERE id = ${runId}::uuid AND "storeId" = ${storeId}::uuid FOR UPDATE`;
    const run = await tx.aIEnrichmentRun.findFirstOrThrow({ where: { id: runId, storeId } });
    if (terminal.includes(run.state) || (run.leaseUntil && run.leaseUntil > new Date()) || (run.nextAttemptAt && run.nextAttemptAt > new Date())) return null;
    const fence = run.fence + 1;
    return tx.aIEnrichmentRun.update({ where: { id: runId }, data: { fence, state: "RUNNING", leaseUntil: new Date(Date.now() + 90000), nextAttemptAt: null } });
  });
  if (!claimed) return db().aIEnrichmentRun.findFirstOrThrow({ where: { id: runId, storeId } });
  const { promptVersion, validatorVersion, ...storedPolicy } = z.record(z.string(), z.unknown()).parse(claimed.policySnapshot);
  if (promptVersion !== PROMPT_VERSION || validatorVersion !== VALIDATOR_VERSION) throw new EnrichmentError("UNSUPPORTED_RUN_VERSION");
  const policy = policySchema.parse(storedPolicy);
  if (provider.name !== policy.provider) throw new EnrichmentError("PROVIDER_MISMATCH");
  const packet = (claimed.inputSnapshot as unknown as { packet: Packet }).packet;
  const finish = async (state: string, errorCode: string) => db().aIEnrichmentRun.updateMany({ where: { id: runId, fence: claimed.fence, state: "RUNNING" }, data: { state, errorCode, finishedAt: new Date(), leaseUntil: null } });
  try {
    if (hash(await snapshot(storeId, claimed.revisionId)) !== claimed.inputHash) { await finish("STALE", "INPUT_CHANGED"); return read(); }
  } catch (error) { if (!invalidInput(error)) throw error; await finish("STALE", "INPUT_CHANGED"); return read(); }
  let attempts = await db().aIEnrichmentAttempt.findMany({ where: { runId }, orderBy: { number: "asc" } });
  // A recorded response can be applied after a caller/DB failure without paying again.
  let response = attempts.find(a => a.state === "RESPONSE_SAVED");
  if (!response) {
    if (attempts.length >= 3) { await finish("FAILED", "ATTEMPTS_EXHAUSTED"); return read(); }
    const escalated = attempts.some(a => a.errorCode === "LOW_CONFIDENCE") && policy.escalation;
    const rate = escalated || policy.primary;
    const reserve = estimate(inputBound(packet, policy), rate.inputMicroUsdPerMillion) + estimate(policy.maxOutputTokens, rate.outputMicroUsdPerMillion);
    const spent = attempts.reduce((n, a) => n + (a.estimatedMicroUsd ?? a.reservedMicroUsd), 0);
    if (spent + reserve > policy.budgetMicroUsd) { await finish("BUDGET_EXHAUSTED", "RUN_BUDGET"); return read(); }
    const attempt = await db().$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "AIEnrichmentRun" WHERE id = ${runId}::uuid FOR UPDATE`;
      const fresh = await tx.aIEnrichmentRun.findUniqueOrThrow({ where: { id: runId } });
      if (fresh.fence !== claimed.fence || fresh.state !== "RUNNING") throw new EnrichmentError("FENCED");
      if (provider.name === "gemini") {
        const next = await nextGeminiCapacity(tx, policy);
        if (next) {
          await tx.aIEnrichmentRun.update({ where: { id: runId }, data: { state: "RETRY_WAIT", errorCode: "FREE_TIER_QUOTA", nextAttemptAt: next, leaseUntil: null } });
          return null;
        }
      }
      await tx.aIEnrichmentAttempt.updateMany({ where: { runId, state: "STARTED" }, data: { state: "UNKNOWN", errorCode: "INTERRUPTED", finishedAt: new Date() } });
      return tx.aIEnrichmentAttempt.create({ data: { runId, storeId, number: attempts.length + 1, fence: claimed.fence, model: rate.model, reservedMicroUsd: reserve } });
    });
    if (!attempt) return read();
    const started = performance.now();
    let result: ProviderResult;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      result = await Promise.race([provider.generate(packet, policy, rate.model, controller.signal), new Promise<ProviderResult>(resolve => controller.signal.addEventListener("abort", () => resolve({ error: "TIMEOUT", retryable: true, usageKind: "UNKNOWN" }), { once: true }))]);
    } catch { result = { error: "PROVIDER_ERROR", retryable: true, usageKind: "UNKNOWN" }; }
    finally { clearTimeout(timer); }
    const latencyMs = Math.ceil(performance.now() - started);
    if ((await db().aIEnrichmentRun.findUniqueOrThrow({ where: { id: runId } })).fence !== claimed.fence) return read();
    if (!result.error && !candidateSchema.safeParse(result.output).success) result = { ...result, error: "INVALID_SCHEMA", retryable: true };
    const known = result.usageKind === "MOCK" || (Number.isSafeInteger(result.inputTokens) && Number.isSafeInteger(result.outputTokens) && result.inputTokens! >= 0 && result.outputTokens! >= 0);
    const cost = result.usageKind === "MOCK" ? 0 : known ? estimate(result.inputTokens!, rate.inputMicroUsdPerMillion) + estimate(result.outputTokens!, rate.outputMicroUsdPerMillion) : null;
    response = await db().aIEnrichmentAttempt.update({ where: { id: attempt.id }, data: {
      state: result.error ? "ERROR" : "RESPONSE_SAVED", usageKind: known ? result.usageKind : "UNKNOWN",
      inputTokens: known ? result.inputTokens : undefined, outputTokens: known ? result.outputTokens : undefined,
      estimatedMicroUsd: cost, model: result.model ?? rate.model, requestId: result.requestId, latencyMs,
      output: result.output === undefined ? undefined : json(result.output), errorCode: result.error, finishedAt: new Date()
    } });
    // A response recorded before a new lease cannot apply or schedule new work.
    if ((await db().aIEnrichmentRun.findUniqueOrThrow({ where: { id: runId } })).fence !== claimed.fence) return read();
    if (cost !== null && cost > reserve) { await finish("BUDGET_EXHAUSTED", "RESERVATION_EXCEEDED"); return read(); }
    if (result.error) {
      if (!result.retryable || attempt.number >= 3) await finish("FAILED", result.error);
      else await delay(result.error, result.retryAfterMs ?? Math.min(60000, 1000 * 2 ** (attempt.number - 1)) + Math.floor(Math.random() * 500));
      return read();
    }
    await hooks.afterResponseSaved?.();
  }
  const validated = validateCandidate(response.output, packet, policy);
  attempts = await db().aIEnrichmentAttempt.findMany({ where: { runId } });
  if (validated.issues.some(i => i.code === "LOW_CONFIDENCE") && !validated.issues.some(i => ["UNSUPPORTED_CLAIM", "UNRESOLVED_SOURCE", "EVIDENCE_SCOPE", "UNSAFE_DESCRIPTION"].includes(i.code)) && policy.escalation && attempts.length < 3 && !attempts.some(a => a.model === policy.escalation!.model)) {
    await db().aIEnrichmentAttempt.update({ where: { id: response.id }, data: { state: "ERROR", errorCode: "LOW_CONFIDENCE" } });
    await delay("LOW_CONFIDENCE", 1000); return read();
  }
  await hooks.beforeApply?.();
  await db().$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Product" WHERE id = ${claimed.productId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "ProductRevision" WHERE id = ${claimed.revisionId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "variantId" FROM "VariantRevision" WHERE "productRevisionId" = ${claimed.revisionId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM "AIEnrichmentRun" WHERE id = ${runId}::uuid FOR UPDATE`;
    const current = await tx.aIEnrichmentRun.findUniqueOrThrow({ where: { id: runId } });
    if (current.fence !== claimed.fence || current.state !== "RUNNING") return;
    // Reads must use this transaction; avoid a second pool connection with locks.
    const revision = await tx.productRevision.findUniqueOrThrow({ where: { id: claimed.revisionId } });
    const links = await tx.revisionSourceRow.findMany({ where: { productRevisionId: claimed.revisionId } });
    for (const link of links) if (link.cleaningResultId) await tx.$queryRaw`SELECT id FROM "RowCleaningResult" WHERE id = ${link.cleaningResultId}::uuid FOR SHARE`;
    let unchanged = false;
    try { unchanged = hash(await snapshot(storeId, claimed.revisionId, tx)) === claimed.inputHash; }
    catch (error) { if (!invalidInput(error)) throw error; /* Unusable evidence is stale; infrastructure errors propagate. */ }
    if (!unchanged) {
      await tx.aIEnrichmentRun.update({ where: { id: runId }, data: { state: "STALE", errorCode: "INPUT_CHANGED", leaseUntil: null, finishedAt: new Date() } }); return;
    }
    const update: { title?: string; descriptionHtml?: string; categoryKey?: string; tags?: string[]; attributes?: ReturnType<typeof json> } = {};
    const attributes = z.record(z.string(), z.unknown()).parse(revision.attributes);
    const tags: string[] = [];
    validated.applied = [];
    for (const f of validated.accepted) {
      const parent = f.path.split(".")[0]!;
      if (owned(revision.manualFieldPaths, f.path) || owned(revision.manualFieldPaths, parent)) { validated.issues.push({ code: "MANUAL_OVERRIDE_PRESERVED", field: f.path }); continue; }
      if (f.path === "title" || f.path === "descriptionHtml" || f.path === "categoryKey") update[f.path] = f.value;
      else if (f.path.startsWith("attributes.")) { attributes[f.path.slice(11)] = f.value; update.attributes = json(attributes); }
      else if (f.path.startsWith("tags.")) tags.push(f.value);
      validated.applied.push(f);
    }
    if (tags.length && !owned(revision.manualFieldPaths, "tags")) update.tags = [...new Set([...revision.tags, ...tags])];
    const reasons = [...z.array(z.unknown()).parse(revision.reviewReasons), { code: "AI_REVIEW_REQUIRED", runId }, ...validated.issues];
    await tx.productRevision.update({ where: { id: revision.id, editVersion: revision.editVersion }, data: { ...update, status: "NEEDS_REVIEW", editVersion: { increment: 1 }, reviewReasons: json(reasons) } });
    await hooks.beforeCommit?.();
    await tx.aIEnrichmentRun.update({ where: { id: runId }, data: { state: "COMPLETED", errorCode: null, nextAttemptAt: null, result: json(validated), leaseUntil: null, finishedAt: new Date() } });
  });
  return read();
  function read() { return db().aIEnrichmentRun.findFirstOrThrow({ where: { id: runId, storeId } }); }
  async function delay(errorCode: string, milliseconds: number) {
    await db().aIEnrichmentRun.updateMany({ where: { id: runId, fence: claimed!.fence, state: "RUNNING" }, data: { state: "RETRY_WAIT", errorCode, leaseUntil: null, nextAttemptAt: new Date(Date.now() + milliseconds) } });
  }
}
export async function runUntilSettled(storeId: string, runId: string, provider: Provider) {
  for (;;) {
    const run = await processEnrichmentRun(storeId, runId, provider);
    if (terminal.includes(run.state)) return run;
    const due = run.nextAttemptAt ?? run.leaseUntil;
    // Return durable paused work to the caller rather than keeping a command
    // alive until tomorrow. Resume explicitly with the same run ID when due.
    if (run.state === "RETRY_WAIT") return run;
    await new Promise(resolve => setTimeout(resolve, Math.min(1000, Math.max(25, (due?.getTime() ?? Date.now()) - Date.now()))));
  }
}
export type { Policy };
