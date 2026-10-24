import { reviewEndpoint } from "@catalogforge/review/http";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function GET(request:Request,context:{params:Promise<{id:string}>}) { return reviewEndpoint(request,(await context.params).id,undefined); }
export async function PATCH(request:Request,context:{params:Promise<{id:string}>}) { return reviewEndpoint(request,(await context.params).id,undefined); }
