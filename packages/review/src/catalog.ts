import { localeFrom } from "./translations";
import { z } from "zod";
import { getDb, type Prisma } from "@catalogforge/db";
import { safeHtml } from "@catalogforge/enrichment/validation";
import { TAXONOMY } from "@catalogforge/shared/catalog";
import { minorToDecimal } from "./contracts";

export function storefrontStoreId() {
  return z.uuid().parse(process.env.STOREFRONT_STORE_ID);
}
export const visibleProducts = (storeId: string): Prisma.ProductWhereInput => ({ storeId, archivedAt: null,
  publishedRevision: { is: { status: "APPROVED", publication: { isNot: null } } } });
export function categoryFromPath(value: string): string | null {
  try { const decoded = decodeURIComponent(value); return TAXONOMY.categories.some(c => c.key === decoded) ? decoded : null; }
  catch { return null; }
}
export function categoryLabel(key: string) { return TAXONOMY.categories.find(c => c.key === key)?.label ?? key; }
export function money(price: string, currency: string) { return `${currency} ${minorToDecimal(price)}`; }
export async function listPublished(storeId: string, page = 1, category?: string, language="en") {
  z.uuid().parse(storeId); z.number().int().min(1).max(10000).parse(page);
  const rows = await getDb().product.findMany({ where: { ...visibleProducts(storeId), ...(category ? { publishedRevision: { is: { status: "APPROVED", publication: { isNot: null }, categoryKey: category } } } : {}) },
    orderBy: { id: "asc" }, skip: (page - 1) * 20, take: 21, select: { id: true, publishedRevision: { select: {
      publication:{select:{mediaSnapshot:true,translationsSnapshot:true}}, title: true, categoryKey: true, variants: { orderBy: [{ priceMinor: "asc" }, { variantId: "asc" }], take: 1, select: { priceMinor: true, currency: true } }
    } } } });
  return { products: rows.slice(0, 20).map(p => {
    const translation = translatedFields(p.publishedRevision!.publication?.translationsSnapshot, language);
    return { id: p.id, title: translation?.title ?? p.publishedRevision!.title!, language: translation ? localeFrom(language) : "en", image: mediaSnapshot(p.publishedRevision!.publication?.mediaSnapshot)[0] ?? null, categoryKey: p.publishedRevision!.categoryKey!,
      priceMinor: p.publishedRevision!.variants[0]!.priceMinor!.toString(), currency: p.publishedRevision!.variants[0]!.currency! };
  }), hasMore: rows.length > 20 };
}
export async function publishedProduct(storeId: string, productId: string,language="en") {
  if (!z.uuid().safeParse(productId).success) return null;
  const product = await getDb().product.findFirst({ where: { ...visibleProducts(storeId), id: productId }, select: { id: true,
    publishedRevision: { select: { publication:{select:{mediaSnapshot:true,translationsSnapshot:true}}, id: true, title: true, descriptionHtml: true, categoryKey: true, tags: true, attributes: true,
      variants: { orderBy: { variantId: "asc" }, take: 1001, select: { variantId: true, options: true, priceMinor: true, currency: true, weightGrams: true, variant: { select: { sku: true } } } } } } } });
  if (!product || product.publishedRevision!.variants.length > 1000) return null;
  const r = product.publishedRevision!, translated=translatedFields(product.publishedRevision!.publication?.translationsSnapshot,language);
  const attributes={...r.attributes as Record<string,string|null>}, productTags=[...r.tags];
  for(const [path,value]of Object.entries(translated??{})){if(path.startsWith("attributes."))attributes[path.slice(11)]=value;if(path.startsWith("tags."))productTags[Number(path.slice(5))]=value;}
  return { id: product.id, revisionId: r.id, language:translated?localeFrom(language):"en",media:mediaSnapshot(r.publication?.mediaSnapshot), title: translated?.title??r.title!, descriptionHtml: safeHtml(translated?.descriptionHtml??r.descriptionHtml!), categoryKey: r.categoryKey!,
    tags: productTags, attributes, variants: r.variants.map(v => ({ id: v.variantId, sku: v.variant.sku,
      options: v.options as Record<string, string>, priceMinor: v.priceMinor!.toString(), currency: v.currency!, weightGrams: v.weightGrams })) };
}
export type PublicProduct = NonNullable<Awaited<ReturnType<typeof publishedProduct>>>;

export const mediaSnapshot=(value:unknown)=>z.array(z.object({assetId:z.uuid(),variantId:z.uuid().nullable(),primary:z.boolean(),alt:z.string()})).catch([]).parse(value);
function translatedFields(value:unknown,language:string){
 const locale=localeFrom(language);if(locale==="en")return null;
 const result=z.record(z.string(),z.object({sourceHash:z.string(),translationId:z.string(),content:z.record(z.string(),z.string())})).safeParse(value);
 return result.success?result.data[locale]?.content??null:null;
}
