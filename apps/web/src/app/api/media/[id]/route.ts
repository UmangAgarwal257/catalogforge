import {mediaFile} from "@catalogforge/review/extras-http";
import {withMerchantStore} from "../../../../lib/merchant-auth";
export const runtime="nodejs";
export async function GET(request:Request,context:{params:Promise<{id:string}>}) {const {id}=await context.params;if(new URL(request.url).searchParams.get("scope")==="review")return withMerchantStore(request,storeId=>mediaFile(request,id,storeId));return mediaFile(request,id);}
