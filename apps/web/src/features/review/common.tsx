"use client";
import Link from "next/link";
import {usePathname} from "next/navigation";
import { useEffect,useState } from "react";
import { z } from "zod";
export const control="min-h-11 w-full rounded-lg border bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60";
export const panel="rounded-xl border bg-background p-5 shadow-sm";
const navItems = [
  ["/dashboard", "Dashboard"],
  ["/", "Imports"],
  ["/products", "Products"],
  ["/media", "Media"],
  ["/translations", "Translations"],
  ["/shop", "Storefront"],
] as const;
export function CatalogNav() {
 const pathname=usePathname();
 return <aside className="lg:sticky lg:top-6 lg:self-start">
   <div className="flex items-center justify-between gap-3 border-b pb-4 lg:border-0 lg:pb-5"><Link href="/dashboard" className="font-semibold tracking-tight">CatalogForge</Link><span className="rounded-full border px-2 py-1 text-[11px] font-medium text-muted-foreground">LOCAL</span></div>
   <nav aria-label="Catalog navigation" className="grid grid-cols-2 gap-1 border-b py-3 sm:grid-cols-3 lg:grid-cols-1 lg:border-0 lg:py-0">
    {navItems.map(([href, label]) => <Link key={href} href={href} aria-current={(href==="/"?pathname==="/":pathname.startsWith(href))?"page":undefined} className={`flex min-h-11 items-center rounded-md px-3 py-2 text-sm font-medium underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring ${ (href==="/"?pathname==="/":pathname.startsWith(href))?"bg-primary text-primary-foreground":"text-muted-foreground hover:bg-muted hover:text-foreground"}`}>{label}</Link>)}
   </nav>
 </aside>;
}
export function ReviewShell({children}:{children:React.ReactNode}) { return <main className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6 sm:py-10"><div className="grid gap-6 lg:grid-cols-[240px_minmax(0,1fr)]"><CatalogNav /><div className="min-w-0 space-y-6">{children}</div></div></main>; }
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

// Capture client-side links too: beforeunload alone cannot protect App Router navigation.
export function useNavigationGuard(blocked:boolean){
 useEffect(()=>{
  if(!blocked)return;
  const before=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue="";};
  const click=(event:MouseEvent)=>{
   if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
   const link=(event.target as Element)?.closest?.("a[href]") as HTMLAnchorElement|null;
   if(!link||link.target==="_blank"||link.hasAttribute("download"))return;
   const next=new URL(link.href,window.location.href),current=new URL(window.location.href);
   if(next.origin===current.origin&&next.pathname===current.pathname&&next.search===current.search)return;
   if(!window.confirm("Leave this page? Unsaved edits or an unconfirmed request may be lost. Cancel to save or retry first.")){event.preventDefault();event.stopPropagation();}
  };
  // Unlike popstate, navigate fires before App Router can unmount the editor.
  // Section history stays on this pathname, so mounted form state is retained.
  const navigation=(window as Window & {navigation?:EventTarget}).navigation;
  const traverse=(event:Event)=>{
   const next=event as Event & {navigationType?:string;destination?:{url:string}};
   if(next.navigationType!=="traverse"||!next.destination||!event.cancelable)return;
   const target=new URL(next.destination.url);
   if(target.origin===window.location.origin&&target.pathname===window.location.pathname)return;
   if(!window.confirm("Leave this page? Unsaved edits or an unconfirmed request may be lost. Cancel to save or retry first."))event.preventDefault();
  };
  window.addEventListener("beforeunload",before);document.addEventListener("click",click,true);
  navigation?.addEventListener("navigate",traverse);
  return()=>{window.removeEventListener("beforeunload",before);document.removeEventListener("click",click,true);navigation?.removeEventListener("navigate",traverse);};
 },[blocked]);
}
