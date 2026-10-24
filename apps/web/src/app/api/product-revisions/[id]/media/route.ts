import { extrasEndpoint } from "@catalogforge/review/extras-http";
export const runtime="nodejs";
export async function GET(request:Request,context:{params:Promise<{id:string}>}) { return extrasEndpoint(request,"revision-media",(await context.params).id); }
export async function POST(request:Request,context:{params:Promise<{id:string}>}) { return extrasEndpoint(request,"revision-media",(await context.params).id); }
