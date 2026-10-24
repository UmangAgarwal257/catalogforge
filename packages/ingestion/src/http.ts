import { z } from "zod";
import { IngestionError, LIMITS } from "./contracts";
import { createOriginalStorage, type OriginalStorage } from "./storage";
import { importDetails, listImports, listSuppliers, registerImport } from "./imports";

function pageArguments(request: Request) {
  const params = new URL(request.url).searchParams;
  const result = z.object({ page: z.coerce.number().int().min(1).max(1000000), pageSize: z.coerce.number().int().min(1).max(100) })
    .safeParse({ page: params.get("page") ?? 1, pageSize: params.get("pageSize") ?? 25 });
  if (!result.success) throw new IngestionError("INVALID_PAGE", "Use page >= 1 and pageSize between 1 and 100.", 400);
  return result.data;
}

async function boundedFormData(request: Request): Promise<FormData> {
  const maximum = LIMITS.fileBytes + 64 * 1024;
  const length = request.headers.get("content-length");
  if (length && Number(length) > maximum) throw new IngestionError("FILE_TOO_LARGE", "Upload body exceeds the spreadsheet limit.", 413);
  if (!request.headers.get("content-type")?.startsWith("multipart/form-data;") || !request.body) throw new IngestionError("INVALID_MULTIPART", "Submit one spreadsheet as multipart form-data.", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximum) { await reader.cancel(); throw new IngestionError("FILE_TOO_LARGE", "Upload body exceeds the spreadsheet limit.", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try {
    return await new Response(Buffer.concat(chunks), { headers: { "content-type": request.headers.get("content-type")! } }).formData();
  } catch { throw new IngestionError("INVALID_MULTIPART", "Upload form-data could not be read.", 400); }
}

export async function importEndpoint(request: Request, id?: string, resource: "imports" | "suppliers" = "imports", scopedStoreId?: string, storageOverride?: OriginalStorage): Promise<Response> {
  try {
    if (!scopedStoreId) throw new IngestionError("STORE_SCOPE_REQUIRED", "Authenticated store scope is required.", 401);
    const storeId = scopedStoreId;
    const { page, pageSize } = pageArguments(request);
    if (resource === "suppliers") {
      if(request.method==="POST"){
        const chunks:Uint8Array[]=[];let size=0;
        const reader=request.body?.getReader();
        if(!reader)throw new IngestionError("INVALID_FIELDS","Send a supplier name and request ID as JSON.",400);
        try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>4096){await reader.cancel();throw new IngestionError("INVALID_FIELDS","Supplier request too large.",413);}chunks.push(value);}}finally{reader.releaseLock();}
        const text=Buffer.concat(chunks).toString("utf8");
        let value:unknown;try{value=JSON.parse(text);}catch{throw new IngestionError("INVALID_FIELDS","Send a supplier name and request ID as JSON.",400);}
        const body=z.object({name:z.string().trim().min(1).max(150),requestId:z.uuid()}).strict().safeParse(value);
        if(!body.success)throw new IngestionError("INVALID_FIELDS","Enter a supplier name (1–150 characters) and request ID.",400);
        const {getDb}=await import("@catalogforge/db");const db=getDb();
        await db.supplier.createMany({data:[{id:body.data.requestId,storeId,name:body.data.name}],skipDuplicates:true});
        const item=await db.supplier.findFirst({where:{id:body.data.requestId,storeId,name:body.data.name},select:{id:true,name:true}});
        if(!item)throw new IngestionError("IDEMPOTENCY_CONFLICT","Supplier request ID already used.",409);
        return Response.json(item,{headers:{"Cache-Control":"no-store"}});
      }
      if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET, POST" } });
      return Response.json({ ...await listSuppliers(storeId, page, pageSize), page, pageSize }, { headers: { "Cache-Control": "no-store" } });
    }
    if (request.method === "GET") {
      if (id) {
        if (!z.uuid().safeParse(id).success) throw new IngestionError("INVALID_ID", "Import ID must be a UUID.", 400);
        return Response.json(await importDetails(storeId, id, page, pageSize), { headers: { "Cache-Control": "no-store" } });
      }
      return Response.json({ ...await listImports(storeId, page, pageSize), page, pageSize }, { headers: { "Cache-Control": "no-store" } });
    }
    const form = await boundedFormData(request);
    const uploads = form.getAll("file");
    const file = uploads[0];
    if (uploads.length !== 1 || !file || typeof file === "string" || form.getAll("supplierId").length !== 1 || form.getAll("idempotencyKey").length !== 1 || form.getAll("profileId").length > 1) {
      throw new IngestionError("INVALID_FIELDS", "Provide exactly one file, supplierId, and idempotencyKey.", 400);
    }
    if (file.size > LIMITS.fileBytes) throw new IngestionError("FILE_TOO_LARGE", "Spreadsheet exceeds 10 MiB.", 413);
    const result = await registerImport(storageOverride ?? createOriginalStorage(), {
      storeId, supplierId: String(form.get("supplierId") ?? ""),
      idempotencyKey: String(form.get("idempotencyKey") ?? ""), filename: file.name, bytes: new Uint8Array(await file.arrayBuffer()), profileId: form.get("profileId")?String(form.get("profileId")):undefined
    });
    return Response.json({ importId: result.imported.id, status: result.imported.status, reused: result.reused }, { status: result.reused ? 200 : 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof IngestionError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.httpStatus, headers: { "Cache-Control": "no-store" } });
    return Response.json({ error: { code: "IMPORT_UNAVAILABLE", message: "Import service is unavailable. Retry with the same request key." } }, { status: 503 });
  }
}
