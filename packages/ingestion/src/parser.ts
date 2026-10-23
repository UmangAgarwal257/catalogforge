import Papa from "papaparse";
import ExcelJS from "exceljs";
import { Readable } from "node:stream";
import { z } from "zod";
import { IngestionError, LIMITS, parsedRowSchema, spreadsheetType, validateFile, type ParsedRow } from "./contracts";

function jsonValue(value: unknown): string | number | boolean | null | object {
  // ExcelJS dates, formulas, rich text and error objects remain evidence, not normalized values.
  return JSON.parse(JSON.stringify(value ?? null));
}

function makeRow(sheetIndex: number, sheetName: string, rowNumber: number, headers: unknown[], values: unknown[], metadata: Record<string, unknown>[] = []): ParsedRow {
  if (values.length > LIMITS.columns || headers.length > LIMITS.columns) throw new IngestionError("COLUMN_LIMIT", "Spreadsheet exceeds 256 columns.");
  if (rowNumber > LIMITS.physicalRows) throw new IngestionError("PHYSICAL_ROW_LIMIT", "Spreadsheet exceeds the physical row safety limit.");
  const rawCells = Array.from({ length: Math.max(headers.length, values.length) }, (_, columnIndex) => {
    const header = headers[columnIndex];
    const value = jsonValue(values[columnIndex]);
    const details = { ...metadata[columnIndex], ...(columnIndex >= values.length ? { missing: true } : {}) };
    const cell = {
      columnIndex,
      header: header === undefined || header === null ? null : typeof header === "string" ? header : JSON.stringify(header),
      value,
      metadata: details
    };
    if (JSON.stringify(cell).length > LIMITS.cellChars) throw new IngestionError("CELL_LIMIT", "A cell exceeds the 64 KiB safety limit.");
    return cell;
  });
  const issues: ParsedRow["issues"] = [];
  if (headers.length !== values.length) issues.push({ code: "COLUMN_COUNT", message: "Row width differs from its header; all cells were preserved." });
  values.forEach((value, columnIndex) => {
    if (value && typeof value === "object" && ("formula" in value || "sharedFormula" in value)) {
      issues.push({ code: "FORMULA_UNTRUSTED", columnIndex, message: "Formula and cached result preserved as evidence only; not evaluated." });
    }
  });
  const result = parsedRowSchema.safeParse({ sheetIndex, sheetName, rowNumber, rawCells, issues });
  if (!result.success) throw new IngestionError("INVALID_CELL", "A source cell could not be represented safely.");
  return result.data;
}

function blank(values: unknown[]): boolean {
  return values.every((value) => value === null || value === undefined || (typeof value === "string" && !value.trim()));
}

function csvRows(bytes: Uint8Array): ParsedRow[] {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new IngestionError("CSV_ENCODING", "CSV must use valid UTF-8 encoding."); }
  const candidates = [",", ";"].filter((delimiter) => {
    const sample = Papa.parse<string[]>(text, { delimiter, preview: 16, skipEmptyLines: "greedy", dynamicTyping: false });
    return !sample.errors.length && sample.data.length > 0 && sample.data.every((row) => row.length > 1 && row.length === sample.data[0]?.length);
  });
  if (candidates.length > 1) throw new IngestionError("CSV_DELIMITER", "Comma and semicolon are both plausible delimiters; use an unambiguous CSV.");
  const delimiter = candidates[0] ?? (text.includes(";") && !text.includes(",") ? ";" : ",");
  const rows: ParsedRow[] = [];
  let headers: string[] | undefined;
  let cursor = 0;
  let line = 1;
  let outputChars = 0;
  Papa.parse<string[]>(text, {
    delimiter, header: false, dynamicTyping: false, skipEmptyLines: false,
    step(result, parser) {
      if (result.errors.length) throw new IngestionError("MALFORMED_CSV", `Malformed CSV near physical line ${line}. Check quotes and delimiters.`);
      const startLine = line;
      const end = result.meta.cursor;
      line += (text.slice(cursor, end).match(/\r\n|\r|\n/g) ?? []).length;
      cursor = end;
      if (line > LIMITS.physicalRows + 1) throw new IngestionError("PHYSICAL_ROW_LIMIT", "CSV exceeds the physical row safety limit.");
      if (blank(result.data)) return;
      if (!headers) {
        headers = result.data;
        if (headers.length > LIMITS.columns) throw new IngestionError("COLUMN_LIMIT", "Spreadsheet exceeds 256 columns.");
        return;
      }
      const row = makeRow(0, "CSV", startLine, headers, result.data);
      outputChars += JSON.stringify(row).length;
      if (outputChars > LIMITS.expandedBytes) throw new IngestionError("PARSED_SIZE_LIMIT", "Parsed evidence exceeds the 64 MiB safety budget.");
      rows.push(row);
      if (rows.length > LIMITS.records) {
        parser.abort();
        throw new IngestionError("ROW_LIMIT", "Spreadsheet exceeds 10,000 accepted source records.");
      }
    }
  });
  if (!headers) throw new IngestionError("EMPTY_SHEET", "CSV contains no header record.");
  return rows;
}

