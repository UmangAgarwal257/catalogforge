"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import {
  MAX_UPLOAD_BYTES, suppliersSchema, historySchema, detailsSchema, uploadResponseSchema,
  type ImportSummary, type ImportDetails
} from "@catalogforge/ingestion/api-contracts";
import Link from "next/link";
import { SUPPLIER_PROFILES } from "@catalogforge/shared/catalog";
import { Button } from "../../components/ui/button";
import { publicErrors, readResponse, useResource } from "./use-resource";
import { SourcePreview } from "./source-preview";

const active = (item: ImportSummary) => item.status === "PENDING" || item.status === "PROCESSING" || !!item.catalogTask && ["PENDING","RUNNING","WAITING"].includes(item.catalogTask.state);
const pollHistory = (data: { imports: ImportSummary[] }) => data.imports.some(active);
const pollDetails = (data: ImportDetails) => active(data.imported);
const control = "min-h-11 w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50";
const onlineSnapshot = () => navigator.onLine;
const serverOnlineSnapshot = () => true;
function subscribeOnline(listener: () => void) {
  window.addEventListener("online", listener); window.addEventListener("offline", listener);
  return () => { window.removeEventListener("online", listener); window.removeEventListener("offline", listener); };
}

function Notice({ children, retry }: { children: React.ReactNode; retry?: () => void }) {
  return <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm"><p>{children}</p>{retry && <Button type="button" variant="outline" className="mt-3" onClick={retry}>Try again</Button>}</div>;
}
function Loading({ label }: { label: string }) {
  return <div role="status" className="space-y-3 py-4"><p className="text-sm text-muted-foreground">{label}</p><div className="h-12 rounded bg-muted motion-safe:animate-pulse" /></div>;
}
function Status({ item }: { item: ImportSummary }) {
  return <span className={`inline-flex rounded-md border px-2 py-1 font-mono text-xs ${item.status === "FAILED" ? "border-destructive/40 text-destructive" : "bg-muted text-foreground"}`}>{item.status}</span>;
}
function Counts({ item }: { item: ImportSummary }) {
  return <span>{item._count.sourceRows.toLocaleString()} rows saved · {item.totalRows === null ? "total not known yet" : `${item.totalRows.toLocaleString()} expected`}</span>;
}
function Pagination({ label, page, hasMore, busy, change }: { label: string; page: number; hasMore: boolean; busy: boolean; change: (page: number) => void }) {
  return <nav aria-label={label} className="flex flex-wrap items-center justify-between gap-3 pt-4 text-sm">
    <span>Page {page}</span><div className="flex gap-2"><Button variant="outline" disabled={busy || page <= 1} onClick={() => change(page - 1)} aria-label={`Previous ${label} page`}>Previous</Button><Button variant="outline" disabled={busy || !hasMore} onClick={() => change(page + 1)} aria-label={`Next ${label} page`}>Next</Button></div>
  </nav>;
}

