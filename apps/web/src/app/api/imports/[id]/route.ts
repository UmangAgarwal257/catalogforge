import { importEndpoint } from "@catalogforge/ingestion/http";
import { withMerchantStore } from "../../../../lib/merchant-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return withMerchantStore(request, storeId => importEndpoint(request, id, "imports", storeId));
}
