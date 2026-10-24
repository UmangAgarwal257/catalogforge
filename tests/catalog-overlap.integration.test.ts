import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, disconnectDatabase } from "@catalogforge/db";
import { registerImport } from "@catalogforge/ingestion/imports";
import { processParseImport } from "@catalogforge/ingestion/processing";
import { LocalOriginalStorage } from "@catalogforge/ingestion/storage";
import { removeFixture } from "@catalogforge/enrichment/fixture";
import { testPolicy, testProvider } from "@catalogforge/enrichment/test-stub";
import { SUPPLIER_PROFILES } from "@catalogforge/shared/catalog";
import { processCatalogTask } from "@catalogforge/pipeline";

const db = getDb();
let storeId: string, importId: string, directory: string;
function barrier() {
  let release!: () => void, reached!: () => void;
  const waiting = new Promise<void>(r => { release = r; });
  const ready = new Promise<void>(r => { reached = r; });
  return { ready, release, async hold() { reached(); await waiting; } };
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "catalog-overlap-"));
  storeId = (await db.store.create({ data: { name: "Overlap fixture" } })).id;
  const supplier = await db.supplier.create({ data: { storeId, name: "Overlap supplier" } });
  const records = Array.from({ length: 6 }, (_, i) => [`SKU-${i}`, `FAMILY-${Math.floor(i / 2)}`, "Cotton shirt", "Wash cold. Do not tumble dry.", "12,50", "EUR", "0,25", String(i % 2), "Blue", "Cotton"]);
  const csv = [SUPPLIER_PROFILES[0]!.headers, ...records].map(r => r.join(";")).join("\n");
  const storage = new LocalOriginalStorage(directory);
  importId = (await registerImport(storage, { storeId, supplierId: supplier.id, idempotencyKey: crypto.randomUUID(), filename: "overlap.csv", bytes: Buffer.from(csv), profileId: SUPPLIER_PROFILES[0]!.id })).imported.id;
  await processParseImport(importId, storeId, storage);
});
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await removeFixture(storeId); await rm(directory, { recursive: true, force: true }); });
afterAll(disconnectDatabase);

it.each([ ["cleaning", true], ["cleaning", false], ["grouping", true], ["grouping", false], ["grouping-transaction", true] ] as const)("keeps business writes safe during %s overlap (original finishes first: %s)", async (stage, originalFirst) => {
  const originalGate = barrier(), successorGate = barrier();
  let firstClean = true, firstGroup = true, firstCommit=true;
  const sources = await db.sourceRow.findMany({ where: { importId }, orderBy: { id: "asc" }, select: { id: true, rawCells: true, rowNumber: true } });
  let failedHeartbeats = 0;
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  const original = processCatalogTask(storeId, importId, { provider: testProvider, policy: testPolicy,
    beforeCleaningBatch:async()=>{if(stage==="cleaning"&&firstClean){firstClean=false;await originalGate.hold();}},
    beforeGroupFamily:async()=>{if(stage==="grouping"&&firstGroup){firstGroup=false;await originalGate.hold();}},
    beforeGroupFamilyCommit:async()=>{if(stage==="grouping-transaction"&&firstCommit){firstCommit=false;await originalGate.hold();}},
    beforeHeartbeat:async()=>{failedHeartbeats++;throw Error("Injected renewal failure");}
  });
  await originalGate.ready;
  await vi.advanceTimersByTimeAsync(91000);
  expect(failedHeartbeats).toBeGreaterThan(0);
  expect((await db.catalogTask.findUniqueOrThrow({ where: { importId } })).leaseUntil!.getTime()).toBeLessThan(Date.now());
  const successor = processCatalogTask(storeId, importId, { provider: testProvider, policy: testPolicy, afterClaim:async fence=>{expect(fence).toBe(2);await successorGate.hold();} });
  await successorGate.ready;
  try {
    if (originalFirst) {
      const ownedBefore=await db.catalogTask.findUniqueOrThrow({where:{importId}});
      originalGate.release(); await original;
      const ownedAfter=await db.catalogTask.findUniqueOrThrow({where:{importId}});
      expect(ownedAfter).toEqual(ownedBefore);
      successorGate.release(); await successor;
    }
    else {
      successorGate.release(); await successor;
      // A merchant edit and a pre-existing published snapshot must survive the
      // superseded coordinator continuing through its old grouping work.
      const proposal = await db.productRevision.findFirstOrThrow({ where: { storeId } });
      await db.productRevision.update({ where: { id: proposal.id }, data: { title: "Merchant-owned", editVersion: { increment: 1 }, manualFieldPaths: ["title"] } });
      const published = await db.productRevision.create({ data: { productId: proposal.productId, storeId, title: "Published snapshot", status: "APPROVED" } });
      await db.product.update({ where: { id: proposal.productId }, data: { publishedRevisionId: published.id } });
      originalGate.release(); await original;
      expect((await db.productRevision.findUniqueOrThrow({ where: { id: proposal.id } })).title).toBe("Merchant-owned");
      expect(await db.productRevision.findUnique({ where: { id: published.id } })).toEqual(published);
      expect((await db.product.findUniqueOrThrow({ where: { id: proposal.productId } })).publishedRevisionId).toBe(published.id);
    }
    expect(await db.catalogTask.findUniqueOrThrow({ where: { importId } })).toMatchObject({ fence: 2, state: "COMPLETED", phase: "ENRICHMENT" });
    expect(await db.product.count({ where: { storeId } })).toBe(3);
    expect(await db.variant.count({ where: { storeId } })).toBe(6);
    expect(await db.productRevision.count({ where: { storeId, originImportId: importId } })).toBe(3);
    expect(await db.variantRevision.count({ where: { storeId } })).toBe(6);
    expect(await db.revisionSourceRow.count({ where: { storeId } })).toBe(6);
    expect(await db.groupingRowResult.count({ where: { storeId } })).toBe(6);
    expect(await db.groupingRowResult.count({ where: { storeId, outcome: "PENDING" } })).toBe(0);
    expect(await db.sourceRow.findMany({ where: { importId }, orderBy: { id: "asc" }, select: { id: true, rawCells: true, rowNumber: true } })).toEqual(sources);
    expect(await db.aIEnrichmentRun.count({ where: { storeId } })).toBe(3);
    expect(await db.aIEnrichmentAttempt.count({ where: { storeId } })).toBe(3);
    const manifest = (await db.catalogTask.findUniqueOrThrow({ where: { importId } })).runs;
    const before = await db.productRevision.findMany({ where: { storeId }, orderBy: { id: "asc" } });
    await processCatalogTask(storeId, importId, { provider: testProvider, policy: testPolicy });
    expect((await db.catalogTask.findUniqueOrThrow({ where: { importId } })).runs).toEqual(manifest);
    expect(await db.productRevision.findMany({ where: { storeId }, orderBy: { id: "asc" } })).toEqual(before);
  } finally { originalGate.release(); successorGate.release(); await Promise.allSettled([original, successor]); }
}, 30000);
