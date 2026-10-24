import { catalogProducer, catalogConsumer, dispatchCatalog } from "@catalogforge/pipeline/queue";
import { Redis } from "ioredis";
import { disconnectDatabase } from "@catalogforge/db";
import { env } from "./env";
import { checkReadiness } from "./health";
import { parseProducer, parseConsumer, dispatchPending } from "@catalogforge/ingestion/queue";
import { createOriginalStorage, SupabaseOriginalStorage } from "@catalogforge/ingestion/storage";
import { geminiPolicyFromEnv } from "@catalogforge/enrichment/config";

const redis = new Redis(env.REDIS_URL, {
  lazyConnect: true,
  enableOfflineQueue: false,
  connectTimeout: 5000,
  commandTimeout: 5000,
  maxRetriesPerRequest: 1,
  retryStrategy: (attempt) => Math.min(attempt * 250, 5000)
});
redis.on("error", () => console.error("Worker Redis connection error; check the configured Redis service."));

let server: ReturnType<typeof Bun.serve> | undefined;
let shuttingDown = false;
let producer: ReturnType<typeof parseProducer> | undefined;
let consumer: ReturnType<typeof parseConsumer> | undefined;
let catalogDispatch: ReturnType<typeof catalogProducer> | undefined;
let catalogWorker: ReturnType<typeof catalogConsumer> | undefined;
let dispatchTimer: ReturnType<typeof setInterval> | undefined;
let dispatching: Promise<void> | undefined;

async function shutdown(exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  // A broken connection must not hold shutdown open indefinitely.
  const deadline = setTimeout(() => process.exit(1), 10000);
  try {
    clearInterval(dispatchTimer);
    await server?.stop(true);
    await dispatching;
    await Promise.all([consumer?.worker.close(), catalogWorker?.worker.close()]);
    await Promise.all([producer?.queue.close(), catalogDispatch?.queue.close()]);
    catalogWorker?.connection.disconnect();
    catalogDispatch?.connection.disconnect();
    consumer?.connection.disconnect();
    producer?.connection.disconnect();
    redis.disconnect();
    await disconnectDatabase();
    console.info("Worker stopped.");
    process.exitCode = exitCode;
  } catch {
    console.error("Worker shutdown failed.");
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
  }
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

try {
  await redis.connect();
  if ((await checkReadiness(redis)).status !== "ok") throw new Error("Dependencies unavailable");
  const processingStoreId = env.WORKER_STORE_ID;
  if (!processingStoreId) throw new Error("WORKER_STORE_ID is required for the catalog worker.");
  geminiPolicyFromEnv(process.env);
  const storage = createOriginalStorage();
  if (storage instanceof SupabaseOriginalStorage) await storage.ensurePrivateBucket();
  const parseQueue = `spreadsheet-${processingStoreId}-v1`;
  producer = parseProducer(env.REDIS_URL, parseQueue);
  consumer = parseConsumer(env.REDIS_URL, processingStoreId, storage, parseQueue);
  catalogDispatch = catalogProducer(env.REDIS_URL, processingStoreId);
  catalogWorker = catalogConsumer(env.REDIS_URL, processingStoreId);
  await Promise.all([consumer.worker.waitUntilReady(), catalogWorker.worker.waitUntilReady()]);
  const tick = () => {
    if (dispatching || shuttingDown) return;
    dispatching = Promise.allSettled([dispatchPending(producer!.queue, processingStoreId), dispatchCatalog(catalogDispatch!.queue, processingStoreId)]).then(results => { if (results.some(result => result.status === "rejected")) throw new Error("Dispatch temporarily unavailable"); })
      .catch(() => console.error("Worker dispatch is temporarily unavailable; durable work is retained."))
      .finally(() => { dispatching = undefined; });
  };
  tick();
  dispatchTimer = setInterval(tick, 5000);
  if (!shuttingDown) {
    server = Bun.serve({
      hostname: "0.0.0.0",
      port: Number(process.env.PORT ?? env.WORKER_HEALTH_PORT),
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/health") return Response.json({ status: "ok" });
        if (path === "/ready") {
          const health = await checkReadiness(redis, consumer && catalogWorker ? {isAvailable: async () => (await Promise.all([consumer!.isAvailable(), catalogWorker!.isAvailable()])).every(Boolean)} : consumer, shuttingDown);
          return Response.json(health, { status: health.status === "ok" ? 200 : 503 });
        }
        return new Response("Not found", { status: 404 });
      }
    });
    console.info(`Worker ready: PostgreSQL and Redis connected. Health port ${process.env.PORT ?? env.WORKER_HEALTH_PORT}.`);
    console.info("Configured store pipeline enabled. Import completion means parsing only.");
  }
} catch {
  console.error("Worker startup failed. Check configuration, PostgreSQL, Redis, and the health port.");
  await shutdown(1);
}
