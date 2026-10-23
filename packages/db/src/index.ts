import { PrismaPg } from "@prisma/adapter-pg";
import { databaseEnvSchema, parseEnv } from "@catalogforge/shared";
import { PrismaClient } from "./generated/prisma/client";

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

export async function disconnectDatabase(): Promise<void> {
  const db = globalDatabase.catalogforgeDb;
  if (db) {
    await db.$disconnect();
    delete globalDatabase.catalogforgeDb;
  }
}
