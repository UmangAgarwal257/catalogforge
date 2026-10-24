import { getDb } from "@catalogforge/db";
import { cleanSourceRow } from "@catalogforge/cleaning/persistence";
import { groupImport as persistGrouping } from "@catalogforge/grouping/persistence";
import { exampleGroupingSources, exampleCleaningConfig, exampleGroupingConfig } from "@catalogforge/grouping/example";
// Disposable fixture only: never use these supplier policies as global defaults.
// Hand labels are fixed before generation, never derived from the model output.
export const terracottaLabels = {
  supported: ["Terracotta Pot", "<p>Frost-resistant, <strong>not frost-proof</strong>.</p><p>Bring indoors below 0 °C.</p><ul><li>Drainage hole</li><li>Indoor use</li></ul>", "terracota"],
  requiredQualifications: ["not frost-proof", "Bring indoors below 0 °C"]
};
export async function createTerracottaFixture() {
  const db = getDb();
  const store = await db.store.create({ data: { name: "Disposable AI enrichment fixture" } });
  try {
    const supplier = await db.supplier.create({ data: { storeId: store.id, name: "Terracotta fixture supplier" } });
    const imported = await db.import.create({ data: { storeId: store.id, supplierId: supplier.id, originalFilename: "enrichment-fixture.csv", storageKey: `fixture/${crypto.randomUUID()}`,
      fileSha256: "a".repeat(64), idempotencyKey: crypto.randomUUID(), parserVersion: "fixture-v1", status: "COMPLETED", totalRows: 3 } });
    const ids = [];
    for (const input of exampleGroupingSources) {
      const source = await db.sourceRow.create({ data: { storeId: store.id, importId: imported.id, sheetIndex: 0, sheetName: "Pots", rowNumber: input.rowNumber, rawCells: input.source.rawCells } });
      ids.push((await cleanSourceRow(store.id, source.id, { ...exampleCleaningConfig, storeId: store.id, supplierId: supplier.id })).id);
    }
    await persistGrouping(store.id, imported.id, ids, exampleGroupingConfig);
    const revision = await db.productRevision.findFirstOrThrow({ where: { storeId: store.id, originImportId: imported.id } });
    return { storeId: store.id, supplierId: supplier.id, importId: imported.id, revisionId: revision.id, productId: revision.productId };
  } catch (error) { await removeFixture(store.id); throw error; }
}
export async function removeFixture(storeId: string) {
  const db = getDb(), where = { storeId };
  await db.productReviewEvent.deleteMany({ where });
  await db.aIEnrichmentAttempt.deleteMany({ where }); await db.aIEnrichmentRun.deleteMany({ where });
  await db.groupingRowResult.deleteMany({ where }); await db.revisionSourceRow.deleteMany({ where });
  await db.variantRevision.deleteMany({ where }); await db.product.updateMany({ where, data: { publishedRevisionId: null } });
  await db.productRevision.updateMany({ where, data: { basePublishedRevisionId: null } });
  await db.productRevision.deleteMany({ where }); await db.variant.deleteMany({ where }); await db.product.deleteMany({ where });
  await db.groupingRun.deleteMany({ where }); await db.rowCleaningResult.deleteMany({ where }); await db.sourceRow.deleteMany({ where });
  await db.import.deleteMany({ where }); await db.supplier.deleteMany({ where }); await db.store.delete({ where: { id: storeId } });
}
