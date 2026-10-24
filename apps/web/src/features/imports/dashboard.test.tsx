// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
vi.mock("next/navigation",()=>({usePathname:()=>"/"}));
import { ImportDashboard } from "./dashboard";
import { SourcePreview } from "./source-preview";
import { useResource } from "./use-resource";
import { detailsSchema, type ImportDetails, type ImportSummary } from "@catalogforge/ingestion/api-contracts";

const supplierId = "00000000-0000-4000-8000-000000000001";
const importId = "00000000-0000-4000-8000-000000000002";
const otherId = "00000000-0000-4000-8000-000000000003";
const summary: ImportSummary = { id: importId, supplierId, supplier: { name: "Pots supplier" }, originalFilename: "pots.csv", status: "COMPLETED", totalRows: 11,
  errorCode: null, errorMessage: null, createdAt: "2026-01-01T00:00:00Z", startedAt: null, finishedAt: null, _count: { sourceRows: 11 } };
const details: ImportDetails = { imported: summary, rows: [{ id: otherId, sheetIndex: 1, sheetName: "Pots", rowNumber: 7, status: "PENDING", issues: [], rawCells: [
  { columnIndex: 0, header: "Notes", value: "00123" }, { columnIndex: 1, header: "Notes", value: '<script>alert("x")</script>' }
] }] };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
let fetchMock: Mock<(url: string, init?: RequestInit) => Promise<Response>>;
beforeEach(() => {
  fetchMock = vi.fn(async (url: string) => {
    if (url.startsWith("/api/suppliers")) return json({ suppliers: [{ id: supplierId, name: "Pots supplier" }], hasMore: false });
    if (url.startsWith(`/api/imports/${importId}`)) return json(details);
    return json({ imports: [summary], hasMore: false });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function fillUpload() {
  const user = userEvent.setup();
  await screen.findByRole("option", { name: "Pots supplier" });
  await user.selectOptions(screen.getByLabelText("Supplier (required)"), supplierId);
  await user.upload(screen.getByLabelText("Drop a spreadsheet here, or choose a file"), new File(["SKU\n00123"], "pots.csv", { type: "text/csv" }));
  return user;
}

describe("supplier dashboard", () => {
  it("submits once, reuses the key after an ambiguous failure, and creates a key only on an intentional new attempt", async () => {
    const keys: string[] = [];
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        expect(init.body).toBeInstanceOf(FormData);
        const form = init.body as FormData;
        keys.push(String(form.get("idempotencyKey")));
        expect(form.get("supplierId")).toBe(supplierId);
        if (keys.length === 1) throw new TypeError("network lost with private/internal/path");
        return json({ importId, status: "PENDING", reused: keys.length === 2 }, keys.length === 2 ? 200 : 202);
      }
      return base(url);
    });
    render(<ImportDashboard />);
    const user = await fillUpload();
    await user.click(screen.getByRole("button", { name: "Upload spreadsheet" }));
    expect(await screen.findByText(/Upload could not be confirmed/)).toBeTruthy();
    expect(screen.queryByText(/private\/internal/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Retry upload" }));
    await screen.findByText(/Upload accepted/);
    expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]);
    expect(screen.getByRole("button", { name: "Upload spreadsheet" })).toHaveProperty("disabled", true);
    await user.click(screen.getByRole("button", { name: "Start new import" }));
    await user.click(screen.getByRole("button", { name: "Upload spreadsheet" }));
    await waitFor(() => expect(keys).toHaveLength(3));
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("validates dropped files, displays filename/size, and prevents unsupported or multiple uploads", async () => {
    render(<ImportDashboard />);
    await screen.findByRole("option", { name: "Pots supplier" });
    const drop = screen.getByLabelText("Drop a spreadsheet here, or choose a file").parentElement!;
    fireEvent.drop(drop, { dataTransfer: { files: [new File(["x"], "bad.exe")] } });
    expect(screen.getByText("Choose a CSV or XLSX spreadsheet.")).toBeTruthy();
    fireEvent.drop(drop, { dataTransfer: { files: [new File([], "empty.csv")] } });
    expect(screen.getByText("Choose a file that is not empty.")).toBeTruthy();
    fireEvent.drop(drop, { dataTransfer: { files: [new File([new Uint8Array(10 * 1024 * 1024 + 1)], "huge.csv")] } });
    expect(screen.getByText("Choose a spreadsheet no larger than 10 MiB.")).toBeTruthy();
    fireEvent.drop(drop, { dataTransfer: { files: [new File(["a"], "a.csv"), new File(["b"], "b.csv")] } });
    expect(screen.getByText("Choose exactly one CSV or XLSX file.")).toBeTruthy();
    fireEvent.drop(drop, { dataTransfer: { files: [new File(["SKU\n001"], "valid.csv")] } });
    expect(screen.getByText("valid.csv")).toBeTruthy();
    expect(screen.getByText("7 bytes")).toBeTruthy();
  });
  it("changes the key when the supplier or selected file changes", async () => {
    const keys: string[] = [];
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, init) => {
      if (url.startsWith("/api/suppliers")) return json({ suppliers: [{ id: supplierId, name: "Pots supplier" }, { id: otherId, name: "Other supplier" }], hasMore: false });
      if (init?.method === "POST") { keys.push(String((init.body as FormData).get("idempotencyKey"))); throw new TypeError("Lost response"); }
      return base(url);
    });
    render(<ImportDashboard />); const user = await fillUpload();
    await user.click(screen.getByRole("button", { name: "Upload spreadsheet" }));
    await screen.findByRole("button", { name: "Retry upload" });
    await user.selectOptions(screen.getByLabelText("Supplier (required)"), otherId);
    await user.click(screen.getByRole("button", { name: "Upload spreadsheet" }));
    await screen.findByRole("button", { name: "Retry upload" });
    await user.upload(screen.getByLabelText("Drop a spreadsheet here, or choose a file"), new File(["SKU\n002"], "other.xlsx"));
    await user.click(screen.getByRole("button", { name: "Upload spreadsheet" }));
    await waitFor(() => expect(keys).toHaveLength(3));
    expect(new Set(keys).size).toBe(3);
  });
  it("prevents overlapping submissions and retains the selected file while uploading", async () => {
    const base = fetchMock.getMockImplementation()!;
    let resolve!: (response: Response) => void;
    let posts = 0;
    fetchMock.mockImplementation(async (url, init) => {
      if (init?.method === "POST") { posts++; return new Promise<Response>((done) => { resolve = done; }); }
      return base(url);
    });
    const view = render(<ImportDashboard />); await fillUpload();
    const form = view.container.querySelector("form")!;
    fireEvent.submit(form); fireEvent.submit(form);
    expect(posts).toBe(1);
    expect(screen.getByRole("button", { name: "Uploading…" })).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("Supplier (required)")).toHaveProperty("disabled", true);
    await act(async () => { resolve(json({ importId, status: "PENDING", reused: false }, 202)); });
    expect(screen.getByText(/Upload accepted/)).toBeTruthy();
  });

  it("paginates history and source rows, shows positional duplicate headers and escapes supplier HTML", async () => {
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string) => url.startsWith("/api/imports?") ? json({ imports: [summary], hasMore: !url.includes("page=2") }) : base(url));
    const user = userEvent.setup();
    render(<ImportDashboard />);
    await user.click(await screen.findByRole("button", { name: "View pots.csv" }));
    await screen.findByText("00123");
    expect(screen.getByText("Column 1")).toBeTruthy(); expect(screen.getByText("Column 2")).toBeTruthy();
    expect(screen.getAllByRole("columnheader", { name: /Notes/ })).toHaveLength(2);
    expect(screen.getByText('<script>alert("x")</script>')).toBeTruthy();
    expect(document.querySelector("script")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Next source rows page" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes(`${importId}?page=2&pageSize=10`))).toBe(true));
    await user.click(screen.getByRole("button", { name: "Next history page" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === "/api/imports?page=2&pageSize=10")).toBe(true));
    await waitFor(() => expect(screen.getByRole("button", { name: "Next history page" })).toHaveProperty("disabled", true));
  });

  it("shows actual failure state and unknown totals without exposing backend error details", async () => {
    const failed = { ...summary, status: "FAILED", totalRows: null, _count: { sourceRows: 0 }, errorCode: "PRIVATE_ERROR", errorMessage: "secret credential /storage/private" };
    fetchMock.mockImplementation(async (url: string) => url.startsWith("/api/suppliers") ? json({ suppliers: [], hasMore: false }) : url.includes(importId) ? json({ imported: failed, rows: [] }) : json({ imports: [failed], hasMore: false }));
    const user = userEvent.setup(); render(<ImportDashboard />);
    await user.click(await screen.findByRole("button", { name: "View pots.csv" }));
    await screen.findByText(/Any rows below are partial evidence/);
    expect(screen.getAllByText(/0 rows saved · total not known yet/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/secret credential/)).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByText(/No suppliers found/)).toBeTruthy();
  });

  it("shows empty history and actionable load errors", async () => {
    fetchMock.mockImplementation(async () => json({ imports: [], hasMore: false }));
    render(<ImportDashboard />);
    await screen.findByText(/No imports on this page/);
    expect(await screen.findByText(/Could not refresh this view/)).toBeTruthy();
  });
});

