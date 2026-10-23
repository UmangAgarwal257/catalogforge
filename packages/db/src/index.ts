import { PrismaPg } from "@prisma/adapter-pg";
import { databaseEnvSchema, parseEnv } from "@catalogforge/shared";
import { PrismaClient, type Variant } from "./generated/prisma/client";

const globalDatabase = globalThis as unknown as { catalogforgeDb?: PrismaClient };

export function getDb(): PrismaClient {
  if (!globalDatabase.catalogforgeDb) {
    const env = parseEnv(databaseEnvSchema, process.env);
    const adapter = new PrismaPg({
      connectionString: env.DATABASE_URL,
      max: 5,
      connectionTimeoutMillis: 5000,
      query_timeout: 5000
    });
    globalDatabase.catalogforgeDb = new PrismaClient({ adapter });
  }
  return globalDatabase.catalogforgeDb;
}

export async function checkDatabase(): Promise<void> {
  await getDb().$queryRaw`SELECT 1`;
}

// Include archived identities so callers cannot mistake an archived SKU for a new one.
// PostgreSQL is the single source of truth for locale-aware SKU canonicalization.
export async function findVariantBySku(storeId: string, supplierSku: string): Promise<Variant | null> {
  const variants = await getDb().$queryRaw<Variant[]>`
    SELECT * FROM "Variant"
    WHERE "storeId" = ${storeId}::uuid
      AND "sku" = public."catalogforge_canonical_sku"(${supplierSku})
    LIMIT 1
  `;
  return variants[0] ?? null;
}

export async function disconnectDatabase(): Promise<void> {
  const db = globalDatabase.catalogforgeDb;
  if (db) {
    await db.$disconnect();
    delete globalDatabase.catalogforgeDb;
  }
}
