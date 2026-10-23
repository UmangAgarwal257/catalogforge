import { z } from "zod";
import { IngestionError, LIMITS, localSettingsSchema } from "./contracts";
import { LocalOriginalStorage } from "./storage";
import { importDetails, listImports, listSuppliers, registerImport } from "./imports";

export function developmentConfig() {
  if (process.env.NODE_ENV !== "development" || process.env.DEV_INGESTION_ENABLED !== "true" || process.env.VERCEL) {
    throw new IngestionError("DEVELOPMENT_ONLY", "Spreadsheet APIs are disabled outside explicitly enabled local development.", 404);
  }
  const parsed = localSettingsSchema.safeParse(process.env);
  if (!parsed.success) throw new IngestionError("DEVELOPMENT_CONFIG", "Set DEV_STORE_ID and an absolute LOCAL_UPLOAD_DIR for local ingestion.", 503);
  return parsed.data;
}

function checkBrowserOrigin(request: Request): void {
  const target = new URL(request.url);
  const loopback = (hostname: string) => ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
  // Next.js may canonicalize Request.url to localhost even when the browser used
  // 127.0.0.1. Compare Origin with the actual, independently validated HTTP host.
  let browserTarget: URL;
  try { browserTarget = new URL(`${target.protocol}//${request.headers.get("host") ?? target.host}`); }
  catch { throw new IngestionError("LOCAL_ONLY", "Use the local development server on localhost.", 403); }
  if (!loopback(target.hostname) || !loopback(browserTarget.hostname) || browserTarget.port !== target.port || browserTarget.username || browserTarget.password) {
    throw new IngestionError("LOCAL_ONLY", "Use the local development server on localhost.", 403);
  }
  const origin = request.headers.get("origin");
  if (origin && origin !== browserTarget.origin) throw new IngestionError("CROSS_ORIGIN", "Cross-origin access to the local import API is not allowed.", 403);
  if (request.headers.get("sec-fetch-site") === "cross-site") throw new IngestionError("CROSS_ORIGIN", "Cross-site import requests are not allowed.", 403);
}

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

export async function importEndpoint(request: Request, id?: string, resource: "imports" | "suppliers" = "imports"): Promise<Response> {
  try {
    const config = developmentConfig();
    checkBrowserOrigin(request);
    const { page, pageSize } = pageArguments(request);
    if (resource === "suppliers") {
      if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
      return Response.json({ ...await listSuppliers(config.DEV_STORE_ID, page, pageSize), page, pageSize }, { headers: { "Cache-Control": "no-store" } });
    }
    if (request.method === "GET") {
      if (id) {
        if (!z.uuid().safeParse(id).success) throw new IngestionError("INVALID_ID", "Import ID must be a UUID.", 400);
        return Response.json(await importDetails(config.DEV_STORE_ID, id, page, pageSize), { headers: { "Cache-Control": "no-store" } });
      }
      return Response.json({ ...await listImports(config.DEV_STORE_ID, page, pageSize), page, pageSize }, { headers: { "Cache-Control": "no-store" } });
    }
    const form = await boundedFormData(request);
    const uploads = form.getAll("file");
    const file = uploads[0];
    if (uploads.length !== 1 || !file || typeof file === "string" || form.getAll("supplierId").length !== 1 || form.getAll("idempotencyKey").length !== 1) {
      throw new IngestionError("INVALID_FIELDS", "Provide exactly one file, supplierId, and idempotencyKey.", 400);
    }
    if (file.size > LIMITS.fileBytes) throw new IngestionError("FILE_TOO_LARGE", "Spreadsheet exceeds 10 MiB.", 413);
    const result = await registerImport(new LocalOriginalStorage(config.LOCAL_UPLOAD_DIR), {
      storeId: config.DEV_STORE_ID, supplierId: String(form.get("supplierId") ?? ""),
      idempotencyKey: String(form.get("idempotencyKey") ?? ""), filename: file.name, bytes: new Uint8Array(await file.arrayBuffer())
    });
    return Response.json({ importId: result.imported.id, status: result.imported.status, reused: result.reused }, { status: result.reused ? 200 : 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof IngestionError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.httpStatus, headers: { "Cache-Control": "no-store" } });
    return Response.json({ error: { code: "IMPORT_UNAVAILABLE", message: "Import service is unavailable. Retry with the same request key." } }, { status: 503 });
  }
}
