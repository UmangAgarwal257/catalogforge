import { Queue, QueueEvents, Worker } from "bullmq";
import { env } from "./env";
import { checkDatabase, disconnectDatabase } from "@catalogforge/db";
import { Redis } from "ioredis";

if (process.env.NODE_ENV === "production") {
  throw new Error("The foundation smoke job is development-only.");
}

// Isolated, explicit connectivity test; never started by the normal worker.
const name = `foundation-smoke-${crypto.randomUUID()}`;
const connection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  connectTimeout: 5000,
  retryStrategy: () => null
});
connection.on("error", () => console.error("Smoke test Redis connection failed."));
const queue = new Queue(name, { connection });
const events = new QueueEvents(name, { connection });
const worker = new Worker(name, async () => {
  await checkDatabase();
  return "database-and-redis-ok";
}, { connection });
worker.on("error", () => console.error("Smoke worker connection failed."));
events.on("error", () => console.error("Smoke events connection failed."));
const deadline = setTimeout(() => {
  console.error("Smoke test timed out.");
  process.exit(1);
}, 20000);

try {
  await events.waitUntilReady();
  const job = await queue.add("development-connectivity", {});
  const result: unknown = await job.waitUntilFinished(events, 10000);
  if (result !== "database-and-redis-ok") throw new Error("Unexpected smoke result");
  console.info("BullMQ smoke: job completed through Redis with a Prisma PostgreSQL query under Bun.");
} catch {
  console.error("BullMQ smoke failed. Check PostgreSQL and Redis.");
  process.exitCode = 1;
} finally {
  await worker.close();
  await events.close();
  await queue.obliterate({ force: true });
  await queue.close();
  connection.disconnect();
  await disconnectDatabase();
  clearTimeout(deadline);
}
