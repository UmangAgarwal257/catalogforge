import { Queue, Worker, UnrecoverableError } from "bullmq";
import { Redis } from "ioredis";
import { getDb } from "@catalogforge/db";
import { IngestionError } from "./contracts";
import { failParseRun, processParseImport, RetryableParseError } from "./processing";
import type { OriginalStorage } from "./storage";
import { z } from "zod";

export const PARSE_QUEUE = "spreadsheet-parse-v1";
const jobSchema = z.object({ importId: z.uuid(), storeId: z.uuid() });

export function parseProducer(redisUrl: string, queueName = PARSE_QUEUE) {
  const connection = new Redis(redisUrl, { enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 3000, commandTimeout: 3000 });
  connection.on("error", () => { /* Dispatch records remain durable during outages. */ });
  const queue = new Queue(queueName, { connection });
  queue.on("error", () => { /* The dispatch loop reports failures without credentials. */ });
  return { queue, connection };
}

export async function dispatchPending(queue: Queue, storeId: string): Promise<void> {
  const db = getDb();
  // Page through all nonterminal work rather than starving imports beyond page one.
  let cursor: string | undefined;
  for (;;) {
    const entries = await db.parseDispatch.findMany({
      where: { import: { storeId, status: { in: ["PENDING", "PROCESSING"] } } },
      orderBy: { importId: "asc" }, take: 100,
      ...(cursor ? { cursor: { importId: cursor }, skip: 1 } : {}), include: { import: true }
    });
    if (!entries.length) return;
    for (const entry of entries) {
      try {
        // BullMQ's initial readiness promise can wait forever during an outage.
        // Do not enter it until the reconnecting producer connection is ready.
        if (queue.opts.connection instanceof Redis && queue.opts.connection.status !== "ready") throw new Error("Redis is not ready");
        const job = await queue.getJob(entry.importId);
        const state = await job?.getState();
        if (state === "failed") {
          await failParseRun(entry.importId, entry.import.parseRunId, "PARSE_RETRIES_EXHAUSTED", "Parsing exhausted its retries. Partial source evidence, if any, was retained.");
          continue;
        }
        if (state === "completed") await job?.remove();
        if (!job || state === "completed") {
          await queue.add("parse", { importId: entry.importId, storeId }, {
            jobId: entry.importId, attempts: 3, backoff: { type: "exponential", delay: 1000 },
            removeOnComplete: { age: 86400 }, removeOnFail: { age: 604800 }
          });
        }
        await db.parseDispatch.update({ where: { importId: entry.importId }, data: { dispatchedAt: new Date() } });
        await db.import.updateMany({ where: { id: entry.importId, status: "PENDING", errorCode: "DISPATCH_UNAVAILABLE" }, data: { errorCode: null, errorMessage: null } });
      } catch {
        await db.import.updateMany({ where: { id: entry.importId, status: "PENDING" }, data: {
          errorCode: "DISPATCH_UNAVAILABLE", errorMessage: "Waiting for the parse queue. Dispatch will retry automatically."
        } });
        throw new Error("Parse dispatch unavailable; durable work will be retried.");
      }
    }
    cursor = entries.at(-1)?.importId;
  }
}

export function parseConsumer(redisUrl: string, storeId: string, storage: OriginalStorage, queueName = PARSE_QUEUE, lockDuration = 30000) {
  // connectTimeout only bounds TCP establishment. Bound missing replies too:
  // Bun/ioredis can otherwise remain in `connect` after an interrupted handshake.
  // BullMQ duplicates these options for its blocking connection (max wait: 10s).
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null, connectTimeout: 5000, socketTimeout: 15000 });
  connection.on("error", () => { /* BullMQ reconnects; don't echo connection credentials. */ });
  const worker = new Worker(queueName, async (job) => {
    const parsed = jobSchema.safeParse(job.data);
    if (!parsed.success || parsed.data.storeId !== storeId) throw new UnrecoverableError("Invalid parse-job scope.");
    try { await processParseImport(parsed.data.importId, storeId, storage); }
    catch (error) {
      if (error instanceof IngestionError) throw new UnrecoverableError(`${error.code}: ${error.message}`);
      throw error;
    }
  }, { connection, concurrency: 1, lockDuration, stalledInterval: Math.max(1000, lockDuration) });
  worker.on("error", () => console.error("Parse worker connection or job-lock error; inspect import status."));
  worker.on("failed", (job, error) => {
    if (job && error instanceof RetryableParseError && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      void failParseRun(job.id!, error.runId, "PARSE_RETRIES_EXHAUSTED", "Parsing exhausted its retries; partial evidence was retained.")
        .catch(() => console.error("Parse failure status will be reconciled by dispatch."));
    }
  });
  async function isAvailable(): Promise<boolean> {
    if (!worker.isRunning() || worker.isPaused() || worker.closing || connection.status !== "ready") return false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          const blocking = await worker.getBackend().blockingClient;
          if (blocking?.status !== "ready") return false;
          // Never put health commands behind the dedicated blocking read.
          await connection.ping();
          return worker.isRunning() && !worker.isPaused() && !worker.closing &&
            connection.status === "ready" && blocking.status === "ready";
        })(),
        new Promise<false>((resolve) => { timeout = setTimeout(() => resolve(false), 1000); })
      ]);
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }
  return { worker, connection, isAvailable };
}
