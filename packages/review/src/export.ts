import { getDb } from "@catalogforge/db";
import { z } from "zod";
import { IngestionError } from "@catalogforge/ingestion/contracts";
import { ReviewError, minorToDecimal } from "./contracts";
import { visibleProducts } from "./catalog";
import { safeHtml } from "@catalogforge/enrichment/validation";

// Quoting alone does not neutralize spreadsheet formulas. This safety prefix is
// deliberately visible; JSON is the lossless format for arbitrary text values.
export function csvCell(value: unknown): string {
  let s = value == null ? "" : String(value);
  if (/^[\s\u0000-\u001f]*[=+@-]/u.test(s) || /^[\t\r\n]/u.test(s)) s = `'${s}`;
  return `"${s.replaceAll('"', '""')}"`;
}
const line = (cells: unknown[]) => cells.map(csvCell).join(",") + "\r\n";
const escapeHtml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
export type ExportFormat = "csv" | "json" | "shopify";
export async function captureExport(storeId: string, format: ExportFormat, currency?: string) {
  const products = await getDb().product.findMany({ where: visibleProducts(storeId), orderBy: { id: "asc" }, take: 10001, select: {
    publishedRevisionId: true
  } });
  if (products.length > 10000) throw new ReviewError("EXPORT_LIMIT", 413, "Export supports up to 10,000 published products. Split the catalog before exporting.");
  if (format === "shopify") {
    const groups = await getDb().variantRevision.groupBy({ by: ["currency"], where: { storeId, productRevisionId: { in: products.map(p => p.publishedRevisionId!) } } });
    const currencies = new Set(groups.map(v => v.currency));
    if (!currency && currencies.size > 1) throw new ReviewError("SHOPIFY_CURRENCY", 422, "Shopify CSV has no currency column. Choose one currency matching the destination shop; no conversion is performed.");
    currency ??= [...currencies][0] ?? undefined;
    // Reject unsupported option layouts before starting a download; never drop
    // a fourth option or turn dissimilar option keys into the same variant.
    for (const product of products) {
      const variants = await getDb().variantRevision.findMany({ where: { productRevisionId: product.publishedRevisionId!, ...(currency ? { currency } : {}) }, take: 1001, select: { options: true } });
      if (!variants.length) continue;
      const keys = variants.map(v => Object.keys(v.options as object).sort());
      if (keys[0]!.length > 3 || keys.some(k => JSON.stringify(k) !== JSON.stringify(keys[0]))) throw new ReviewError("SHOPIFY_OPTIONS", 422, "Shopify export requires the same set of at most three option names on each product's variants. Use CSV or JSON to retain other layouts.");
    }
  }
  return { revisionIds: products.map(p => p.publishedRevisionId!), currency };
}
export async function* catalogExport(storeId: string, revisionIds: string[], format: ExportFormat, currency?: string) {
  if (format === "json") yield "[";
  else if (format === "csv") yield line(["product_id","revision_id","title","description_html","category","tags_json","attributes_json","variant_id","sku","options_json","price_minor","price","currency","weight_grams"]);
  else yield line(["Handle","Title","Body (HTML)","Type","Tags","Option1 Name","Option1 Value","Option2 Name","Option2 Value","Option3 Name","Option3 Value","Variant SKU","Variant Price","Variant Grams","Status","Published"]);
  let firstProduct = true;
  for (const revisionId of revisionIds) {
    // Captured revisions remain immutable even if another revision is published
    // between chunks. Never re-read the mutable Product pointer during export.
    const r = await getDb().productRevision.findFirstOrThrow({ where: { id: revisionId, storeId, publication: { isNot: null } }, include: {
      variants: { where: format === "shopify" && currency ? { currency } : {}, orderBy: { variantId: "asc" }, take: 1001, include: { variant: { select: { sku: true } } } }
    } });
    if (r.variants.length > 1000) throw new Error("Export revision exceeds supported variant limit");
    if (!r.variants.length && format === "shopify") continue;
    const product = { productId: r.productId, revisionId: r.id, title: r.title, descriptionHtml: safeHtml(r.descriptionHtml!), categoryKey: r.categoryKey, tags: r.tags, attributes: r.attributes };
    if (format === "json") {
      const variants = r.variants.map(v => ({ variantId: v.variantId, sku: v.variant.sku, options: v.options, priceMinor: v.priceMinor!.toString(), price: minorToDecimal(v.priceMinor!.toString()), currency: v.currency, weightGrams: v.weightGrams }));
      yield `${firstProduct ? "" : ","}${JSON.stringify({ ...product, variants })}`; firstProduct = false;
    } else for (const [index, v] of r.variants.entries()) {
      if (format === "csv") yield line([r.productId,r.id,r.title,product.descriptionHtml,r.categoryKey,JSON.stringify(r.tags),JSON.stringify(r.attributes),v.variantId,v.variant.sku,JSON.stringify(v.options),v.priceMinor!.toString(),minorToDecimal(v.priceMinor!.toString()),v.currency,v.weightGrams]);
      else {
        const options = Object.entries(v.options as Record<string,string>).sort(([a],[b]) => a.localeCompare(b,"en"));
        const attrs = Object.entries(r.attributes as Record<string,string|null>).filter(([,value]) => value !== null);
        const description = product.descriptionHtml + (attrs.length ? `<dl>${attrs.map(([k,value]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(value!)}</dd>`).join("")}</dl>` : "");
        yield line([`catalogforge-${r.productId}`,index===0?r.title:"",index===0?description:"",index===0?r.categoryKey:"",index===0?r.tags.join(", "):"",options[0]?.[0]??"Title",options[0]?.[1]??"Default Title",options[1]?.[0],options[1]?.[1],options[2]?.[0],options[2]?.[1],v.variant.sku,minorToDecimal(v.priceMinor!.toString()),v.weightGrams,"draft","false"]);
      }
    }
  }
  if (format === "json") yield "]\n";
}
export async function exportEndpoint(request: Request, scopedStoreId?: string) {
  const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  try {
    if (!scopedStoreId) throw new ReviewError("STORE_SCOPE_REQUIRED", 401, "Authenticated store scope is required.");
    const storeId = scopedStoreId;
    if (request.method !== "GET") return new Response(null, {status:405,headers});
    const q = new URL(request.url).searchParams;
    const format = z.enum(["csv","json","shopify"]).parse(q.get("format")??"csv");
    const currency = q.has("currency") ? z.enum(["EUR","GBP","USD"]).parse(q.get("currency")) : undefined;
    const captured = await captureExport(storeId, format, currency);
    const iterator = catalogExport(storeId,captured.revisionIds,format,captured.currency);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({ async pull(controller) {
      try { const {value,done}=await iterator.next(); if(done)controller.close();else controller.enqueue(encoder.encode(value)); }
      catch { controller.error(new Error("Export interrupted. Retry the download.")); }
    }, async cancel() { await iterator.return(); } });
    return new Response(stream,{headers:{...headers,"Content-Type":format==="json"?"application/json; charset=utf-8":"text/csv; charset=utf-8","Content-Disposition":`attachment; filename="catalogforge-published${format==="shopify"?"-shopify":""}.${format==="json"?"json":"csv"}"`}});
  } catch(error) {
    const status=error instanceof ReviewError?error.status:error instanceof IngestionError?error.httpStatus:error instanceof z.ZodError?422:503;
    const message=error instanceof ReviewError||error instanceof IngestionError?error.message:error instanceof z.ZodError?"Choose a supported export format and currency.":"Export unavailable. Retry later.";
    return Response.json({error:{message}},{status,headers});
  }
}
