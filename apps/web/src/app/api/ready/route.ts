import { checkDatabase } from "@catalogforge/db";
import type { HealthStatus } from "@catalogforge/shared";
import { getWebEnv } from "@/lib/env";
import { createOriginalStorage, SupabaseOriginalStorage } from "@catalogforge/ingestion/storage";
import { assertWebConfig } from "@/lib/production-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    getWebEnv();
    await checkDatabase();
    assertWebConfig();
    const storage = createOriginalStorage();
    if (storage instanceof SupabaseOriginalStorage) await storage.verifyPrivateBucket();
    return Response.json({ status: "ok" } satisfies HealthStatus, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ status: "unavailable" } satisfies HealthStatus, {
      status: 503,
      headers: { "Cache-Control": "no-store" }
    });
  }
}
