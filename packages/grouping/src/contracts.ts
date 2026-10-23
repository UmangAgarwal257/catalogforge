import { z } from "zod";
import { cleaningOutputSchema } from "@catalogforge/cleaning/contracts";

export const GROUPER_VERSION = "grouping-v1";
export const groupingConfigSchema = z.object({
  namespace: z.string().trim().min(1).max(100),
  familyAttribute: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/).nullable(),
  // Keys are canonicalized through PostgreSQL before hashing/planning.
  skuFamilies: z.record(z.string().min(1).max(200), z.string().trim().min(1).max(200)),
  missingFamily: z.enum(["REVIEW", "STANDALONE"]),
  optionFields: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/), z.string().regex(/^(attributes|dimensionsCm)\.[A-Za-z][A-Za-z0-9_]{0,39}$/)),
  productAttributes: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/)).max(32)
}).strict().refine(c => Object.keys(c.optionFields).length <= 8 && Object.keys(c.skuFamilies).length <= 10000,
  "At most eight option fields and 10,000 explicit SKU mappings");
export type GroupingConfig = z.infer<typeof groupingConfigSchema>;
export type Cleaned = z.infer<typeof cleaningOutputSchema>;
export type InputRow = Cleaned & {
  id: string; sourceRowId: string; canonicalSku: string | null; mappedFields: string[];
  // Identity cells must be textual, mapped and free of identity review issues.
  trustedSku: boolean; trustedFamily: boolean;
};
export type CatalogProduct = { id: string; key: string | null; archived: boolean; baselineId: string | null; baselineHash: string | null; editedDraft: boolean };
export type CatalogVariant = { sku: string; productId: string; supplierId: string; archived: boolean };
export type Catalog = { supplierId: string; products: CatalogProduct[]; variants: CatalogVariant[] };
export type Issue = { code: string; field: string; sourceRowIds: string[] };
export type VariantPlan = {
  sku: string; rowIds: string[]; options: Record<string, string | null>;
  priceMinor: string | null; currency: string | null; weightGrams: number | null;
};
export type FamilyPlan = {
  key: string; productKey: string | null; productId: string | null;
  baselineId: string | null; baselineHash: string | null;
  rowIds: string[]; blocked: string[]; issues: Issue[]; variants: VariantPlan[];
  title: string | null; descriptionHtml: string | null; attributes: Record<string, string | null>;
};
export type GroupingPlan = { groups: FamilyPlan[] };
export class GroupingConflict extends Error {
  constructor(public readonly code: string) { super(code); }
}
