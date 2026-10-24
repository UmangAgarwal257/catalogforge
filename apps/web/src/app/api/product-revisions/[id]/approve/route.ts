import { reviewEndpoint } from "@catalogforge/review/http";
import { withMerchantStore } from "../../../../../lib/merchant-auth";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function POST(request:Request,context:{params:Promise<{id:string}>}) { const {id}=await context.params;return withMerchantStore(request,storeId=>reviewEndpoint(request,id,"approve",storeId)); }
