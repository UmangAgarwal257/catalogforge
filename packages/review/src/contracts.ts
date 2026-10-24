import { z } from "zod";
// Deliberately small, explicit taxonomy; no free-form AI category authority.
export const CATEGORIES = ["Home & Garden > Planters", "Home & Garden > Garden Accessories", "Home & Garden > Home Accessories"] as const;
export const categorySchema = z.enum(CATEGORIES);
const key = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/);
export const fieldsSchema = z.object({
  title: z.string().max(300).nullable().optional(), descriptionHtml: z.string().max(6000).nullable().optional(),
  categoryKey: categorySchema.nullable().optional(), tags: z.array(z.string().trim().min(1).max(100)).max(32).optional(),
  attributes: z.record(key, z.string().max(1000).nullable()).refine(v => Object.keys(v).length <= 32).optional()
}).strict();
export const variantPatchSchema = z.object({ variantId: z.uuid(),
  priceMinor: z.string().regex(/^\d{1,19}$/).refine(v => BigInt(v) <= 9223372036854775807n).nullable().optional(),
  currency: z.enum(["EUR", "GBP", "USD"]).nullable().optional(), weightGrams: z.number().int().min(0).max(2147483647).nullable().optional(),
  options: z.record(key, z.string().max(200).nullable()).refine(v => Object.keys(v).length <= 8).optional()
}).strict();
export const decisionSchema = z.object({ issueId: z.string().regex(/^[a-f0-9]{64}$/),
  disposition: z.enum(["DISCARD", "RESOLVE", "ADOPT_CATEGORY"]), reason: z.string().trim().min(5).max(1000),
  evidenceRefs: z.array(z.object({ sourceRowId: z.uuid(), columnIndex: z.number().int().min(0).max(255) }).strict()).max(20).default([])
}).strict();
export const mutationSchema = z.object({ requestId: z.uuid(), expectedEditVersion: z.number().int().positive(),
  fields: fieldsSchema.default({}), variants: z.array(variantPatchSchema).max(100).default([]),
  decisions: z.array(decisionSchema).max(100).default([]), reason: z.string().trim().min(5).max(1000).optional()
}).strict().refine(v => new Set(v.variants.map(x => x.variantId)).size === v.variants.length, "Duplicate variant patches");
export type Mutation = z.infer<typeof mutationSchema>;
export type ReviewIssue = { id: string; field: string; code: string; message: string; kind: "VALUE" | "FACT" | "SUGGESTION"; evidenceRequired: boolean; value: string | null };
export type Resolution = z.infer<typeof decisionSchema> & { scopeHash: string };
export class ReviewError extends Error {
  constructor(public code: string, public status: number, message: string, public issues: ReviewIssue[] = []) { super(message); }
}
export function decimalToMinor(input: string): string | null {
  if (!input.trim()) return null;
  if (!/^\d+(?:\.\d{1,2})?$/.test(input.trim())) throw Error("Use a nonnegative amount with at most two decimal places and a decimal point.");
  const [whole, fraction = ""] = input.trim().split(".");
  const result = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (result > 9223372036854775807n) throw Error("Amount exceeds the supported range.");
  return result.toString();
}
export function minorToDecimal(input: string | null): string {
  if (input === null) return "";
  const n = BigInt(input); return `${n / 100n}.${(n % 100n).toString().padStart(2, "0")}`;
}

export function parseWeightGrams(input: string): number | null {
  if (!input.trim()) return null;
  if (!/^\d{1,10}$/.test(input.trim()) || BigInt(input.trim()) > 2147483647n) throw Error("Weight must be nonnegative whole grams within the supported range.");
  return Number(input.trim());
}
const issueWire = z.object({ id:z.string(),field:z.string(),code:z.string(),message:z.string(),kind:z.enum(["VALUE","FACT","SUGGESTION"]),evidenceRequired:z.boolean(),value:z.string().nullable() });
export const revisionWire = z.object({ id:z.string(),productId:z.string(),title:z.string().nullable(),descriptionHtml:z.string().nullable(),categoryKey:z.string().nullable(),tags:z.array(z.string()),attributes:z.record(z.string(),z.string().nullable()),status:z.string(),editVersion:z.number(),manualFieldPaths:z.array(z.string()),reviewReasons:z.array(z.json()),
  product:z.object({supplier:z.object({name:z.string()}),publishedRevisionId:z.string().nullable()}),
  variants:z.array(z.object({variantId:z.string(),options:z.record(z.string(),z.string().nullable()),priceMinor:z.string().nullable(),currency:z.string().nullable(),weightGrams:z.number().nullable(),manualFieldPaths:z.array(z.string()),variant:z.object({sku:z.string()})})) });
export const detailWire = z.object({revision:revisionWire,blockers:z.array(issueWire),taxonomy:z.array(z.string()),
  history:z.array(z.object({id:z.string(),action:z.string(),afterVersion:z.number(),createdAt:z.string(),reason:z.string().nullable(),changes:z.json(),decisions:z.json()})),
  enrichment:z.array(z.object({id:z.string(),createdAt:z.string(),state:z.string(),result:z.json(),facts:z.array(z.object({id:z.string(),path:z.string(),value:z.string(),origin:z.string(),transformations:z.array(z.string()),configuration:z.array(z.string()),evidence:z.array(z.object({sourceRowId:z.string(),columnIndex:z.number(),quote:z.string(),cleaningResultId:z.string(),rowNumber:z.number().optional(),sheetIndex:z.number().optional(),sheetName:z.string().optional()}))}))})) });
export const queueWire = z.object({proposals:z.array(z.object({id:z.string(),productId:z.string(),title:z.string().nullable(),status:z.string(),editVersion:z.number(),createdAt:z.string(),product:z.object({supplier:z.object({name:z.string()})}),_count:z.object({variants:z.number()})})),hasMore:z.boolean()});
export type ReviewDetail = z.infer<typeof detailWire>;
