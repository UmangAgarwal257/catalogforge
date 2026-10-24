import { z } from "zod";
import { getDb, type Prisma } from "@catalogforge/db";
import { safeHtml } from "@catalogforge/enrichment/validation";
import { TAXONOMY } from "@catalogforge/shared/catalog";
import { minorToDecimal } from "./contracts";

export function storefrontStoreId() {
  return z.uuid().parse(process.env.NODE_ENV === "production" ? process.env.STOREFRONT_STORE_ID : process.env.STOREFRONT_STORE_ID ?? process.env.DEV_STORE_ID);
}
export const visibleProducts = (storeId: string): Prisma.ProductWhereInput => ({ storeId, archivedAt: null,
  publishedRevision: { is: { status: "APPROVED", publication: { isNot: null } } } });
export function categoryFromPath(value: string): string | null {
  try { const decoded = decodeURIComponent(value); return TAXONOMY.categories.some(c => c.key === decoded) ? decoded : null; }
  catch { return null; }
}
export function categoryLabel(key: string) { return TAXONOMY.categories.find(c => c.key === key)?.label ?? key; }
export function money(price: string, currency: string) { return `${currency} ${minorToDecimal(price)}`; }
export async function listPublished(storeId: string, page = 1, category?: string) {
  z.uuid().parse(storeId); z.number().int().min(1).max(10000).parse(page);
  const rows = await getDb().product.findMany({ where: { ...visibleProducts(storeId), ...(category ? { publishedRevision: { is: { status: "APPROVED", publication: { isNot: null }, categoryKey: category } } } : {}) },
    orderBy: { id: "asc" }, skip: (page - 1) * 20, take: 21, select: { id: true, publishedRevision: { select: {
      title: true, categoryKey: true, variants: { orderBy: [{ priceMinor: "asc" }, { variantId: "asc" }], take: 1, select: { priceMinor: true, currency: true } }
    } } } });
  return { products: rows.slice(0, 20).map(p => ({ id: p.id, title: p.publishedRevision!.title!, categoryKey: p.publishedRevision!.categoryKey!,
    priceMinor: p.publishedRevision!.variants[0]!.priceMinor!.toString(), currency: p.publishedRevision!.variants[0]!.currency! })), hasMore: rows.length > 20 };
}
export async function publishedProduct(storeId: string, productId: string) {
  if (!z.uuid().safeParse(productId).success) return null;
  const product = await getDb().product.findFirst({ where: { ...visibleProducts(storeId), id: productId }, select: { id: true,
    publishedRevision: { select: { id: true, title: true, descriptionHtml: true, categoryKey: true, tags: true, attributes: true,
      variants: { orderBy: { variantId: "asc" }, take: 1001, select: { variantId: true, options: true, priceMinor: true, currency: true, weightGrams: true, variant: { select: { sku: true } } } } } } } });
  if (!product || product.publishedRevision!.variants.length > 1000) return null;
  const r = product.publishedRevision!;
  return { id: product.id, revisionId: r.id, title: r.title!, descriptionHtml: safeHtml(r.descriptionHtml!), categoryKey: r.categoryKey!,
    tags: r.tags, attributes: r.attributes as Record<string, string | null>, variants: r.variants.map(v => ({ id: v.variantId, sku: v.variant.sku,
      options: v.options as Record<string, string>, priceMinor: v.priceMinor!.toString(), currency: v.currency!, weightGrams: v.weightGrams })) };
}
export type PublicProduct = NonNullable<Awaited<ReturnType<typeof publishedProduct>>>;
