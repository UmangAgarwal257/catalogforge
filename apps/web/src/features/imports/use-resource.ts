"use client";

import { useEffect, useState } from "react";

export const publicErrors: Record<string, string> = {
  DEVELOPMENT_ONLY: "Imports are available only in explicitly enabled local development.",
  DEVELOPMENT_CONFIG: "Local ingestion is not configured. Follow the development setup instructions.",
  LOCAL_ONLY: "Open the dashboard directly on localhost. Remote access is disabled.",
  CROSS_ORIGIN: "Open the dashboard directly on its local address. Cross-origin requests are disabled.",
  FILE_TOO_LARGE: "Choose a spreadsheet no larger than 10 MiB.",
  UNSUPPORTED_FILE: "Choose a CSV or XLSX spreadsheet.", EMPTY_FILE: "Choose a file that is not empty.",
  INVALID_XLSX: "This XLSX file could not be read. Save a new, unencrypted workbook and try again.",
  MALFORMED_XLSX: "This workbook could not be read. Check it in a spreadsheet application and save it again.",
  MALFORMED_CSV: "CSV parsing failed. Check matching quotes and delimiters, then start a new import.",
  CSV_ENCODING: "Save the CSV using UTF-8 encoding, then start a new import.",
  CSV_DELIMITER: "The CSV delimiter is ambiguous. Use a consistent comma or semicolon delimiter.",
  ROW_LIMIT: "The spreadsheet exceeds 10,000 accepted records. Split it into smaller files.",
  EMPTY_SHEET: "No header record was found. Add column headers and try a new import.",
  IDEMPOTENCY_CONFLICT: "This upload key already identifies different content. Intentionally start a new import to continue.",
  SUPPLIER_NOT_FOUND: "This supplier is unavailable in the development store. Refresh the supplier list.",
  DISPATCH_UNAVAILABLE: "Waiting for the local queue. Make sure Redis and the worker are running; dispatch will retry.",
  PARSE_RETRY_PENDING: "Parsing was interrupted. The worker is waiting to retry safely.",
  PARSE_RETRIES_EXHAUSTED: "Parsing exhausted its retries. Check the worker and local services before starting another import.",
  SOURCE_MISMATCH: "Existing source evidence did not match. Original rows were retained; inspect the import before reimporting.",
  FILE_HASH_MISMATCH: "The preserved file did not match its original hash. Inspect local storage before reimporting."
};

export async function readResponse<T>(response: Response, schema: { parse(value: unknown): T }): Promise<T> {
  const value: unknown = await response.json();
  if (!response.ok) {
    const code = value && typeof value === "object" && "error" in value && value.error && typeof value.error === "object" && "code" in value.error ? value.error.code : undefined;
    throw new Error(typeof code === "string" && publicErrors[code] ? publicErrors[code] : "The request could not be confirmed. Retry with the same upload attempt, or refresh this view.");
  }
  return schema.parse(value);
}

// One request at a time, scoped to URL/refresh generation; old responses cannot replace a new page.
export function useResource<T>(url: string | null, schema: { parse(value: unknown): T }, pollWhen?: (data: T) => boolean, version = 0) {
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{ key: string; data: T | null; error: string | null }>({ key: "", data: null, error: null });
  useEffect(() => {
    if (!url) return;
    let disposed = false;
    let running = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const schedule = (delay: number) => { clearTimeout(timer); timer = setTimeout(() => void load(), delay); };
    async function load() {
      if (disposed || running || document.hidden || !navigator.onLine) return;
      clearTimeout(timer);
      running = true;
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 10000);
      try {
        const data = await readResponse(await fetch(url!, { cache: "no-store", signal: controller.signal }), schema);
        if (disposed) return;
        failures = 0;
        setResult({ key: url!, data, error: null });
        if (pollWhen?.(data)) schedule(3000);
      } catch (error) {
        if (disposed) return;
        failures++;
        setResult((previous) => ({ key: url!, data: previous.key === url ? previous.data : null,
          error: error instanceof Error && Object.values(publicErrors).includes(error.message) ? error.message : "Could not refresh this view. Check your connection and try again." + (pollWhen ? " Automatic retries stop after three failures." : "") }));
        if (pollWhen && failures < 3) schedule(Math.min(3000 * 2 ** failures, 15000));
      } finally { clearTimeout(timeout); running = false; }
    }
    const resume = () => { if (!document.hidden && navigator.onLine) void load(); };
    void load();
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", resume);
    return () => {
      disposed = true; clearTimeout(timer); controller?.abort();
      document.removeEventListener("visibilitychange", resume); window.removeEventListener("online", resume);
    };
  }, [url, schema, pollWhen, retry, version]);
  const current = result.key === url;
  return { data: current ? result.data : null, error: current ? result.error : null,
    loading: !!url && (!current || (!result.data && !result.error)), refresh: () => setRetry((value) => value + 1) };
}
