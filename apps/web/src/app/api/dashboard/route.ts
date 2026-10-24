import { withMerchantStore } from "../../../lib/merchant-auth";
import { dashboardData } from "../../../features/dashboard/data";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return withMerchantStore(request, async storeId => {
    try { return Response.json(await dashboardData(storeId), { headers: { "Cache-Control": "private, no-store" } }); }
    catch { return Response.json({ error: { message: "Dashboard data is unavailable. Retry shortly." } }, { status: 503, headers: { "Cache-Control": "private, no-store" } }); }
  });
}
