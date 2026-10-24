"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { CatalogNav, panel, control } from "../review/common";
import { z } from "zod";

const dashboardWire = z.object({
  kpis: z.object({
    totalProducts: z.number(), needingReview: z.number(), approved: z.number(),
    published: z.number(), activeImports: z.number(), failedImports: z.number(), quotaPaused:z.number(),
  }),
  imports: z.array(z.object({
    id: z.string(), originalFilename: z.string(), status: z.string(), totalRows: z.number().nullable(),
    createdAt: z.string(), errorMessage: z.string().nullable(), supplier: z.object({ name: z.string() }), catalogTask:z.object({state:z.string(),phase:z.string(),errorCode:z.string().nullable(),nextAttemptAt:z.string().nullable()}).nullable(),
  })),
  failures:z.array(z.object({id:z.string(),originalFilename:z.string(),status:z.string(),errorMessage:z.string().nullable(),catalogTask:z.object({errorCode:z.string().nullable(),errorMessage:z.string().nullable()}).nullable()})),
  actions: z.array(z.object({
    id: z.string(), productId: z.string(), title: z.string().nullable(), status: z.string(),
    editVersion: z.number(), createdAt: z.string(), product: z.object({ supplier: z.object({ name: z.string() }) }),
  })),
});
type DashboardData = z.infer<typeof dashboardWire>;

const kpiMeta = [
  ["totalProducts", "Total products", "All active product identities"],
  ["needingReview", "Open proposals", "Draft and review-required revisions"],
  ["approved", "Approved revisions", "Includes historical approved snapshots"],
  ["published", "Published", "Visible in the storefront"],
  ["activeImports", "Unsettled imports", "Parsing, processing or waiting for capacity"],
  ["failedImports", "Failed imports", "Parsing or catalog task failed"],
] as const;

function LoadingCards() {
  return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 6 }, (_, index) => <div key={index} className="h-28 motion-safe:animate-pulse rounded-xl border bg-muted" />)}</div>;
}

function StatusPill({ status }: { status: string }) {
  return <span className="rounded-full border bg-muted px-2.5 py-1 text-xs font-medium">{status.replaceAll("_", " ")}</span>;
}

