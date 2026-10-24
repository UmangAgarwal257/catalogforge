import { reviewEndpoint } from "@catalogforge/review/http";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function POST(request:Request,context:{params:Promise<{id:string}>}) { return reviewEndpoint(request,(await context.params).id,"approve"); }
