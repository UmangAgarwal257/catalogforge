"use client";
import {useState} from "react";
import type {PublicProduct} from "@catalogforge/review/catalog";
import {minorToDecimal} from "@catalogforge/review/contracts";
export function ProductOptions({variants}:{variants:PublicProduct["variants"]}) {
 const [id,setId]=useState(variants[0]!.id);const selected=variants.find(v=>v.id===id)??variants[0]!;
 return <section className="h-fit min-w-0 space-y-6 rounded-xl border bg-muted/25 p-6" aria-label="Choose a variant"><h2 className="text-lg font-semibold">Choose your variant</h2><label className="block text-sm">Variant<select className="mt-2 min-h-11 w-full rounded-lg border bg-background px-3 text-sm" value={selected.id} onChange={e=>setId(e.target.value)}>{variants.map(v=><option value={v.id} key={v.id}>{Object.entries(v.options).map(([k,value])=>`${k}: ${value}`).join(" · ")||v.sku}</option>)}</select></label><div aria-live="polite" className="space-y-3"><p className="text-3xl font-semibold tracking-tight">{selected.currency} {minorToDecimal(selected.priceMinor)}</p><p className="break-all font-mono text-xs text-muted-foreground">SKU {selected.sku}</p>{selected.weightGrams!==null&&<p className="text-sm">Weight: {selected.weightGrams} g</p>}</div><p className="border-t pt-4 text-sm text-muted-foreground">Stock availability has not been provided. This catalog preview does not accept orders.</p></section>;
}
