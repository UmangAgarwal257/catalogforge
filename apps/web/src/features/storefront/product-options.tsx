"use client";
/* eslint-disable @next/next/no-img-element -- Verified bounded local WebP previews. */
import {useState} from "react";
import type {PublicProduct} from "@catalogforge/review/catalog";
import {minorToDecimal} from "@catalogforge/review/contracts";
import {storefrontCopy,type StorefrontLocale} from "./copy";
export function ProductOptions({variants,media=[],language="en"}:{variants:PublicProduct["variants"];media?:PublicProduct["media"];language?:StorefrontLocale}) {
 const [id,setId]=useState(variants[0]!.id);const selected=variants.find(v=>v.id===id)??variants[0]!;
 const text=storefrontCopy(language);
 const images=media.filter(m=>m.variantId===selected.id||m.variantId===null);
 return <section className="h-fit min-w-0 space-y-6 rounded-xl border bg-muted/25 p-6" aria-label={text.chooseVariant}><h2 className="text-lg font-semibold">{text.chooseVariant}</h2>{images.length>0&&<div className="space-y-3">{images.map(m=><img key={m.assetId} src={`/api/media/${m.assetId}`} alt={m.alt} width={600} height={600} className="aspect-square w-full rounded-lg bg-muted object-contain"/>)}</div>}<label className="block text-sm">{text.variant}<select aria-label={text.variant} className="mt-2 min-h-11 w-full rounded-lg border bg-background px-3 text-sm" value={selected.id} onChange={e=>setId(e.target.value)}>{variants.map(v=><option value={v.id} key={v.id}>{Object.entries(v.options).map(([k,value])=>`${k}: ${value}`).join(" · ")||v.sku}</option>)}</select></label><div aria-live="polite" className="space-y-3"><p className="text-3xl font-semibold tracking-tight">{selected.currency} {minorToDecimal(selected.priceMinor)}</p><p className="break-all font-mono text-xs text-muted-foreground">SKU {selected.sku}</p>{selected.weightGrams!==null&&<p className="text-sm">{text.weight}: {selected.weightGrams} g</p>}</div><p className="border-t pt-4 text-sm text-muted-foreground">{text.stock}</p></section>;
}
