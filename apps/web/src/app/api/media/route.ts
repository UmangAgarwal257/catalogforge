import { extrasEndpoint } from "@catalogforge/review/extras-http";
import { withMerchantStore } from "../../../lib/merchant-auth";
export const runtime="nodejs";
export async function GET(request:Request) { return withMerchantStore(request,storeId=>extrasEndpoint(request,"media",undefined,storeId)); }
export async function POST(request:Request) { return withMerchantStore(request,storeId=>extrasEndpoint(request,"media",undefined,storeId)); }
