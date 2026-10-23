import { importEndpoint } from "@catalogforge/ingestion/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return importEndpoint(request, (await context.params).id);
}
