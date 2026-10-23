import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { disconnectDatabase, getDb } from "@catalogforge/db";
import { registerImport } from "@catalogforge/ingestion/imports";
import { LocalOriginalStorage } from "@catalogforge/ingestion/storage";
import { parseProducer, parseConsumer, dispatchPending } from "@catalogforge/ingestion/queue";

const db = getDb();
let storeId: string;
let supplierId: string;
let directory: string;
let queueName: string;
let producer: ReturnType<typeof parseProducer>;
let consumer: ReturnType<typeof parseConsumer> | undefined;
let child: ChildProcess | undefined;
const redisUrl = process.env.REDIS_URL!;

async function until(check: () => Promise<boolean>, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for durable parse state");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
async function register(text = "SKU\n001\n002\n003\n") {
  return (await registerImport(new LocalOriginalStorage(directory), { storeId, supplierId, idempotencyKey: crypto.randomUUID(), filename: "supplier.csv", bytes: Buffer.from(text) })).imported;
}
beforeEach(async () => {
  if (!redisUrl) throw new Error("REDIS_URL is required for recovery integration tests");
  directory = await mkdtemp(join(tmpdir(), "catalogforge-recovery-"));
  storeId = (await db.store.create({ data: { name: "Recovery test" } })).id;
  supplierId = (await db.supplier.create({ data: { storeId, name: "Test supplier" } })).id;
  queueName = `ingestion-test-${crypto.randomUUID()}`;
  producer = parseProducer(redisUrl, queueName);
  await producer.queue.waitUntilReady();
  await producer.connection.ping();
});
afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((resolve) => child!.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
  }
  child = undefined;
  await consumer?.worker.close(true);
  consumer?.connection.disconnect();
  consumer = undefined;
  // Every test owns its queue. Never flush shared Redis or touch another queue.
  await producer.queue.obliterate({ force: true });
  await producer.queue.close();
  producer.connection.disconnect();
  await db.sourceRow.deleteMany({ where: { storeId } });
  await db.import.deleteMany({ where: { storeId } });
  await db.supplier.deleteMany({ where: { storeId } });
  await db.store.delete({ where: { id: storeId } });
  await rm(directory, { recursive: true, force: true });
});
afterAll(disconnectDatabase);

it("retains dispatch during Redis failure, recovers it, and reconciles lost queue data", async () => {
  const imported = await register();
  // Refused connection models producer/Redis unavailability without stopping shared Redis.
  const unavailable = parseProducer("redis://127.0.0.1:1", queueName);
  try {
    await expect(dispatchPending(unavailable.queue, storeId)).rejects.toThrow(/dispatch unavailable/);
  } finally {
    await unavailable.queue.close();
    unavailable.connection.disconnect();
  }
  expect(await db.import.findUniqueOrThrow({ where: { id: imported.id } })).toMatchObject({ status: "PENDING", errorCode: "DISPATCH_UNAVAILABLE" });
  expect(await db.parseDispatch.findUniqueOrThrow({ where: { importId: imported.id } })).toMatchObject({ dispatchedAt: null });
  await dispatchPending(producer.queue, storeId);
  expect(await producer.queue.getJob(imported.id)).toBeDefined();
  // Simulate acknowledged Redis work disappearing; PostgreSQL still owns the intent.
  await (await producer.queue.getJob(imported.id))!.remove();
  await dispatchPending(producer.queue, storeId);
  await dispatchPending(producer.queue, storeId);
  expect(await producer.queue.getWaitingCount()).toBe(1);
  consumer = parseConsumer(redisUrl, storeId, new LocalOriginalStorage(directory), queueName);
  await until(async () => (await db.import.findUniqueOrThrow({ where: { id: imported.id } })).status === "COMPLETED");
  expect(await db.sourceRow.count({ where: { importId: imported.id, status: "PENDING" } })).toBe(3);
});