it("expands long values without losing the complete original text", async () => {
  const text = "original supplier value ".repeat(500);
  const row = { ...details.rows[0]!, rawCells: [{ columnIndex: 0, header: "Notes", value: text }] };
  render(<SourcePreview rows={[row]} />);
  const trigger = screen.getByText("Show full value").closest("summary")!;
  const user = userEvent.setup();
  trigger.focus(); await user.keyboard("{Enter}");
  // jsdom does not implement native keyboard toggling of details; verify the native control and complete content.
  expect(trigger.tagName).toBe("SUMMARY");
  expect(screen.getByLabelText("Complete original cell value").textContent).toBe(text);
});

const poll = (data: ImportDetails) => data.imported.status === "PROCESSING";
function PollProbe({ id = importId }: { id?: string }) {
  const resource = useResource(`/api/imports/${id}`, detailsSchema, poll);
  return <><p>{resource.data?.imported.status ?? "loading"}</p>{resource.error && <p>{resource.error}</p>}</>;
}
it("polls active imports, stops at completion, and aborts when unmounted", async () => {
  vi.useFakeTimers();
  fetchMock.mockResolvedValueOnce(json({ ...details, imported: { ...summary, status: "PROCESSING" } })).mockResolvedValue(json(details));
  const view = render(<PollProbe />);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(screen.getByText("PROCESSING")).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(screen.getByText("COMPLETED")).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  view.unmount();
  expect(fetchMock.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds polling errors and prevents stale responses from replacing another import", async () => {
  vi.useFakeTimers();
  fetchMock.mockRejectedValue(new Error("private server details"));
  const view = render(<PollProbe />);
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(screen.getByText(/Automatic retries stop after three failures/)).toBeTruthy();
  let resolve!: (value: Response) => void;
  fetchMock.mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; })).mockResolvedValue(json(details));
  view.rerender(<PollProbe id={otherId} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  view.rerender(<PollProbe />);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  await act(async () => { resolve(json({ ...details, imported: { ...summary, status: "FAILED" } })); });
  expect(screen.getByText("COMPLETED")).toBeTruthy();
});

