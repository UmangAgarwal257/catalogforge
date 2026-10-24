/** Local, isolated measurements. No real provider calls or shared Redis changes. */
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { getDb, disconnectDatabase } from "@catalogforge/db";
import { registerImport } from "@catalogforge/ingestion/imports";
import { processParseImport } from "@catalogforge/ingestion/processing";
import { LocalOriginalStorage } from "@catalogforge/ingestion/storage";
import { processCatalogTask } from "@catalogforge/pipeline";
import { SUPPLIER_PROFILES } from "@catalogforge/shared/catalog";
import { removeFixture } from "@catalogforge/enrichment/fixture";
import { geminiPolicyFromEnv } from "@catalogforge/enrichment/config";
import type { Provider } from "@catalogforge/enrichment/providers";

const rssMiB = () => Number(/VmHWM:\s+(\d+)/.exec(readFileSync("/proc/self/status", "utf8"))![1]) / 1024;
const argument = (name: string):string => { const value=process.argv[process.argv.indexOf(name)+1]; if(!value)throw Error(`Missing ${name}`);return value; };
const round = (n: number) => Math.round(n * 1000) / 1000;
function record(index: number, profile: number): string[] {
  const family = Math.floor(index / 2), position = index % 2, variant = family % 5 === 0 ? 0 : position;
  const category = family % 3;
  const title = ["Cotton shirt", "Ceramic mug", "USB-C cable"][category]!;
  const description = ["<p>Wash cold. Do not tumble dry.</p>", "<p>Hand wash only. Not microwave safe.</p>", "<p>USB-C to USB-C. Not for charging laptops.</p>"][category]!;
  const price = family % 11 === 0 && variant === 1 ? "" : family % 13 === 0 && position === 1 ? profile ? "99.00" : "99,00" : profile ? "12.50" : "12,50";
  return [`BENCH-${family}-${variant}`, `FAMILY-${family}`, `${title} ${family}`, description, price, profile ? "GBP" : "EUR", profile ? "250" : "0,25", String(variant), "Blue", ["Cotton", "Ceramic", "Nylon"][category]!];
}
async function child() {
  assert.equal(process.env.NODE_ENV, "test");
  assert.ok(!process.env.GEMINI_API_KEY, "Benchmark requires an empty live credential override");
  const storeId = argument("--store"), importId = argument("--import"), directory = argument("--storage");
  const count = Number(argument("--rows")), initial = argument("--mode") === "initial";
  const db = getDb();
  let cleanEnd = 0, groupEnd = 0, providerCalls = 0;
  const operations: Record<string, number> = {};
  const measured = db.$extends({ query: { $allModels: { async $allOperations({ model, operation, args, query }) {
    const key = `${model}.${operation}`; operations[key] = (operations[key] ?? 0) + 1;
    const result = await query(args);
    if (model === "CatalogTask" && operation === "updateMany") {
      const phase = (args as { data: { phase?: unknown } }).data.phase;
      if (phase === "GROUPING") cleanEnd = performance.now();
      if (phase === "ENRICHMENT") groupEnd = performance.now();
    }
    return result;
  } } } });
  Object.defineProperty(globalThis, "catalogforgeDb", { value: measured, writable: true, configurable: true });
  const parseStart = performance.now();
  if (initial) await processParseImport(importId, storeId, new LocalOriginalStorage(directory));
  const parseMs = initial ? performance.now() - parseStart : null;
  const start = performance.now();
  // Synthetic quota occupancy is isolated in this disposable database. This is
  // a scheduler/backlog benchmark, not evidence of actual Gemini throughput.
  const policy = geminiPolicyFromEnv({ GEMINI_API_KEY: "test-only-no-network", GEMINI_BILLING_DISABLED: "true", GEMINI_MODEL: "gemini-3.5-flash-lite", GEMINI_REQUESTS_PER_DAY: "1" });
  const provider: Provider = { name: "gemini", async generate() { providerCalls++; throw Error("Benchmark must never call a provider"); } };
  const task = await processCatalogTask(storeId, importId, { policy, provider,
    afterCleanBatch: initial ? async n => {
      if (n >= count / 2) {
        console.log(JSON.stringify({ kind: "checkpoint", parseMs: round(parseMs!), partialCleaningMs: round(performance.now() - start), cleaned: n, peakRssMiB: round(rssMiB()), operations }));
        await new Promise<void>(() => {});
      }
    } : undefined,
    afterRunBound: async runId => {
      await db.aIEnrichmentAttempt.create({ data: { runId, storeId, number: 1, fence: 1, model: "isolated-synthetic-quota-occupancy", state: "UNKNOWN", reservedMicroUsd: 0 } });
    }
  });
  const end = performance.now();
  assert.equal(providerCalls, 0);
  assert.equal(task.state, "WAITING");
  assert.equal(task.errorCode, "FREE_TIER_QUOTA");
  console.log(JSON.stringify({ kind: "resumed", cleaningMs: round(cleanEnd - start), groupingMs: round(groupEnd - cleanEnd), schedulingMs: round(end - groupEnd), totalMs: round(end - start), peakRssMiB: round(rssMiB()), providerCalls, operations }));
  await disconnectDatabase();
}
async function runChild(args: string[], env: NodeJS.ProcessEnv, checkpoint: boolean) {
  const start = performance.now();
  const proc = spawn("bun", ["run", "tests/helpers/catalog-benchmark.ts", "--child", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "", killed = false;
  proc.stdout.on("data", b => { output += String(b); if (checkpoint && output.includes('"kind":"checkpoint"') && !killed) { killed = true; proc.kill("SIGKILL"); } });
  proc.stderr.on("data", b => { errors += String(b); });
  const result = await new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject) => { proc.once("error",reject);proc.once("exit",(code,signal)=>resolve({code,signal})); });
  if (checkpoint) assert.equal(result.signal, "SIGKILL", errors);
  else assert.equal(result.code, 0, `${output}\n${errors}`);
  const line = output.trim().split("\n").find(l => l.startsWith('{"kind":'));
  assert.ok(line, errors);
  return { ...JSON.parse(line), processWallMs: round(performance.now() - start) };
}
async function main() {
  const output = argument("--output"), label = argument("--label");
  assert.ok(output && label, "Use --label before|after --output /tmp/results.json");
  const originalUrl = process.env.DATABASE_URL!;
  const database = `catalog_benchmark_${Date.now()}`;
  await getDb().$executeRawUnsafe(`CREATE DATABASE "${database}"`);
  await disconnectDatabase();
  const url = new URL(originalUrl); url.pathname = `/${database}`;
  process.env.DATABASE_URL = url.toString();
  const env = { ...process.env, NODE_ENV: "test", GEMINI_API_KEY: "" };
  const results: unknown[] = [];
  const directory = await mkdtemp(join(tmpdir(), "catalog-measurement-"));
  try {
    const migrate = spawn("bun", ["run", "db:deploy"], { env, stdio: "inherit" });
    assert.equal(await new Promise(r => migrate.once("exit", r)), 0);
    for (const profile of [0, 1]) for (const count of [1000, 10000]) {
      const db = getDb(), storeId = (await db.store.create({ data: { name: "Disposable benchmark" } })).id;
      try {
        const supplierId = (await db.supplier.create({ data: { storeId, name: SUPPLIER_PROFILES[profile]!.name } })).id;
        const records = Array.from({ length: count }, (_, i) => record(i, profile));
        let bytes: Uint8Array;
        if (profile) { const book = new ExcelJS.Workbook(), sheet = book.addWorksheet("Trade goods"); sheet.addRow(SUPPLIER_PROFILES[profile]!.headers); records.forEach(r => sheet.addRow(r)); bytes = new Uint8Array(await book.xlsx.writeBuffer()); }
        else bytes = Buffer.from([SUPPLIER_PROFILES[profile]!.headers, ...records].map(r => r.join(";")).join("\r\n"));
        const imported = (await registerImport(new LocalOriginalStorage(directory), { storeId, supplierId, filename: profile ? "catalog.xlsx" : "catalog.csv", bytes, idempotencyKey: crypto.randomUUID(), profileId: SUPPLIER_PROFILES[profile]!.id })).imported;
        const args = ["--store", storeId, "--import", imported.id, "--storage", directory, "--rows", String(count)];
        const initial = await runChild([...args, "--mode", "initial"], env, true);
        assert.equal(await db.rowCleaningResult.count({ where: { storeId } }), count / 2);
        const preserved = await db.rowCleaningResult.findMany({ where: { storeId }, select: { id: true }, orderBy: { id: "asc" } });
        // Advance only this isolated task's lease; report this separately from
        // restart processing time. The 90-second real expiry is not benchmarked.
        await db.catalogTask.update({ where: { importId: imported.id }, data: { leaseUntil: new Date(0) } });
        const resumed = await runChild([...args, "--mode", "resume"], env, false);
        const rows = await db.sourceRow.findMany({ where: { importId: imported.id }, orderBy: { rowNumber: "asc" } });
        assert.equal(rows.length, count);
        for (const [i, row] of rows.entries()) {
          assert.equal(row.rowNumber, i + 2); assert.equal(row.sheetIndex, 0);
          assert.deepEqual((row.rawCells as {value:unknown;header:string;columnIndex:number}[]).map(c => [c.columnIndex,c.header,c.value]), records[i]!.map((v,j) => [j,SUPPLIER_PROFILES[profile]!.headers[j],v]));
        }
        const counts = {
          sources: rows.length, cleaning: await db.rowCleaningResult.count({ where: { storeId } }), grouped: await db.groupingRowResult.count({ where: { storeId } }),
          products: await db.product.count({ where: { storeId } }), variants: await db.variant.count({ where: { storeId } }), proposals: await db.productRevision.count({ where: { storeId } }),
          snapshots: await db.variantRevision.count({ where: { storeId } }), evidence: await db.revisionSourceRow.count({ where: { storeId } }), pendingGrouping: await db.groupingRowResult.count({ where: { storeId, outcome: "PENDING" } }),
          aiRuns: await db.aIEnrichmentRun.count({ where: { storeId } }), syntheticQuotaReservations: await db.aIEnrichmentAttempt.count({ where: { storeId } }),
          published: await db.product.count({ where: { storeId, publishedRevisionId: { not: null } } })
        };
        assert.deepEqual([counts.sources,counts.cleaning,counts.grouped,counts.evidence], [count,count,count,count]);
        assert.deepEqual([counts.products,counts.proposals,counts.variants,counts.snapshots], [count/2,count/2,count*0.9,count*0.9]);
        assert.equal(counts.pendingGrouping, 0); assert.equal(counts.published, 0);
        assert.equal(await db.rowCleaningResult.count({ where: { id: { in: preserved.map(r => r.id) } } }), count/2);
        const task = await db.catalogTask.findUniqueOrThrow({ where: { importId: imported.id } });
        const manifest = task.runs as Record<string,{runId?:string;blocked?:string}>;
        const blocked = Object.values(manifest).filter(r => r.blocked).length;
        const runStates = await db.aIEnrichmentRun.findMany({ where: { storeId }, select: { id: true, state: true, errorCode: true } });
        const byId = new Map(runStates.map(run => [run.id, run]));
        const proposalOutcomes = { unbound: 0, quotaPaused: 0, successful: 0, failed: 0, stale: 0, blocked: 0, otherBound: 0 };
        assert.equal(Object.keys(manifest).length, counts.proposals);
        for (const entry of Object.values(manifest)) {
          if (entry.blocked) { proposalOutcomes.blocked++; continue; }
          if (!entry.runId) { proposalOutcomes.unbound++; continue; }
          const run = byId.get(entry.runId); assert.ok(run, "Every bound proposal requires a persisted run");
          if (run.state === "RETRY_WAIT" && run.errorCode === "FREE_TIER_QUOTA") proposalOutcomes.quotaPaused++;
          else if (run.state === "COMPLETED") proposalOutcomes.successful++;
          else if (["FAILED", "BUDGET_EXHAUSTED"].includes(run.state)) proposalOutcomes.failed++;
          else if (run.state === "STALE") proposalOutcomes.stale++;
          else proposalOutcomes.otherBound++;
        }
        assert.deepEqual(proposalOutcomes, { unbound: count/2-1, quotaPaused: 1, successful: 0, failed: 0, stale: 0, blocked: 0, otherBound: 0 });
        assert.equal(Object.values(proposalOutcomes).reduce((sum, n) => sum+n, 0), counts.proposals);
        const sample = { proposalOutcomes, label, profile: SUPPLIER_PROFILES[profile]!.id, rows: count, bytes: bytes.length, initial, resumed, counts, awaiting: counts.proposals-blocked, blocked, bound: counts.aiRuns, quotaState: task.errorCode, retryAt: task.nextAttemptAt, liveProviderCalls: 0 };
        results.push(sample); await writeFile(output, JSON.stringify(results, null, 2)); console.log(JSON.stringify(sample));
      } finally { await removeFixture(storeId); }
    }
  } finally {
    await rm(directory, { recursive: true, force: true }); await disconnectDatabase(); process.env.DATABASE_URL = originalUrl;
    await getDb().$executeRawUnsafe(`DROP DATABASE "${database}" WITH (FORCE)`); await disconnectDatabase();
  }
}
if (process.argv.includes("--child")) await child(); else await main();
