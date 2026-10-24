import { exportEndpoint } from "@catalogforge/review/export";
import { withMerchantStore } from "../../../../lib/merchant-auth";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const GET=(request:Request)=>withMerchantStore(request,storeId=>exportEndpoint(request,storeId));
