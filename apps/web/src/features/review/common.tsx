"use client";
import Link from "next/link";
import { useEffect,useState } from "react";
import { z } from "zod";
export const control="min-h-11 w-full rounded-lg border bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60";
export const panel="rounded-xl border bg-background p-5 shadow-sm";
export function ReviewShell({children}:{children:React.ReactNode}) { return <main className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6 sm:py-10"><nav aria-label="Catalog navigation" className="flex flex-wrap items-center gap-6 border-b pb-4"><Link href="/" className="font-semibold tracking-tight">CatalogForge</Link><Link href="/" className="text-sm underline underline-offset-4">Supplier imports</Link><Link href="/products" className="text-sm underline underline-offset-4">Product review</Link><Link href="/shop" className="text-sm underline underline-offset-4">Storefront</Link></nav>{children}</main>; }
export class ApiFailure extends Error { constructor(message:string,public status:number){super(message);} }
export async function request<T>(url:string,schema:z.ZodType<T>,init?:RequestInit):Promise<T> {
 const response=await fetch(url,{...init,cache:"no-store"}); let body:unknown;
 try {body=await response.json();} catch {throw new ApiFailure("The server response could not be confirmed. Retry the same action.",response.status);}
 if(!response.ok){const error=z.object({error:z.object({message:z.string().max(2000),issues:z.array(z.object({field:z.string(),message:z.string()})).optional(),fields:z.array(z.object({field:z.string(),message:z.string()})).optional()})}).safeParse(body); throw new ApiFailure(error.success?[error.data.error.message,...(error.data.error.issues??error.data.error.fields??[]).map(i=>`${i.field}: ${i.message}`)].join(" "):"The request failed. Try again.",response.status);}
 return schema.parse(body);
}
export function Pager({page,hasMore,change,label}:{page:number;hasMore:boolean;change:(p:number)=>void;label:string}) {return <nav aria-label={label} className="flex items-center justify-between gap-3"><span className="text-sm text-muted-foreground">Page {page}</span><div className="flex gap-2"><button className={`${control} w-auto`} disabled={page===1} onClick={()=>change(page-1)}>Previous</button><button className={`${control} w-auto`} disabled={!hasMore} onClick={()=>change(page+1)}>Next</button></div></nav>;}

export function useReviewQuery<T>(url:string,schema:z.ZodType<T>,version=0){
 const key=`${url}:${version}`;
 const [result,setResult]=useState<{key:string;data:T|null;error:string}>({key:"",data:null,error:""});
 useEffect(()=>{const controller=new AbortController();request(url,schema,{signal:controller.signal}).then(data=>{if(!controller.signal.aborted)setResult({key,data,error:""});}).catch(e=>{if(!controller.signal.aborted)setResult({key,data:null,error:e instanceof Error?e.message:"Could not load this view."});});return()=>controller.abort();},[url,schema,key]);
 return result.key===key?result:{key,data:null,error:""};
}
