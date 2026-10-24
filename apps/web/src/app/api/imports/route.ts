import { importEndpoint } from "@catalogforge/ingestion/http";
import { withMerchantStore } from "../../../lib/merchant-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = (request: Request) => withMerchantStore(request, storeId => importEndpoint(request, undefined, "imports", storeId));
export const POST = (request: Request) => withMerchantStore(request, storeId => importEndpoint(request, undefined, "imports", storeId));
