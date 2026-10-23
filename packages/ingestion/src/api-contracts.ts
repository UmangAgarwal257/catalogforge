// Browser-safe wire contracts: never import database, storage, or Node modules here.
import { z } from "zod";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const rawCellSchema = z.object({
  columnIndex: z.number().int().min(0), header: z.string().nullable(), value: z.json(),
  metadata: z.record(z.string(), z.json()).optional()
});
export const importSummarySchema = z.object({
  id: z.uuid(), supplierId: z.uuid(), originalFilename: z.string(),
  status: z.enum(["PENDING", "PROCESSING", "COMPLETED", "FAILED", "PAUSED"]),
  totalRows: z.number().int().nonnegative().nullable(), errorCode: z.string().nullable(), errorMessage: z.string().nullable(),
  createdAt: z.string(), startedAt: z.string().nullable(), finishedAt: z.string().nullable(),
  _count: z.object({ sourceRows: z.number().int().nonnegative() }),
  supplier: z.object({ name: z.string() }).optional()
});
export const suppliersSchema = z.object({ suppliers: z.array(z.object({ id: z.uuid(), name: z.string() })).max(100), hasMore: z.boolean() });
export const historySchema = z.object({ imports: z.array(importSummarySchema).max(100), hasMore: z.boolean() });
export const detailsSchema = z.object({
  imported: importSummarySchema,
  rows: z.array(z.object({
    id: z.uuid(), sheetIndex: z.number().int(), sheetName: z.string(), rowNumber: z.number().int(),
    status: z.string(), rawCells: z.array(rawCellSchema).max(256).refine((cells) => cells.every((cell, index) => cell.columnIndex === index)), issues: z.array(z.json())
  })).max(100)
});
export const uploadResponseSchema = z.object({ importId: z.uuid(), status: importSummarySchema.shape.status, reused: z.boolean() });
export type ImportSummary = z.infer<typeof importSummarySchema>;
export type ImportDetails = z.infer<typeof detailsSchema>;
export type SupplierPage = z.infer<typeof suppliersSchema>;
