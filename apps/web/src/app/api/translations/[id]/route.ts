import { extrasEndpoint } from "@catalogforge/review/extras-http";
export const runtime="nodejs";
export async function POST(request:Request,context:{params:Promise<{id:string}>}) { return extrasEndpoint(request,"translation",(await context.params).id); }