// XLSX is a ZIP container. Inspect its directory without extracting user archives.
// Bound declared expansion/shared-string/style input before handing it to ExcelJS.
function validateWorkbookArchive(bytes: Buffer): void {
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--) {
    if (bytes.readUInt32LE(at) === 0x06054b50) { end = at; break; }
  }
  if (end < 0) throw new IngestionError("INVALID_XLSX", "XLSX archive directory is unreadable.");
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  if (count > 2000 || at >= end) throw new IngestionError("XLSX_RESOURCE_LIMIT", "XLSX archive has too many entries or unsupported ZIP64 data.");
  let expanded = 0;
  const names = new Set<string>();
  for (let entry = 0; entry < count; entry++) {
    if (at + 46 > end || bytes.readUInt32LE(at) !== 0x02014b50) throw new IngestionError("INVALID_XLSX", "XLSX archive directory is malformed.");
    expanded += bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28);
    const next = at + 46 + nameLength + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
    if (next > end || expanded > LIMITS.expandedBytes) throw new IngestionError("XLSX_RESOURCE_LIMIT", "XLSX exceeds the 64 MiB declared expansion limit.");
    names.add(bytes.subarray(at + 46, at + 46 + nameLength).toString("utf8"));
    at = next;
  }
  if (!names.has("[Content_Types].xml") || !names.has("xl/workbook.xml")) throw new IngestionError("INVALID_XLSX", "The archive does not contain an XLSX workbook.");
}

export async function* parseSpreadsheet(bytes: Uint8Array, filename: string): AsyncGenerator<ParsedRow> {
  validateFile(bytes, filename);
  if (spreadsheetType(filename) === "csv") {
    for (const row of csvRows(bytes)) yield row;
    return;
  }
  validateWorkbookArchive(Buffer.from(bytes));
  let count = 0;
  let outputChars = 0;
  let hasHeader = false;
  try {
    const reader = new ExcelJS.stream.xlsx.WorkbookReader(Readable.from([bytes]), {
      worksheets: "emit", sharedStrings: "cache", styles: "cache", hyperlinks: "ignore"
    });
    for await (const sheet of reader) {
      const model = z.object({ sheets: z.array(z.object({ name: z.string() })) }).safeParse("model" in reader ? reader.model : undefined);
      if (!model.success || !("name" in sheet) || typeof sheet.name !== "string") throw new IngestionError("INVALID_XLSX", "Worksheet name/order metadata is unavailable.");
      if (model.data.sheets.length > LIMITS.sheets) throw new IngestionError("SHEET_LIMIT", "Workbook exceeds 100 sheets.");
      const sheetName = sheet.name;
      const sheetIndex = model.data.sheets.findIndex((item) => item.name === sheetName);
      if (sheetIndex < 0) throw new IngestionError("INVALID_XLSX", "Worksheet is not present in the workbook manifest.");
      let headers: unknown[] | undefined;
      for await (const row of sheet) {
        if (row.number > LIMITS.physicalRows) throw new IngestionError("PHYSICAL_ROW_LIMIT", "Worksheet exceeds the physical row safety limit.");
        if (row.cellCount > LIMITS.columns) throw new IngestionError("COLUMN_LIMIT", "Spreadsheet exceeds 256 columns.");
        const values: unknown[] = [];
        const metadata: Record<string, unknown>[] = [];
        for (let index = 1; index <= row.cellCount; index++) {
          const cell = row.getCell(index);
          values.push(cell.value);
          metadata.push({ excelType: cell.type, ...(cell.numFmt ? { numFmt: cell.numFmt } : {}) });
        }
        if (blank(values)) continue;
        if (!headers) { headers = values.map(jsonValue); hasHeader = true; continue; }
        count++;
        if (count > LIMITS.records) throw new IngestionError("ROW_LIMIT", "Workbook exceeds 10,000 accepted source records across all sheets.");
        const parsed = makeRow(sheetIndex, sheetName, row.number, headers, values, metadata);
        outputChars += JSON.stringify(parsed).length;
        if (outputChars > LIMITS.expandedBytes) throw new IngestionError("PARSED_SIZE_LIMIT", "Parsed evidence exceeds the 64 MiB safety budget.");
        yield parsed;
      }
    }
  } catch (error) {
    if (error instanceof IngestionError) throw error;
    throw new IngestionError("MALFORMED_XLSX", "Workbook could not be read. Check that it is an unencrypted, valid XLSX file.");
  }
  if (!hasHeader) throw new IngestionError("EMPTY_SHEET", "Workbook contains no header records.");
}
