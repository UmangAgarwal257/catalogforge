import { Redis } from "ioredis";
import { disconnectDatabase } from "@catalogforge/db";
import { env } from "./env";
import { checkReadiness } from "./health";

const redis = new Redis(env.REDIS_URL, {
  lazyConnect: true,
  enableOfflineQueue: false,
  connectTimeout: 5000,
  commandTimeout: 5000,
  maxRetriesPerRequest: 1,
  retryStrategy: () => null
});
redis.on("error", () => console.error("Worker Redis connection error; check local infrastructure."));

let server: ReturnType<typeof Bun.serve> | undefined;
let shuttingDown = false;

async function shutdown(exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  // A broken connection must not hold shutdown open indefinitely.
  const deadline = setTimeout(() => process.exit(1), 10000);
  try {
    await server?.stop(true);
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
  if (!shuttingDown) {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: env.WORKER_HEALTH_PORT,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/health") return Response.json({ status: "ok" });
        if (path === "/ready") {
          const health = await checkReadiness(redis);
          return Response.json(health, { status: health.status === "ok" ? 200 : 503 });
        }
        return new Response("Not found", { status: 404 });
      }
    });
    console.info(`Worker ready: PostgreSQL and Redis connected. Health port ${env.WORKER_HEALTH_PORT}.`);
    console.info("Foundation mode: no import queues or business jobs are running.");
  }
} catch {
  console.error("Worker startup failed. Check configuration, PostgreSQL, Redis, and the health port.");
  await shutdown(1);
}
