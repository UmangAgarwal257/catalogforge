import { extrasEndpoint } from "@catalogforge/review/extras-http";
import { withMerchantStore } from "../../../../../lib/merchant-auth";
export const runtime="nodejs";
export async function GET(request:Request,context:{params:Promise<{id:string}>}) { const {id}=await context.params;return withMerchantStore(request,storeId=>extrasEndpoint(request,"translations",id,storeId)); }
export async function POST(request:Request,context:{params:Promise<{id:string}>}) { const {id}=await context.params;return withMerchantStore(request,storeId=>extrasEndpoint(request,"translations",id,storeId)); }
