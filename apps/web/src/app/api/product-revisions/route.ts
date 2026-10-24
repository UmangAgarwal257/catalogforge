import { reviewEndpoint } from "@catalogforge/review/http";
import { withMerchantStore } from "../../../lib/merchant-auth";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const GET=(request:Request)=>withMerchantStore(request,storeId=>reviewEndpoint(request,undefined,undefined,storeId));
