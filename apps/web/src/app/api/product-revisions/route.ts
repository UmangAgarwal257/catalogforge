import { reviewEndpoint } from "@catalogforge/review/http";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const GET=(request:Request)=>reviewEndpoint(request);
