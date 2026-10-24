import { developmentConfig, checkBrowserOrigin } from "@catalogforge/ingestion/http";
import { IngestionError } from "@catalogforge/ingestion/contracts";
import { dashboardData } from "../../../features/dashboard/data";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  try {
    const config = developmentConfig();
    checkBrowserOrigin(request);
    return Response.json(await dashboardData(config.DEV_STORE_ID), { headers });
  } catch (error) {
    const known = error instanceof IngestionError;
    return Response.json({ error: { message: known ? error.message : "Dashboard data is unavailable. Check local services and try again." } }, { status: known ? error.httpStatus : 503, headers });
  }
}