export function ImportDashboard() {
  const [profileId,setProfileId]=useState(SUPPLIER_PROFILES[0]!.id);
  const [supplierName,setSupplierName]=useState("");
  const [supplierSaving,setSupplierSaving]=useState(false);
  const supplierAttempt=useRef<{name:string;key:string}|null>(null);
  const [supplierPage, setSupplierPage] = useState(1);
  const [supplier, setSupplier] = useState<{ id: string; name: string } | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [acceptedId, setAcceptedId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [historyPage, setHistoryPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rowPage, setRowPage] = useState(1);
  const [rowSize, setRowSize] = useState(10);
  const [version, setVersion] = useState(0);
  const attempt = useRef<{ key: string; file: File; supplierId: string } | null>(null);
  const uploadController = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const sourceHeading = useRef<HTMLHeadingElement>(null);
  const historyHeading = useRef<HTMLHeadingElement>(null);
  const focusSource = useRef(false);
  const focusHistory = useRef(false);
  const online = useSyncExternalStore(subscribeOnline, onlineSnapshot, serverOnlineSnapshot);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; uploadController.current?.abort(); }; }, []);
  const suppliers = useResource(`/api/suppliers?page=${supplierPage}&pageSize=25`, suppliersSchema,undefined,version);
  const history = useResource(`/api/imports?page=${historyPage}&pageSize=10`, historySchema, pollHistory, version);
  const detail = useResource(selectedId ? `/api/imports/${selectedId}?page=${rowPage}&pageSize=${rowSize}` : null, detailsSchema, pollDetails, version);
  useEffect(() => { if (detail.data && focusSource.current) { focusSource.current = false; sourceHeading.current?.focus(); } }, [detail.data]);
  useEffect(() => { if (history.data && focusHistory.current) { focusHistory.current = false; historyHeading.current?.focus(); } }, [history.data]);

  function selectImport(id: string) { focusSource.current = true; setSelectedId(id); setRowPage(1); }
  function resetAttempt() { attempt.current = null; setAcceptedId(null); setUploadError(null); }
  function selectFile(files: File[]) {
    if (uploading) return;
    if (files.length !== 1) { setFileError("Choose exactly one CSV or XLSX file."); return; }
    const chosen = files[0]!;
    setFile(chosen); resetAttempt();
    setFileError(!/\.(csv|xlsx)$/i.test(chosen.name) ? "Choose a CSV or XLSX spreadsheet." : chosen.size === 0 ? "Choose a file that is not empty." : chosen.size > MAX_UPLOAD_BYTES ? "Choose a spreadsheet no larger than 10 MiB." : null);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || acceptedId) return;
    if (!file || fileError || !supplier) { setUploadError("Choose a supplier and a valid spreadsheet before uploading."); return; }
    if (!attempt.current || attempt.current.file !== file || attempt.current.supplierId !== supplier.id) attempt.current = { key: crypto.randomUUID(), file, supplierId: supplier.id };
    const body = new FormData(); body.set("profileId",profileId); body.set("file", file); body.set("supplierId", supplier.id); body.set("idempotencyKey", attempt.current.key);
    inFlight.current = true; setUploading(true); setUploadError(null);
    const controller = new AbortController(); uploadController.current = controller;
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const result = await readResponse(await fetch("/api/imports", { method: "POST", body, signal: controller.signal }), uploadResponseSchema);
      if (!mounted.current) return;
      setAcceptedId(result.importId); setHistoryPage(1); selectImport(result.importId); setVersion((value) => value + 1);
    } catch (error) {
      if (mounted.current) setUploadError(error instanceof Error && Object.values(publicErrors).includes(error.message) ? error.message : "Upload could not be confirmed. It may already have been accepted. Retry this upload to reuse its request key.");
    } finally { clearTimeout(timeout); inFlight.current = false; if (mounted.current) setUploading(false); }
  }
  const imported = detail.data?.imported;
  const selectedSupplierOnPage = suppliers.data?.suppliers.some((item) => item.id === supplier?.id);
  return <main className="mx-auto w-full max-w-7xl space-y-8 px-4 py-8 sm:px-6 lg:px-8">
    <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-6"><div><p className="mb-2 text-sm font-semibold tracking-wide">CatalogForge</p><h1 className="text-3xl font-semibold tracking-tight">Supplier imports</h1><p className="mt-2 max-w-prose text-sm text-muted-foreground">Preserve supplier spreadsheets and inspect their original records.</p></div><span className="rounded-md border bg-muted px-3 py-2 text-xs font-medium">Local development only</span></header>
    <div className="rounded-lg border bg-muted/40 p-4 text-sm"><strong>Parsing and catalog processing.</strong> COMPLETED means spreadsheet ingestion finished. Profiled uploads continue through cleaning, grouping and Gemini enrichment when free-tier quota permits. Review and approval never publish automatically.</div>
    {!online && <p role="status" className="rounded-lg border p-4 text-sm">You’re offline. Updates resume when connected. Retry an unconfirmed upload with the same attempt; avoid starting a new import.</p>}
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
      <section className="min-w-0 rounded-lg border p-5 sm:p-6" aria-labelledby="upload-heading">
        <h2 id="upload-heading" className="text-lg font-semibold">Upload a spreadsheet</h2><p className="mt-1 text-sm text-muted-foreground">One CSV or XLSX, up to 10 MiB and 10,000 source records.</p>
        <form onSubmit={submit} className="mt-6 space-y-5" aria-busy={uploading}>
          <div><div className="mb-2 flex flex-wrap items-center justify-between gap-2"><label htmlFor="supplier" className="block text-sm font-medium">Supplier (required)</label><Button type="button" variant="outline" onClick={suppliers.refresh} disabled={uploading}>Refresh suppliers</Button></div>
            <select id="supplier" className={control} value={supplier?.id ?? ""} disabled={uploading || suppliers.loading || !suppliers.data?.suppliers.length} onChange={(event) => { const item = suppliers.data?.suppliers.find((item) => item.id === event.target.value); setSupplier(item ?? null); resetAttempt(); }} aria-describedby="supplier-hint">
              <option value="">Choose a supplier</option>{supplier && !selectedSupplierOnPage && <option value={supplier.id}>{supplier.name}</option>}{suppliers.data?.suppliers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            <p id="supplier-hint" className="mt-2 text-xs text-muted-foreground">Only suppliers in the configured development store are available.</p>
            {suppliers.loading && <Loading label="Loading suppliers…" />}
            {suppliers.error && <div className="mt-3"><Notice retry={suppliers.refresh}>{suppliers.error}</Notice></div>}
            {suppliers.data?.suppliers.length === 0 && <p className="mt-3 text-sm">No suppliers found. Create a supplier below to get started.</p>}
            {(supplierPage > 1 || suppliers.data?.hasMore) && <Pagination label="suppliers" page={supplierPage} hasMore={suppliers.data?.hasMore ?? false} busy={suppliers.loading || uploading} change={setSupplierPage} />}
          </div>
          <div className="rounded border p-3"><label htmlFor="new-supplier" className="text-sm">New supplier name</label><input id="new-supplier" className={control} maxLength={150} value={supplierName} onChange={e=>setSupplierName(e.target.value)} disabled={supplierSaving}/><Button type="button" variant="outline" className="mt-2" disabled={supplierSaving||!supplierName.trim()} onClick={async()=>{setSupplierSaving(true);try{const name=supplierName.trim();if(!supplierAttempt.current||supplierAttempt.current.name!==name)supplierAttempt.current={name,key:crypto.randomUUID()};const response=await fetch("/api/suppliers",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name,requestId:supplierAttempt.current.key})});if(!response.ok)throw Error("Supplier creation could not be confirmed. Retry the same name.");const item=await response.json() as {id:string;name:string};setSupplier(item);resetAttempt();setSupplierName("");supplierAttempt.current=null;setVersion(n=>n+1);}catch(e){setUploadError(e instanceof Error?e.message:"Could not create supplier.");}finally{setSupplierSaving(false);}}}>Create supplier</Button></div>
          <div><label htmlFor="mapping-profile" className="text-sm font-medium">Supplier mapping profile</label><select id="mapping-profile" className={control} value={profileId} disabled={uploading} onChange={e=>{setProfileId(e.target.value);resetAttempt();}}>{SUPPLIER_PROFILES.map(p=><option key={p.id} value={p.id}>{p.name} · v{p.version}</option>)}</select><p className="mt-2 text-xs text-muted-foreground">{SUPPLIER_PROFILES.find(p=>p.id===profileId)?.description}</p><details className="mt-2 text-xs"><summary className="cursor-pointer">Required header order</summary><ol className="list-inside list-decimal">{SUPPLIER_PROFILES.find(p=>p.id===profileId)?.headers.map((h,i)=><li key={i}>Column {i+1}: {h}</li>)}</ol><p>Headers must match exactly on every sheet. Extra columns are preserved. The selected profile is frozen for this import.</p></details></div>
          <div onDragOver={(event) => { event.preventDefault(); if (!uploading) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); selectFile(Array.from(event.dataTransfer.files)); }} className={`rounded-lg border-2 border-dashed p-5 text-center ${dragging ? "border-primary bg-accent" : "border-border bg-muted/30"}`}>
            <svg className="mx-auto mb-3 h-7 w-7 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5" /></svg>
            <label htmlFor="spreadsheet" className="block text-sm font-medium">Drop a spreadsheet here, or choose a file</label>
            <input id="spreadsheet" type="file" accept=".csv,.xlsx" disabled={uploading} onChange={(event) => { if (event.target.files?.length) selectFile(Array.from(event.target.files)); }} aria-invalid={!!fileError} aria-describedby="file-hint file-error" className="mt-4 block min-h-11 w-full min-w-0 rounded text-xs file:mr-3 file:min-h-11 file:rounded-md file:border file:bg-background file:px-3 file:text-sm focus-visible:outline-2 focus-visible:outline-ring" />
            <p id="file-hint" className="mt-3 text-xs text-muted-foreground">Original files are kept privately. Parsing runs in the worker.</p>
          </div>
          {file && <p className="break-words text-sm"><span className="font-medium">{file.name}</span><span className="ml-2 text-muted-foreground">{file.size.toLocaleString()} bytes</span></p>}
          <div id="file-error">{fileError && <p role="alert" className="text-sm text-destructive">{fileError}</p>}</div>
          {uploadError && <Notice>{uploadError}</Notice>}
          {acceptedId && <p role="status" className="rounded-lg bg-muted p-3 text-sm">Upload accepted. View its actual ingestion status below.</p>}
          <div className="flex flex-wrap gap-2"><Button type="submit" disabled={uploading || !!acceptedId || !supplier || !file || !!fileError}>{uploading ? "Uploading…" : uploadError ? "Retry upload" : "Upload spreadsheet"}</Button>{(acceptedId || uploadError) && <Button type="button" variant="outline" disabled={uploading} onClick={resetAttempt}>Start new import</Button>}</div>
          {uploadError && <p className="text-xs text-muted-foreground">Retry keeps this attempt’s key. “Start new import” creates a new request; the previous one may already exist.</p>}
        </form>
      </section>
      <section className="min-w-0 rounded-lg border p-5 sm:p-6" aria-labelledby="history-heading">
        <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="history-heading" ref={historyHeading} tabIndex={-1} className="text-lg font-semibold focus-visible:outline-2 focus-visible:outline-ring">Import history</h2><Button variant="outline" onClick={history.refresh}>Refresh history</Button></div>
        <p className="mt-2 text-sm text-muted-foreground">Parsing status and durable catalog-processing status are separate.</p>
        {history.loading && <Loading label="Loading import history…" />}{history.error && <div className="mt-4"><Notice retry={history.refresh}>{history.error}</Notice></div>}
        {history.data && <>{history.data.imports.length === 0 ? <p className="py-8 text-sm text-muted-foreground">No imports on this page. Upload a spreadsheet to get started.</p> : <ul className="mt-4 divide-y">{history.data.imports.map((item) => <li key={item.id} className="space-y-2 py-4">
          <div className="flex flex-wrap items-start justify-between gap-2"><span className="min-w-0 break-words text-sm font-medium">{item.originalFilename}</span><Status item={item} />{item.catalogTask&&<span className="text-xs">Catalog: {item.catalogTask.state==="COMPLETED"?"Processing settled":item.catalogTask.state} · {item.catalogTask.phase}</span>}</div>
          <p className="break-words text-xs text-muted-foreground">{item.supplier?.name ?? item.supplierId} · <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time></p>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><Counts item={item} /><Button variant="outline" onClick={() => selectImport(item.id)} aria-label={`View ${item.originalFilename}`} aria-pressed={selectedId === item.id}>View rows</Button></div>
          {item.errorCode && <p className="text-sm">{publicErrors[item.errorCode] ?? "This import needs attention. Inspect its details before starting another import."}</p>}
        </li>)}</ul>}<Pagination label="history" page={historyPage} hasMore={history.data.hasMore} busy={history.loading} change={(page) => { focusHistory.current = true; setHistoryPage(page); }} /></>}
      </section>
    </div>
    <section className="min-w-0 rounded-lg border p-5 sm:p-6" aria-labelledby="source-heading">
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="source-heading" ref={sourceHeading} tabIndex={-1} className="text-lg font-semibold focus-visible:outline-2 focus-visible:outline-ring">Original source rows</h2>{selectedId && <Button variant="outline" onClick={detail.refresh}>Refresh source rows</Button>}</div>
      {!selectedId && <p className="py-8 text-sm text-muted-foreground">Select an import to inspect its original cells and sheet coordinates.</p>}
      {detail.loading && <Loading label="Loading original source rows…" />}{detail.error && <div className="mt-4"><Notice retry={detail.refresh}>{detail.error}</Notice></div>}
      {imported && detail.data && <div className="mt-4 space-y-4">
        <div className="flex flex-wrap items-center gap-3"><p className="break-words font-medium">{imported.originalFilename}</p><Status item={imported} /></div>
        <p role="status" className="text-sm text-muted-foreground"><Counts item={imported} /></p>
        {detail.data.pipeline&&<section aria-label="Catalog pipeline" className="space-y-3 rounded-lg border bg-muted/30 p-4"><h3 className="font-medium">Catalog processing: {detail.data.pipeline.state==="COMPLETED"?"Processing settled":detail.data.pipeline.state} · {detail.data.pipeline.phase}</h3><dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">{Object.entries({Parsed:imported._count.sourceRows,Cleaned:detail.data.pipeline.cleaned,Grouped:detail.data.pipeline.grouped,"Proposals created":detail.data.pipeline.proposals,"Awaiting enrichment":detail.data.pipeline.awaitingEnrichment,"Enriched successfully":detail.data.pipeline.enriched,"Review required (products)":detail.data.pipeline.reviewRequired,"Source rows requiring attention":detail.data.pipeline.needsReview,"Failed (rows)":detail.data.pipeline.failed,"Enrichment failed":detail.data.pipeline.enrichmentFailed,Stale:detail.data.pipeline.enrichmentStale,"Enrichment blocked":detail.data.pipeline.enrichmentBlocked}).map(([k,v])=><div key={k}><dt className="text-muted-foreground">{k}</dt><dd className="font-semibold">{v}</dd></div>)}</dl>{detail.data.pipeline.nextAttemptAt&&<p className="text-sm">Next retry eligible: <time dateTime={detail.data.pipeline.nextAttemptAt}>{new Date(detail.data.pipeline.nextAttemptAt).toLocaleString()}</time>. The worker is released while waiting.</p>}{detail.data.pipeline.errorCode&&<p role="status" className="text-sm">{detail.data.pipeline.errorCode}: {detail.data.pipeline.errorMessage}</p>}{detail.data.pipeline.needsMapping&&<p className="text-sm">Needs mapping. Original rows are preserved. Check the required header order and start a new import with the correct profile.</p>}{[...(detail.data.pipeline.blockedReasons??[]),...(detail.data.pipeline.enrichmentIssues??[])].map((issue,i)=><p key={`${issue.revisionId}-${i}`} className="text-sm">Enrichment requires attention: {issue.code}. {issue.code==="ONE_PRODUCT_EVIDENCE_LIMIT"?"This product exceeds the current 100-source-row AI context limit; its merchant draft and evidence remain available.":"Open the proposal to inspect its saved evidence and review requirements."}</p>)}<p className="text-xs">Processing settled means all selected rows have durable outcomes and enrichment work is terminal or explicitly blocked. It does not mean AI succeeded. Review-required products can also be successfully enriched; these counts overlap. Nothing is automatically approved or published.</p><div className="flex flex-wrap gap-3">{detail.data.pipeline.proposalLinks.map(p=><Link key={p.id} className="break-words text-sm underline" href={`/products/${p.productId}/revisions/${p.id}`}>{p.title??"Untitled proposal"} · {p.status}</Link>)}</div>{detail.data.pipeline.exceptions.length>0&&<details><summary className="cursor-pointer text-sm">Rows that did not form a proposal</summary>{detail.data.pipeline.exceptions.map(e=><div key={e.sourceRowId} className="mt-2 text-xs"><p>{e.sourceRow.sheetName}, row {e.sourceRow.rowNumber} · {e.outcome}</p><pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(e.issues,null,2)}</pre></div>)}{detail.data.pipeline.exceptionsLimited&&<p className="text-xs">Showing the first 25 exceptions. Original rows remain available below.</p>}</details>}</section>}
        {imported.errorCode && <Notice>{publicErrors[imported.errorCode] ?? "Parsing could not finish. Original evidence was retained. Check the worker before starting another import."}</Notice>}
        {imported.status === "FAILED" && <p className="text-sm">Any rows below are partial evidence from an unsuccessful import.</p>}
        {detail.data.rows.length === 0 ? <p className="py-4 text-sm text-muted-foreground">{active(imported) ? "No source rows saved yet. Parsing may still be validating the file." : imported._count.sourceRows === 0 ? imported.status === "COMPLETED" ? "This import has no saved source records. Blank and header-only inputs contribute no data rows." : "No source records were saved. Inspect the error before intentionally starting another import." : "No rows on this page. Go back to a previous page."}</p> : <SourcePreview rows={detail.data.rows} />}
        <div className="flex flex-wrap items-end justify-between gap-3"><div><label htmlFor="row-size" className="mb-1 block text-sm">Rows per page</label><select id="row-size" value={rowSize} onChange={(event) => { focusSource.current = true; setRowSize(Number(event.target.value)); setRowPage(1); }} className={control}><option value={10}>10</option><option value={25}>25</option></select></div><Pagination label="source rows" page={rowPage} hasMore={rowPage * rowSize < imported._count.sourceRows} busy={detail.loading} change={(page) => { focusSource.current = true; setRowPage(page); }} /></div>
      </div>}
    </section>
    <footer className="border-t pt-4 text-xs text-muted-foreground">Unauthenticated local development interface. Keep it on localhost; public deployment requires access controls and shared private storage.</footer>
  </main>;
}
