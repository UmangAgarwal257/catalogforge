import { getDb, disconnectDatabase } from "@catalogforge/db";
import { createEnrichmentRun, runUntilSettled } from "@catalogforge/enrichment";
import { createTerracottaFixture, removeFixture, terracottaLabels } from "@catalogforge/enrichment/fixture";
import { geminiProvider } from "@catalogforge/enrichment/providers";
import { geminiPolicyFromEnv } from "@catalogforge/enrichment/config";
import { measureValidation } from "@catalogforge/enrichment/validation";
import type { Validated } from "@catalogforge/enrichment/contracts";

// Explicit one-product command; no HTTP endpoint or bulk scheduling.
let fixture: Awaited<ReturnType<typeof createTerracottaFixture>> | undefined;
try {
  const policy = geminiPolicyFromEnv(process.env);
  const provider = geminiProvider(process.env.GEMINI_API_KEY!, policy.freeTierBillingDisabled);
  const args = process.argv.slice(2);
  if (args.includes("--demo")) fixture = await createTerracottaFixture();
  const storeId = fixture?.storeId ?? args[0];
  if (!storeId) throw Error("USE_--demo_OR_STORE_ID_REVISION_ID_OR_--resume_STORE_ID_RUN_ID");
  const resume = args[0] === "--resume";
  const actualStore = resume ? args[1]! : storeId;
  const runId = resume ? args[2]! : (await createEnrichmentRun(actualStore, fixture?.revisionId ?? args[1]!, policy)).id;
  console.log(JSON.stringify({ enrichmentRunId: runId, provider: policy.provider }));
  const started = performance.now();
  const result = await runUntilSettled(actualStore, runId, provider);
  const attempts = await getDb().aIEnrichmentAttempt.findMany({ where: { runId }, orderBy: { number: "asc" } });
  const revision = await getDb().productRevision.findUniqueOrThrow({ where: { id: result.revisionId }, include: { variants: true } });
  const validated = result.result as unknown as Validated | null;
  console.log(JSON.stringify({ runId, state: result.state, errorCode: result.errorCode, elapsedMs: Math.ceil(performance.now() - started), nextAttemptAt: result.nextAttemptAt,
    product: { title: revision.title, descriptionHtml: revision.descriptionHtml, categoryKey: revision.categoryKey, tags: revision.tags, attributes: revision.attributes,
      variants: revision.variants.map(v => ({ priceMinor: v.priceMinor?.toString() ?? null, currency: v.currency, options: v.options })) },
    fields: validated, attempts: attempts.map(a => ({ number: a.number, model: a.model, state: a.state, errorCode: a.errorCode,
      inputTokens: a.inputTokens, outputTokens: a.outputTokens, usageKind: a.usageKind, estimatedMicroUsd: a.estimatedMicroUsd, reservedMicroUsd: a.reservedMicroUsd, latencyMs: a.latencyMs })),
    metrics: validated && fixture ? measureValidation(validated, terracottaLabels) : null
  }, null, 2));
  if (result.state !== "COMPLETED") process.exitCode = result.state === "RETRY_WAIT" ? 2 : 1;
} catch (error) {
  // Configuration errors report their kind, never environment contents or provider messages.
  console.error(error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "ENRICHMENT_COMMAND_FAILED");
  process.exitCode = 1;
} finally { if (fixture) await removeFixture(fixture.storeId); await disconnectDatabase(); }
