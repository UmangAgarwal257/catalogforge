import { importEndpoint } from "@catalogforge/ingestion/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = (request: Request) => importEndpoint(request, undefined, "suppliers");
