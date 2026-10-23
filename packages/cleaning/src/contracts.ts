import { z } from "zod";
import { rawCellSchema } from "@catalogforge/ingestion/api-contracts";

export const CLEANER_VERSION = "row-cleaner-v1";
export const currencySchema = z.enum(["EUR", "GBP", "USD"]);
export const fieldSchema = z.string().regex(/^(sku|title|description|price|currency|quantity|weight|attributes\.[A-Za-z][A-Za-z0-9_]{0,39}|dimensions\.[A-Za-z][A-Za-z0-9_]{0,39})$/);
export const numberFormatSchema = z.object({
  decimal: z.enum([".", ","]), grouping: z.enum([".", ",", " "]).nullable()
}).strict().refine((value) => value.decimal !== value.grouping, "Decimal and grouping separators must differ");
export const weightUnitSchema = z.enum(["g", "kg", "lb", "oz"]);
export const dimensionUnitSchema = z.enum(["cm", "mm", "m", "in"]);
export const cleaningConfigSchema = z.object({
  storeId: z.uuid(), supplierId: z.uuid(), sheetIndex: z.number().int().nonnegative(),
  columns: z.record(fieldSchema, z.array(z.object({ columnIndex: z.number().int().min(0).max(255), expectedHeader: z.string().nullable() }).strict()).min(1).max(8)),
  numberFormat: numberFormatSchema.nullable(),
  defaultCurrency: currencySchema.nullable(),
  symbolCurrencies: z.partialRecord(z.enum(["€", "£", "$", "¥"]), currencySchema),
  weightUnit: weightUnitSchema.nullable(),
  dimensionUnits: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/), dimensionUnitSchema),
  unitAliases: z.record(fieldSchema, z.record(z.string().min(1).max(40), z.enum(["g", "kg", "lb", "oz", "cm", "mm", "m", "in"]))),
  aliases: z.record(z.string().regex(/^attributes\.[A-Za-z][A-Za-z0-9_]{0,39}$/), z.record(z.string().max(200), z.string().max(200))),
  nullTokens: z.record(fieldSchema, z.array(z.string().min(1).max(100)).max(20)),
  requiredFields: z.array(z.enum(["sku", "title", "priceMinor", "currency", "quantity", "weightGrams"])).max(6),
  htmlPolicy: z.literal("basic-v1"), weightRounding: z.literal("half-up-gram-v1")
}).strict().refine((value) => Object.keys(value.columns).length <= 64, "At most 64 mapped fields");
export type CleaningConfig = z.infer<typeof cleaningConfigSchema>;
export type NumberFormat = z.infer<typeof numberFormatSchema> | null;
export const cleaningSourceSchema = z.object({
  id: z.uuid(), storeId: z.uuid(), sheetIndex: z.number().int().nonnegative(),
  rawCells: z.array(rawCellSchema).max(256).refine((cells) => cells.every((cell, index) => cell.columnIndex === index), "Cells must have consecutive ordered indexes")
}).refine((row) => row.rawCells.every((cell) => JSON.stringify(cell).length <= 65536), "Source cell exceeds cleaning budget");
export type CleaningSource = z.infer<typeof cleaningSourceSchema>;

export const evidenceItemSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cell"), sourceRowId: z.uuid(), columnIndex: z.number().int().nonnegative(), valuePointer: z.string() }),
  z.object({ kind: z.literal("configuration"), path: z.string() }),
  z.object({ kind: z.literal("transformation"), rule: z.string() })
]);
export type Evidence = z.infer<typeof evidenceItemSchema>;
export const issueSchema = z.object({
  code: z.string(), severity: z.enum(["WARNING", "REVIEW", "ERROR"]), field: z.string(), message: z.string(),
  evidence: z.array(evidenceItemSchema)
});
export type CleaningIssue = z.infer<typeof issueSchema>;
export const normalizedSchema = z.object({
  sku: z.string().nullable(), title: z.string().nullable(), descriptionHtml: z.string().nullable(), descriptionText: z.string().nullable(),
  priceMinor: z.string().regex(/^\d+$/).nullable(), currency: currencySchema.nullable(),
  quantity: z.number().int().min(0).max(2147483647).nullable(),
  weightGrams: z.number().int().min(0).max(2147483647).nullable(), weightExactGrams: z.string().nullable(),
  dimensionsCm: z.record(z.string(), z.string().nullable()), attributes: z.record(z.string(), z.string().nullable())
});
export const cleaningOutputSchema = z.object({
  normalized: normalizedSchema, evidence: z.record(z.string(), z.array(evidenceItemSchema)), issues: z.array(issueSchema),
  outcome: z.enum(["READY", "NEEDS_REVIEW", "FAILED"])
});
export type CleaningOutput = z.infer<typeof cleaningOutputSchema>;