export function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/dashboard", { cache: "no-store", signal: controller.signal })
      .then(async response => {
        const body: unknown = await response.json();
        if (!response.ok) throw new Error(z.object({ error: z.object({ message: z.string() }) }).safeParse(body).data?.error.message ?? "Dashboard could not be loaded.");
        return dashboardWire.parse(body);
      })
      .then(setData)
      .catch(errorValue => { if (!controller.signal.aborted) setError(errorValue instanceof Error ? errorValue.message : "Dashboard could not be loaded."); });
    return () => controller.abort();
  }, [retry]);

  return <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 sm:py-10"><div className="grid gap-6 lg:grid-cols-[240px_minmax(0,1fr)]"><CatalogNav /><div className="min-w-0 space-y-8">
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div><p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Merchant workspace</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">Dashboard</h1><p className="mt-2 max-w-prose text-sm text-muted-foreground">See what needs attention and move a catalog from supplier file to storefront.</p></div>
      <Link href="/" className={`${control} w-auto bg-primary text-primary-foreground text-center no-underline`}>Start an import</Link>
    </header>
    {error ? <div role="alert" className="rounded-xl border border-destructive/40 bg-destructive/5 p-5"><p className="font-medium">Couldn’t load the dashboard</p><p className="mt-1 text-sm text-muted-foreground">{error}</p><button type="button" className={`${control} mt-4 w-auto`} onClick={() => {setError("");setData(null);setRetry(value => value + 1);}}>Try again</button></div> : !data ? <LoadingCards /> : <><section aria-label="Catalog KPIs" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{kpiMeta.map(([key, label, description]) => <Link key={key} href={key === "needingReview" ? "/products?status=OPEN" : key === "activeImports" ? "/#import-history" : key === "failedImports" ? "#failed-imports" : key === "published" ? "/shop" : key === "approved" ? "/products?status=APPROVED" : "/products?status=ALL"} className={`${panel} transition hover:border-primary`}><p className="text-sm text-muted-foreground">{label}</p><p className="mt-2 text-3xl font-semibold tracking-tight">{data.kpis[key]}</p><p className="mt-1 text-xs text-muted-foreground">{description}</p></Link>)}</section>
      <p className="text-sm text-muted-foreground">{data.kpis.quotaPaused} imports paused for Gemini capacity. Pauses are included in unsettled imports and are not failures. Proposal, approval and publication counts overlap; they must not be added together.</p><div className="grid gap-6 lg:grid-cols-[1.25fr_1fr]"><section className={`${panel} space-y-4`} aria-labelledby="action-heading"><div className="flex items-center justify-between gap-4"><div><h2 id="action-heading" className="text-lg font-semibold">Products requiring action</h2><p className="mt-1 text-sm text-muted-foreground">Review these drafts before they can be published.</p></div><Link href="/products" className="text-sm underline underline-offset-4">View all</Link></div>{!data.actions.length ? <div className="rounded-lg border border-dashed p-6 text-center"><p className="font-medium">All caught up</p><p className="mt-1 text-sm text-muted-foreground">No drafts or unresolved proposals need attention.</p></div> : <ul className="divide-y">{data.actions.map(item => <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-3"><div className="min-w-0"><Link href={`/products/${item.productId}/revisions/${item.id}`} className="font-medium underline underline-offset-4">{item.title ?? "Untitled product"}</Link><p className="mt-1 truncate text-xs text-muted-foreground">{item.product.supplier.name} · Version {item.editVersion}</p></div><StatusPill status={item.status} /></li>)}</ul>}</section>
        <section className={`${panel} space-y-4`} aria-labelledby="imports-heading"><div className="flex items-center justify-between gap-4"><div><h2 id="imports-heading" className="text-lg font-semibold">Recent imports</h2><p className="mt-1 text-sm text-muted-foreground">Latest durable processing activity.</p></div><Link href="/#import-history" className="text-sm underline underline-offset-4">Open imports</Link></div>{!data.imports.length ? <div className="rounded-lg border border-dashed p-6 text-center"><p className="font-medium">No imports yet</p><p className="mt-1 text-sm text-muted-foreground">Upload a supplier spreadsheet to begin.</p><Link href="/" className="mt-3 inline-flex min-h-11 items-center rounded-md bg-primary px-4 text-sm text-primary-foreground">Upload spreadsheet</Link></div> : <ul className="divide-y">{data.imports.map(item => <li key={item.id} className="py-3"><div className="flex items-center justify-between gap-3"><Link href={`/?import=${item.id}#import-history`} className="min-w-0 truncate font-medium underline underline-offset-4">{item.originalFilename}</Link><StatusPill status={item.status} /></div>{item.catalogTask&&<p className="mt-1 text-xs text-muted-foreground">Catalog: {item.catalogTask.state==="COMPLETED"?"Processing settled":item.catalogTask.state} · {item.catalogTask.phase}{item.catalogTask.errorCode?` · ${item.catalogTask.errorCode}`:""}</p>}<p className="mt-1 text-xs text-muted-foreground">{item.supplier.name} · {item.totalRows === null ? "Rows pending" : `${item.totalRows.toLocaleString()} rows`} · {new Date(item.createdAt).toLocaleDateString()}</p>{item.errorMessage && <p className="mt-1 text-xs text-destructive">{item.errorMessage}</p>}</li>)}</ul>}</section></div><section id="failed-imports" className={`${panel} space-y-4`}><h2 className="text-lg font-semibold">Failed imports</h2><p className="text-sm text-muted-foreground">Up to six most recent failures. Open a file to inspect its durable errors and source rows; opening it does not retry processing.</p>{!data.failures.length?<p className="text-sm">No failed imports.</p>:<ul className="divide-y">{data.failures.map(item=><li key={item.id} className="py-3"><Link className="break-words font-medium underline" href={`/?import=${item.id}#source-preview`}>{item.originalFilename}</Link><p className="mt-1 text-sm text-destructive">{item.errorMessage??item.catalogTask?.errorMessage??item.catalogTask?.errorCode??"Inspect this import for its failure reason."}</p></li>)}</ul>}</section></>}
  </div></div></main>;
}
