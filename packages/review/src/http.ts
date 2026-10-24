import { publishRevision } from "./publication";
import { z } from "zod";
import { IngestionError } from "@catalogforge/ingestion/contracts";
import { ReviewError } from "./contracts";
import { listReviews, reviewDetail, reviewEvidence, mutateReview } from "./service";
export async function reviewEndpoint(request: Request, id?: string, resource?: "evidence" | "approve" | "reject" | "publish", scopedStoreId?: string) {
  const headers = { "Cache-Control": "no-store" };
  try {
    if (!scopedStoreId) throw new IngestionError("STORE_SCOPE_REQUIRED", "Authenticated store scope is required.", 401);
    const storeId = scopedStoreId;
    if (id) z.uuid().parse(id);
    if (request.method === "GET") {
      const query = new URL(request.url).searchParams;
      const p = z.object({ page: z.coerce.number().int().min(1).max(100000), pageSize: z.coerce.number().refine(n => [10,25,50,100].includes(n)),
        search: z.string().max(200), status: z.enum(["OPEN", "ALL", "DRAFT", "NEEDS_REVIEW", "APPROVED", "REJECTED"]) }).parse({ page: query.get("page") ?? 1, pageSize: query.get("pageSize") ?? 25, search: query.get("search") ?? "", status: query.get("status") ?? "OPEN" });
      if (resource && resource !== "evidence") return new Response(null, { status: 405, headers });
      return Response.json(id ? resource === "evidence" ? await reviewEvidence(storeId,id,p.page,p.pageSize) : await reviewDetail(storeId,id) : await listReviews(storeId,p.page,p.pageSize,p.search,p.status), { headers });
    }
    if (!id || (request.method !== "PATCH" || resource) && (request.method !== "POST" || !["approve", "reject", "publish"].includes(resource ?? ""))) return new Response(null,{status:405, headers});
    if (!request.headers.get("content-type")?.startsWith("application/json") || !request.body) throw new ReviewError("INVALID_BODY",400,"Send a JSON request.");
    const reader=request.body.getReader(); let size=0; const chunks:Uint8Array[]=[];
    try { for (;;) { const {value,done}=await reader.read(); if(done) break; size+=value.length; if(size>128*1024) { await reader.cancel(); throw new ReviewError("BODY_TOO_LARGE",413,"Review request exceeds 128 KiB."); } chunks.push(value); } } finally { reader.releaseLock(); }
    let body:unknown;
    try { body=JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new ReviewError("INVALID_JSON",400,"Request is not valid JSON."); }
    const result=resource==="publish"?await publishRevision(storeId,id,body):await mutateReview(storeId,id,resource==="approve"?"APPROVE":resource==="reject"?"REJECT":"EDIT",body);
    return Response.json(result,{headers});
  } catch(error) {
    if(error instanceof ReviewError) return Response.json({error:{code:error.code,message:error.message,issues:error.issues}},{status:error.status,headers});
    if(error instanceof IngestionError) return Response.json({error:{code:error.code,message:error.message}},{status:error.httpStatus,headers});
    if(error instanceof z.ZodError) return Response.json({error:{code:"INVALID_FIELDS",message:"Check the request fields, identifiers and supported values.",fields:error.issues.map(i=>({field:i.path.join("."),message:i.message}))}},{status:422,headers});
    return Response.json({error:{code:"REVIEW_UNAVAILABLE",message:"Review service unavailable. Retry with the same request ID."}},{status:503,headers});
  }
}
