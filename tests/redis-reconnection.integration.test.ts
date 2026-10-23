import { expect, it } from "vitest";
import { createServer, connect, type Socket } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, disconnectDatabase } from "@catalogforge/db";
import { registerImport } from "@catalogforge/ingestion/imports";
import { processParseImport, RetryableParseError } from "@catalogforge/ingestion/processing";
import { parseProducer, dispatchPending } from "@catalogforge/ingestion/queue";
import { LocalOriginalStorage } from "@catalogforge/ingestion/storage";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean>, timeout = 25000) {
  const deadline = performance.now() + timeout;
  while (!await check()) {
    if (performance.now() > deadline) throw new Error("Timed out waiting for automatic Bun consumer recovery");
    await sleep(100);
  }
}
type State = { pid: number; workerId: string; runtime: string; main: string; blocking: string;
  mainReady: number; blockingReady: number; active: Record<string, number> };

it("keeps the same Bun consumer operational through repeated socket outages, idle waits and graceful shutdown", async () => {
  if (!process.env.REDIS_URL) throw new Error("REDIS_URL is required");
  const db = getDb();
  const directory = await mkdtemp(join(tmpdir(), "catalogforge-socket-recovery-"));
  const store = await db.store.create({ data: { name: "Isolated socket recovery" } });
  const supplier = await db.supplier.create({ data: { storeId: store.id, name: "Socket fixture" } });
  const queueName = `socket-recovery-${crypto.randomUUID()}`;
  const producer = parseProducer(process.env.REDIS_URL, queueName);
  const storage = new LocalOriginalStorage(directory);
  const upstream = new URL(process.env.REDIS_URL);
  if (upstream.protocol !== "redis:") throw new Error("Local socket test requires redis://");
  let cut = false;
  const sockets = new Set<Socket>();
  const proxy = createServer((socket) => {
    socket.on("error", () => undefined);
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    if (cut) {
      // TCP succeeds, then the remote closes before the Redis handshake replies.
      // This reproduces the Bun/ioredis `connect` stall, not just ECONNREFUSED.
      socket.destroy();
      return;
    }
    const target = connect(Number(upstream.port || 6379), upstream.hostname);
    sockets.add(target);
    target.on("error", () => socket.destroy());
    target.on("close", () => { sockets.delete(target); socket.destroy(); });
    socket.on("close", () => target.destroy());
    socket.pipe(target);
    target.pipe(socket);
  });
  let child: ChildProcess | undefined;
  let output = "";
  let base = "";
  try {
    await producer.queue.waitUntilReady();
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("Missing proxy address");
    const consumerUrl = new URL(upstream);
    consumerUrl.hostname = "127.0.0.1";
    consumerUrl.port = String(address.port);
    child = spawn("bun", ["run", "tests/helpers/reconnecting-parser.ts", queueName, store.id, directory, consumerUrl.toString()],
      { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const started = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Bun fixture did not start")), 10000);
      child!.once("error", reject);
      child!.stdout!.on("data", (data: Buffer) => {
        output += data.toString();
        for (const line of output.split("\n")) {
          if (line.startsWith('{"port":')) {
            base = `http://127.0.0.1:${JSON.parse(line).port}`;
            clearTimeout(timer);
            resolve();
          }
        }
      });
      child!.stderr!.on("data", (data: Buffer) => { output += data.toString(); });
      child!.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Bun fixture exited: ${code}; ${output}`)); });
    });
    await started;
    const state = async (): Promise<State> => await (await fetch(`${base}/state`)).json() as State;
    const ready = async () => (await fetch(`${base}/ready`)).status;
    await until(async () => await ready() === 200);
    const original = await state();
    expect(original.runtime).toBeTruthy();
    const register = async (count: number) => (await registerImport(storage, { storeId: store.id, supplierId: supplier.id,
      filename: "reconnect.csv", idempotencyKey: crypto.randomUUID(),
      bytes: Buffer.from(`SKU,Description\n${Array.from({ length: count }, (_, i) => `00${i},original ${i}`).join("\n")}\n`) })).imported;
    const baseline = await register(3);
    await dispatchPending(producer.queue, store.id);
    await until(async () => (await db.import.findUniqueOrThrow({ where: { id: baseline.id } })).status === "COMPLETED");
    const baselineRows = await db.sourceRow.findMany({ where: { importId: baseline.id }, orderBy: { rowNumber: "asc" } });

    // Idle blocking reads must finish normally rather than causing timeout churn.
    const beforeIdle = await state();
    const idleStart = performance.now();
    for (let i = 0; i < 18; i++) { await sleep(1000); expect(await ready()).toBe(200); }
    expect(performance.now() - idleStart).toBeGreaterThan(15000);
    const afterIdle = await state();
    expect([afterIdle.mainReady, afterIdle.blockingReady]).toEqual([beforeIdle.mainReady, beforeIdle.blockingReady]);
    console.info(JSON.stringify({ scenario: "healthy Bun idle", durationMs: performance.now() - idleStart, reconnects: 0 }));

    // Create genuine immutable partial evidence through the real processor.
    const partial = await register(300);
    await expect(processParseImport(partial.id, store.id, storage, { batchSize: 1,
      afterBatch: async () => { throw new Error("Simulated interrupted checkpoint"); } })).rejects.toBeInstanceOf(RetryableParseError);
    const preserved = await db.sourceRow.findMany({ where: { importId: partial.id } });
    expect(preserved).toHaveLength(1);
    const importedIds: string[] = [baseline.id, partial.id];
    for (let round = 1; round <= 2; round++) {
      cut = true;
      for (const socket of sockets) socket.destroy();
      await until(async () => await ready() === 503);
      const pending = await register(round === 1 ? 3 : 7);
      importedIds.push(pending.id);
      // Producer bypasses the cut: actual queued work waits for the consumer.
      await dispatchPending(producer.queue, store.id);
      await sleep(7000);
      expect(await producer.connection.ping()).toBe("PONG");
      expect(await (await producer.queue.getJob(pending.id))!.getState()).toBe("waiting");
      expect((await db.import.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe("PENDING");
      expect(await db.sourceRow.count({ where: { importId: pending.id } })).toBe(0);
      expect(await ready()).toBe(503);
      const unavailable = await state();
      expect(unavailable.main !== "ready" || unavailable.blocking !== "ready").toBe(true);
      cut = false;
      const restored = performance.now();
      await until(async () => {
        const imported = await db.import.findUniqueOrThrow({ where: { id: pending.id } });
        const readiness = await ready();
        const current = await state();
        // A healthy dependency probe must not conceal the reproduced connect stall.
        if (imported.status === "PENDING" && (current.main !== "ready" || current.blocking !== "ready")) expect(readiness).toBe(503);
        return imported.status === "COMPLETED";
      });
      const recoveryMs = performance.now() - restored;
      await until(async () => await ready() === 200);
      const current = await state();
      expect(current.pid).toBe(original.pid);
      expect(current.workerId).toBe(original.workerId);
      expect(current.active[pending.id]).toBe(1);
      expect(await producer.queue.getWorkers()).toHaveLength(1);
      expect(await db.sourceRow.count({ where: { importId: pending.id } })).toBe(round === 1 ? 3 : 7);
      expect(await db.sourceRow.findMany({ where: { importId: baseline.id }, orderBy: { rowNumber: "asc" } })).toEqual(baselineRows);
      expect(await db.sourceRow.findUnique({ where: { id: preserved[0]!.id } })).toEqual(preserved[0]);
      console.info(JSON.stringify({ scenario: "Bun socket recovery", round, recoveryMs, rows: round === 1 ? 3 : 7, pid: current.pid, readiness: 200 }));
    }
    await until(async () => (await db.import.findUniqueOrThrow({ where: { id: partial.id } })).status === "COMPLETED");
    expect(await db.sourceRow.count({ where: { importId: partial.id } })).toBe(300);
    const final = await state();
    for (const id of importedIds) expect(final.active[id]).toBe(1);
    // Duplicate delivery still uses the existing idempotent terminal-state path.
    await until(async () => await (await producer.queue.getJob(baseline.id))!.getState() === "completed");
    await (await producer.queue.getJob(baseline.id))!.retry("completed");
    await until(async () => (await state()).active[baseline.id] === 2 && await (await producer.queue.getJob(baseline.id))!.getState() === "completed");
    expect(await db.sourceRow.findMany({ where: { importId: baseline.id }, orderBy: { rowNumber: "asc" } })).toEqual(baselineRows);
    const stopped = new Promise<number | null>((resolve) => child!.once("exit", resolve));
    const shutdownStart = performance.now();
    child.kill("SIGTERM");
    expect(await stopped).toBe(0);
    expect(output).toContain("GRACEFUL_SHUTDOWN");
    console.info(JSON.stringify({ scenario: "Bun graceful shutdown", durationMs: performance.now() - shutdownStart, exitCode: 0 }));
  } finally {
    cut = false;
    if (child && child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise<void>((resolve) => child!.once("exit", () => resolve()));
      child.kill("SIGKILL");
      await stopped;
    }
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await producer.queue.obliterate({ force: true });
    await producer.queue.close();
    producer.connection.disconnect();
    await db.sourceRow.deleteMany({ where: { storeId: store.id } });
    await db.import.deleteMany({ where: { storeId: store.id } });
    await db.supplier.delete({ where: { id: supplier.id } });
    await db.store.delete({ where: { id: store.id } });
    await rm(directory, { recursive: true, force: true });
    await disconnectDatabase();
  }
}, 100000);