it("recovers after SIGKILL during persistence without duplicating or replacing immutable rows", async () => {
  const imported = await register();
  child = spawn("bun", ["run", "tests/helpers/interrupted-parser.ts", queueName, storeId, directory], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  const committed = new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("Child never committed a batch")), 10000);
    child!.stdout!.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("BATCH_COMMITTED")) { clearTimeout(deadline); resolve(); }
    });
    child!.once("error", reject);
    child!.once("exit", (code) => { clearTimeout(deadline); reject(new Error(`Fixture exited before kill: ${code}`)); });
  });
  // Install rejection handling before dispatch can yield to a child exit.
  void committed.catch(() => undefined);
  await dispatchPending(producer.queue, storeId);
  await committed;
  const partial = await db.sourceRow.findMany({ where: { importId: imported.id } });
  expect(partial).toHaveLength(1);
  expect(await db.import.findUniqueOrThrow({ where: { id: imported.id } })).toMatchObject({ status: "PROCESSING", totalRows: 3, finishedAt: null });
  const exited = new Promise<void>((resolve) => child!.once("exit", () => resolve()));
  child.kill("SIGKILL");
  await exited;
  expect(child.signalCode).toBe("SIGKILL");
  consumer = parseConsumer(redisUrl, storeId, new LocalOriginalStorage(directory), queueName, 1000);
  await until(async () => (await db.import.findUniqueOrThrow({ where: { id: imported.id } })).status === "COMPLETED");
  expect(await db.sourceRow.count({ where: { importId: imported.id } })).toBe(3);
  expect(await db.sourceRow.findUnique({ where: { id: partial[0]!.id } })).toEqual(partial[0]);
}, 30000);

it("records malformed files as failed with no rows rather than completing a partial import", async () => {
  const imported = await register("SKU\n\"unterminated");
  consumer = parseConsumer(redisUrl, storeId, new LocalOriginalStorage(directory), queueName);
  await dispatchPending(producer.queue, storeId);
  await until(async () => (await db.import.findUniqueOrThrow({ where: { id: imported.id } })).status === "FAILED");
  expect(await db.import.findUniqueOrThrow({ where: { id: imported.id } })).toMatchObject({ errorCode: "MALFORMED_CSV", totalRows: null });
  expect(await db.sourceRow.count({ where: { importId: imported.id } })).toBe(0);
  await until(async () => await (await producer.queue.getJob(imported.id))!.getState() === "failed");
});

it("makes exhausted retries durable even if a worker's failure-status update was lost", async () => {
  const imported = await register();
  const job = await producer.queue.add("parse", { importId: imported.id, storeId }, { jobId: imported.id, attempts: 1 });
  // A real failed BullMQ job, without a database status callback.
  const { Worker } = await import("bullmq");
  const failing = new Worker(queueName, async () => { throw new Error("simulated exhausted worker"); }, { connection: { url: redisUrl } });
  failing.on("error", () => undefined);
  try { await until(async () => await job.getState() === "failed"); }
  finally { await failing.close(); }
  await dispatchPending(producer.queue, storeId);
  expect(await db.import.findUniqueOrThrow({ where: { id: imported.id } })).toMatchObject({ status: "FAILED", errorCode: "PARSE_RETRIES_EXHAUSTED" });
});

it("bounds transient storage retries and records terminal failure", async () => {
  const imported = await register();
  const storage = new LocalOriginalStorage(directory);
  let attempts = 0;
  consumer = parseConsumer(redisUrl, storeId, {
    save: (bytes) => storage.save(bytes), remove: (key) => storage.remove(key),
    open: async () => { attempts++; throw new Error("temporary storage outage"); }
  }, queueName);
  await dispatchPending(producer.queue, storeId);
  await until(async () => (await db.import.findUniqueOrThrow({ where: { id: imported.id } })).status === "FAILED");
  expect(attempts).toBe(3);
  expect(await db.import.findUniqueOrThrow({ where: { id: imported.id } })).toMatchObject({ errorCode: "PARSE_RETRIES_EXHAUSTED", totalRows: null });
  expect(await db.sourceRow.count({ where: { importId: imported.id } })).toBe(0);
});
