import {notFound} from "next/navigation";
import Link from "next/link";
import {publishedProduct,storefrontStoreId} from "@catalogforge/review/catalog";
import {ProductOptions} from "../../../../features/storefront/product-options";
import {storefrontCategoryLabel,storefrontCopy,storefrontLocale} from "../../../../features/storefront/copy";
export const dynamic="force-dynamic";
export default async function Page({params,searchParams}:{params:Promise<{productId:string}>;searchParams:Promise<{lang?:string}>}) {
 const query=await searchParams,locale=storefrontLocale(query.lang),text=storefrontCopy(locale);
 const p=await publishedProduct(storefrontStoreId(),(await params).productId,locale);if(!p)notFound();
 return <article className="space-y-8"><Link className="text-sm underline" href={`/shop/collections/${encodeURIComponent(p.categoryKey)}?lang=${locale}`}>← {text.back}: {storefrontCategoryLabel(p.categoryKey,locale)}</Link><div className="grid gap-10 md:grid-cols-2"><section className="min-w-0 space-y-6"><p className="text-xs uppercase tracking-widest text-muted-foreground">{storefrontCategoryLabel(p.categoryKey,locale)}</p><h1 className="break-words text-4xl font-semibold tracking-tight">{p.title}</h1><div className="space-y-3 break-words text-sm leading-7 [&_li]:ml-5 [&_li]:list-disc [&_p]:my-3" dangerouslySetInnerHTML={{__html:p.descriptionHtml}}/><dl className="divide-y">{Object.entries(p.attributes).filter(([,v])=>v!==null).map(([k,v])=><div key={k} className="grid grid-cols-2 gap-4 py-3 text-sm"><dt className="break-words text-muted-foreground">{k}</dt><dd className="break-words">{v}</dd></div>)}</dl>{!!p.tags.length&&<ul aria-label={locale==="de"?"Produktkennzeichnungen":locale==="fr"?"Étiquettes du produit":"Product tags"} className="flex flex-wrap gap-2">{p.tags.map(t=><li key={t} className="rounded-full border px-3 py-1 text-xs">{t}</li>)}</ul>}</section><ProductOptions variants={p.variants} media={p.media} language={locale}/>{p.language!==locale&&locale!=="en"&&<p role="status" className="text-sm text-muted-foreground">{text.unavailable}</p>}</div></article>;
}