it("pauses polling while hidden or offline and resumes without overlapping requests", async () => {
  vi.useFakeTimers();
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  fetchMock.mockImplementation(async () => json({ ...details, imported: { ...summary, status: "PROCESSING" } }));
  render(<PollProbe />);
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  expect(fetchMock).not.toHaveBeenCalled();
  hidden.mockReturnValue(false);
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(1); });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  online.mockReturnValue(false);
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  online.mockReturnValue(true);
  await act(async () => { window.dispatchEvent(new Event("online")); window.dispatchEvent(new Event("online")); await vi.advanceTimersByTimeAsync(1); });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("labels settled catalog processing independently of successful AI and merchant review", async () => {
  const pipeline = { phase:"ENRICHMENT",state:"COMPLETED",errorCode:null,errorMessage:null,nextAttemptAt:null,cleaned:11,grouped:11,proposals:5,awaitingEnrichment:0,enriched:2,enrichmentFailed:1,enrichmentStale:1,enrichmentBlocked:1,reviewRequired:5,needsReview:11,needsMapping:false,failed:0,exceptions:[],exceptionsLimited:false,blockedReasons:[],enrichmentIssues:[],proposalLinks:[] };
  const base=fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url,init)=>url.startsWith(`/api/imports/${importId}`)?json({...details,pipeline}):base(url,init));
  render(<ImportDashboard/>);const user=userEvent.setup();await user.click(await screen.findByRole("button",{name:"View pots.csv"}));
  await screen.findByRole("heading",{name:"Catalog processing: Processing settled · ENRICHMENT"});
  const expected={"Enriched successfully":"2","Enrichment failed":"1",Stale:"1","Enrichment blocked":"1","Awaiting enrichment":"0","Review required (products)":"5"};
  for(const [label,value] of Object.entries(expected))expect(screen.getByText(label,{selector:"dt"}).nextElementSibling?.textContent).toBe(value);
  expect(screen.getByText(/Review-required products can also be successfully enriched/)).toBeTruthy();
});
