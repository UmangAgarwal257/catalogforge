import type { HealthStatus } from "@catalogforge/shared";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ status: "ok" } satisfies HealthStatus, {
    headers: { "Cache-Control": "no-store" }
  });
}
