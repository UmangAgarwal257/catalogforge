import { z } from "zod";
import { getDb, disconnectDatabase } from "./index";

try {
  if (process.env.NODE_ENV === "production" || process.env.DEV_INGESTION_ENABLED !== "true" || process.env.VERCEL) {
    throw new Error("Development seeding requires explicit local ingestion opt-in.");
  }
  const config = z.object({ DEV_STORE_ID: z.uuid(), DEV_SUPPLIER_ID: z.uuid() }).safeParse(process.env);
  if (!config.success) throw new Error("Set valid DEV_STORE_ID and DEV_SUPPLIER_ID UUIDs.");
  const db = getDb();
  const { DEV_STORE_ID: storeId, DEV_SUPPLIER_ID: supplierId } = config.data;
  await db.$transaction(async (tx) => {
    await tx.store.upsert({ where: { id: storeId }, update: {}, create: { id: storeId, name: "CatalogForge development store" } });
    const supplier = await tx.supplier.upsert({ where: { id: supplierId }, update: {}, create: { id: supplierId, storeId, name: "Development supplier" } });
    if (supplier.storeId !== storeId) throw new Error("Development supplier belongs to another store.");
  });
  console.info(`Development store: ${storeId}\nDevelopment supplier: ${supplierId}`);
} catch (error) {
  console.error(error instanceof Error && !('code' in error) ? error.message : "Development seeding failed.");
  process.exitCode = 1;
} finally { await disconnectDatabase(); }
