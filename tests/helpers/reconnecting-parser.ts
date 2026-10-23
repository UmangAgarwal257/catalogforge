// Run by Bun: exercise the real consumer/readiness with an isolated queue.
import { createServer } from "node:http";
import { Redis } from "ioredis";
import { disconnectDatabase } from "@catalogforge/db";
import { parseConsumer } from "@catalogforge/ingestion/queue";
import { LocalOriginalStorage } from "@catalogforge/ingestion/storage";
import { checkReadiness } from "../../apps/worker/src/health";

const [queueName, storeId, directory, consumerUrl] = process.argv.slice(2);
if (!queueName || !storeId || !directory || !consumerUrl || !process.env.REDIS_URL || !process.versions.bun) {
  throw new Error("Missing isolated Bun recovery fixture configuration");
}
// The independent dependency probe stays connected: consumer failure alone must
// make readiness unavailable, even when this Redis connection can answer PING.
const redis = new Redis(process.env.REDIS_URL, { commandTimeout: 1000, maxRetriesPerRequest: 1 });
redis.on("error", () => undefined);
const consumer = parseConsumer(consumerUrl, storeId, new LocalOriginalStorage(directory), queueName);
await consumer.worker.waitUntilReady();
const blocking = await consumer.worker.getBackend().blockingClient;
if (!blocking) throw new Error("Missing blocking connection");
let mainReady = 0;
let blockingReady = 0;
let shuttingDown = false;
const active: Record<string, number> = {};
consumer.connection.on("ready", () => { mainReady++; });
blocking.on("ready", () => { blockingReady++; });
consumer.worker.on("active", (job) => { active[job.id!] = (active[job.id!] ?? 0) + 1; });

const server = createServer(async (request, response) => {
  if (request.url === "/state") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ pid: process.pid, workerId: consumer.worker.id, runtime: process.versions.bun,
      main: consumer.connection.status, blocking: blocking.status, mainReady, blockingReady, active }));
    return;
  }
  const health = await checkReadiness(redis, consumer, shuttingDown);
  response.writeHead(health.status === "ok" ? 200 : 503, { "content-type": "application/json" });
  response.end(JSON.stringify(health));
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing health address");
  console.log(JSON.stringify({ port: address.port }));
});
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const deadline = setTimeout(() => process.exit(1), 10000);
  try {
    if ((await checkReadiness(redis, consumer, shuttingDown)).status !== "unavailable") throw new Error("Shutdown stayed ready");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await consumer.worker.close();
    if (await consumer.isAvailable()) throw new Error("Closed consumer stayed ready");
    consumer.connection.disconnect();
    redis.disconnect();
    await disconnectDatabase();
    console.log("GRACEFUL_SHUTDOWN");
  } catch {
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
  }
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
