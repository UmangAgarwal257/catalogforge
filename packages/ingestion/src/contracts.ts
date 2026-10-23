import { z } from "zod";
import { isAbsolute } from "node:path";

export const localSettingsSchema = z.object({ DEV_STORE_ID: z.uuid(), LOCAL_UPLOAD_DIR: z.string().refine(isAbsolute) });

export const LIMITS = {
  fileBytes: 10 * 1024 * 1024,
  records: 10000,
  columns: 256,
  cellChars: 65536,
  physicalRows: 100000,
  sheets: 100,
  expandedBytes: 64 * 1024 * 1024
};
export const PARSER_VERSION = "spreadsheet-v1";
export class IngestionError extends Error {
  constructor(public readonly code: string, message: string, public readonly httpStatus = 422) {
    super(message);
    this.name = "IngestionError";
  }
}
export const rawCellSchema = z.object({
  columnIndex: z.number().int().min(0),
  header: z.string().nullable(),
  value: z.json(),
  metadata: z.record(z.string(), z.json()).optional()
});
export const parsedRowSchema = z.object({
  sheetIndex: z.number().int().min(0),
  sheetName: z.string(),
  rowNumber: z.number().int().positive(),
  rawCells: z.array(rawCellSchema),
  issues: z.array(z.object({ code: z.string(), message: z.string(), columnIndex: z.number().int().optional() }))
});
export type ParsedRow = z.infer<typeof parsedRowSchema>;
export const uploadFieldsSchema = z.object({
  supplierId: z.uuid(),
  idempotencyKey: z.string().trim().min(1).max(200)
});

export function spreadsheetType(filename: string): "csv" | "xlsx" {
  const extension = filename.split(".").at(-1)?.toLowerCase();
  if (extension !== "csv" && extension !== "xlsx") {
    throw new IngestionError("UNSUPPORTED_FILE", "Upload a CSV or XLSX spreadsheet.", 415);
  }
  return extension;
}

export function validateFile(bytes: Uint8Array, filename: string): void {
  const type = spreadsheetType(filename);
  if (!bytes.length) throw new IngestionError("EMPTY_FILE", "The uploaded file is empty.");
  if (bytes.length > LIMITS.fileBytes) throw new IngestionError("FILE_TOO_LARGE", "Spreadsheet exceeds 10 MiB.", 413);
  if (type === "xlsx" && !(bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4)) {
    throw new IngestionError("INVALID_XLSX", "The file is not a readable XLSX archive.");
  }
  if (type === "csv" && (bytes.includes(0) || (bytes[0] === 0x50 && bytes[1] === 0x4b))) {
    throw new IngestionError("INVALID_CSV", "CSV must contain UTF-8 text, not a binary workbook.");
  }
}
