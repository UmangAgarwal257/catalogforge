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
  catalogTask:z.object({state:z.string(),phase:z.string(),nextAttemptAt:z.string().nullable()}).nullable().optional(),
  supplier: z.object({ name: z.string() }).optional()
});
export const suppliersSchema = z.object({ suppliers: z.array(z.object({ id: z.uuid(), name: z.string() })).max(100), hasMore: z.boolean() });
export const historySchema = z.object({ imports: z.array(importSummarySchema).max(100), hasMore: z.boolean() });
export const pipelineSchema=z.object({phase:z.string(),state:z.string(),errorCode:z.string().nullable(),errorMessage:z.string().nullable(),nextAttemptAt:z.string().nullable(),cleaned:z.number(),grouped:z.number(),proposals:z.number(),awaitingEnrichment:z.number(),enriched:z.number(),enrichmentFailed:z.number(),enrichmentBlocked:z.number(),needsReview:z.number(),needsMapping:z.boolean(),failed:z.number(),exceptions:z.array(z.object({sourceRowId:z.string(),outcome:z.string(),issues:z.json(),sourceRow:z.object({sheetIndex:z.number(),sheetName:z.string(),rowNumber:z.number()})})),exceptionsLimited:z.boolean(),blockedReasons:z.array(z.object({revisionId:z.string(),code:z.string()})),enrichmentIssues:z.array(z.object({revisionId:z.string(),code:z.string(),state:z.string()})),proposalLinks:z.array(z.object({id:z.string(),productId:z.string(),title:z.string().nullable(),status:z.string()}))});
export const detailsSchema = z.object({
  imported: importSummarySchema,
  pipeline:pipelineSchema.nullable().optional(),
  rows: z.array(z.object({
    id: z.uuid(), sheetIndex: z.number().int(), sheetName: z.string(), rowNumber: z.number().int(),
    status: z.string(), rawCells: z.array(rawCellSchema).max(256).refine((cells) => cells.every((cell, index) => cell.columnIndex === index)), issues: z.array(z.json())
  })).max(100)
});
export const uploadResponseSchema = z.object({ importId: z.uuid(), status: importSummarySchema.shape.status, reused: z.boolean() });
export type ImportSummary = z.infer<typeof importSummarySchema>;
export type ImportDetails = z.infer<typeof detailsSchema>;
export type SupplierPage = z.infer<typeof suppliersSchema>;
