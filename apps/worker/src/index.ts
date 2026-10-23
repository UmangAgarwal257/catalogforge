import { Redis } from "ioredis";
import { disconnectDatabase } from "@catalogforge/db";
import { env } from "./env";
import { checkReadiness } from "./health";
import { parseProducer, parseConsumer, dispatchPending } from "@catalogforge/ingestion/queue";
import { LocalOriginalStorage } from "@catalogforge/ingestion/storage";
import { localSettingsSchema } from "@catalogforge/ingestion/contracts";

const redis = new Redis(env.REDIS_URL, {
  lazyConnect: true,
  enableOfflineQueue: false,
  connectTimeout: 5000,
  commandTimeout: 5000,
  maxRetriesPerRequest: 1,
  retryStrategy: (attempt) => Math.min(attempt * 250, 5000)
});
redis.on("error", () => console.error("Worker Redis connection error; check local infrastructure."));

let server: ReturnType<typeof Bun.serve> | undefined;
let shuttingDown = false;
let producer: ReturnType<typeof parseProducer> | undefined;
let consumer: ReturnType<typeof parseConsumer> | undefined;
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
    await consumer?.worker.close();
    await producer?.queue.close();
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
  if (process.env.DEV_INGESTION_ENABLED === "true") {
    if (process.env.NODE_ENV === "production" || process.env.VERCEL) throw new Error("Local ingestion cannot run in production.");
    const config = localSettingsSchema.safeParse(process.env);
    if (!config.success) throw new Error("Set DEV_STORE_ID and an absolute LOCAL_UPLOAD_DIR.");
    const storage = new LocalOriginalStorage(config.data.LOCAL_UPLOAD_DIR);
    producer = parseProducer(env.REDIS_URL);
    consumer = parseConsumer(env.REDIS_URL, config.data.DEV_STORE_ID, storage);
    await consumer.worker.waitUntilReady();
    const tick = () => {
      if (dispatching || shuttingDown) return;
      dispatching = dispatchPending(producer!.queue, config.data.DEV_STORE_ID)
        .catch(() => console.error("Parse dispatch is temporarily unavailable; durable work is retained."))
        .finally(() => { dispatching = undefined; });
    };
    tick();
    dispatchTimer = setInterval(tick, 5000);
  }
  if (!shuttingDown) {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: env.WORKER_HEALTH_PORT,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/health") return Response.json({ status: "ok" });
        if (path === "/ready") {
          const health = await checkReadiness(redis, consumer, shuttingDown);
          return Response.json(health, { status: health.status === "ok" ? 200 : 503 });
        }
        return new Response("Not found", { status: 404 });
      }
    });
    console.info(`Worker ready: PostgreSQL and Redis connected. Health port ${env.WORKER_HEALTH_PORT}.`);
    console.info(consumer ? "Local spreadsheet ingestion enabled. Import completion means parsing only." : "Connectivity mode: local ingestion is disabled.");
  }
} catch {
  console.error("Worker startup failed. Check configuration, PostgreSQL, Redis, and the health port.");
  await shutdown(1);
}
