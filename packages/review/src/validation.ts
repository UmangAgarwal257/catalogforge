import { createHash } from "node:crypto";
import { canonicalJson } from "@catalogforge/cleaning/persistence";
import { safeHtml } from "@catalogforge/enrichment/validation";
import { CATEGORIES, type ReviewIssue, type Resolution } from "./contracts";
import type { ReviewSnapshot } from "./service";
export const json = (value: unknown) => JSON.parse(JSON.stringify(value ?? null, (_, v) => typeof v === "bigint" ? v.toString() : v));
export const hash = (value: unknown) => createHash("sha256").update(canonicalJson(json(value))).digest("hex");
export const plain = (html: string) => safeHtml(html).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
export function scopeHash(data: ReviewSnapshot, field: string) {
  const r = data.revision;
  const value = field.startsWith("variants.") ? r.variants.find(v => v.variantId === field.split(".")[1]) :
    field.startsWith("attributes.") ? (r.attributes as Record<string, unknown>)[field.slice(11)] :
    field in r ? r[field as keyof typeof r] : { title: r.title, descriptionHtml: r.descriptionHtml, attributes: r.attributes, variants: r.variants };
  return hash(value);
}
export function reviewIssues(data: ReviewSnapshot): ReviewIssue[] {
  const issues: ReviewIssue[] = [], r = data.revision;
  const add = (code: string, field: string, message: string, kind: ReviewIssue["kind"] = "VALUE", detail: unknown = null, evidenceRequired = false, value: string | null = null) => {
    const id = hash({ code, field, detail }); if (!issues.some(i => i.id === id)) issues.push({ id, code, field, message, kind, evidenceRequired, value });
  };
  if (!r.title?.trim()) add("TITLE_REQUIRED", "title", "Enter a product title.");
  if (!r.descriptionHtml || !plain(r.descriptionHtml)) add("DESCRIPTION_REQUIRED", "descriptionHtml", "Enter a product description.");
  if (r.descriptionHtml && safeHtml(r.descriptionHtml) !== r.descriptionHtml) add("UNSAFE_HTML", "descriptionHtml", "Remove unsupported HTML; use paragraphs, emphasis and lists only.");
  if (!(CATEGORIES as readonly string[]).includes(r.categoryKey ?? "")) add("CATEGORY_REQUIRED", "categoryKey", "Choose a supported category.");
  if (!r.variants.length) add("VARIANTS_REQUIRED", "variants", "At least one variant is required.");
  const options = new Set<string>(), currencies = new Set<string>();
  for (const v of r.variants) {
    const path = `variants.${v.variantId}`;
    if (v.variant.archivedAt || v.variant.productId !== r.productId) add("VARIANT_UNAVAILABLE", path, "An archived or unrelated variant requires correction outside this editor.");
    if (v.priceMinor === null || v.priceMinor <= 0n) add("PRICE_REQUIRED", `${path}.priceMinor`, `Enter a positive price for ${v.variant.sku}; missing is not zero.`);
    if (!["EUR", "GBP", "USD"].includes(v.currency ?? "")) add("CURRENCY_REQUIRED", `${path}.currency`, `Choose EUR, GBP or USD for ${v.variant.sku}.`);
    if (v.currency) currencies.add(v.currency);
    const entries = Object.entries(v.options as Record<string, unknown>);
    if (entries.some(([, value]) => typeof value !== "string" || !value.trim())) add("OPTIONS_REQUIRED", `${path}.options`, `Complete the options for ${v.variant.sku}.`);
    const fingerprint = hash(v.options);
    if (options.has(fingerprint)) add("DUPLICATE_OPTIONS", `${path}.options`, "Variants must have distinct option combinations.");
    options.add(fingerprint);
  }
  if (currencies.size > 1) add("MIXED_CURRENCIES", "variants", "Use one currency across this product's variants; no exchange conversion is performed.");
  if (r.product.archivedAt) add("ARCHIVED_PRODUCT", "product", "Archived products cannot be approved.");
  if (r.product.publishedRevisionId !== r.basePublishedRevisionId) add("STALE_BASELINE", "product", "The published baseline changed; this proposal needs explicit rebase.");
  const informative = new Set(["AI_REVIEW_REQUIRED", "PROVIDER_REVIEW", "FIELD_ABSTAINED", "LOW_CONFIDENCE", "MANUAL_OVERRIDE_PRESERVED", "CLEANING_REVIEW", "PRICE_REQUIRED", "CURRENCY_REQUIRED", "TITLE_REQUIRED", "WEIGHT_REQUIRED"]);
  for (const item of r.reviewReasons as Record<string, unknown>[]) {
    if (typeof item.code !== "string" || informative.has(item.code) || item.code === "UNVERIFIED_SUGGESTION") continue;
    add(item.code, typeof item.field === "string" ? item.field : "product", `Review source issue: ${item.code}.`, "FACT", item, true);
  }
  for (const link of data.sources) {
    for (const issue of (link.cleaningResult?.issues ?? []) as { code: string; severity: string; field: string; message: string }[]) {
      if (issue.severity === "WARNING" || informative.has(issue.code) || ["PRICE_MISSING", "CURRENCY_MISSING", "REQUIRED_FIELD_MISSING", "MISSING_REQUIRED"].includes(issue.code) && ["priceMinor", "price", "currency", "title", "weightGrams"].includes(issue.field)) continue;
      add(issue.code, issue.field === "description" ? "descriptionHtml" : issue.field, issue.message, "FACT", { issue, sourceRowId: link.sourceRowId }, true);
    }
  }
  for (const run of data.runs) {
    if (run.state !== "COMPLETED") continue;
    const result = run.result as { withheld?: { path: string; value: string }[] } | null;
    for (const f of result?.withheld ?? []) add("WITHHELD_SUGGESTION", f.path, `Decide what to do with the withheld ${f.path} suggestion.`, "SUGGESTION", { runId: run.id, field: f }, f.path !== "categoryKey", f.value);
    // Conservative English restriction guard. Keep complete source blocks that
    // contain these explicit restrictions; this is not semantic entailment.
    const facts = (run.inputSnapshot as { packet?: { facts?: { path: string; value: string }[] } }).packet?.facts ?? [];
    for (const fact of facts.filter(f => f.path === "descriptionHtml")) {
      for (const block of fact.value.split(/<\/?(?:p|li|ul|ol)\b[^>]*>/i).map(plain).filter(Boolean)) {
        if (/\b(not|never|must|only|avoid|below|warning|do not)\b/i.test(block) && !plain(r.descriptionHtml ?? "").includes(block)) add("SOURCE_RESTRICTION_REMOVED", "descriptionHtml", `Restore the source restriction: ${block}`, "VALUE", block);
      }
    }
  }
  return issues;
}
export function activeIssues(data: ReviewSnapshot) {
  const resolutions = data.events.flatMap(e => e.decisions as unknown as Resolution[]);
  return reviewIssues(data).filter(issue => issue.kind === "VALUE" || !resolutions.some(d => d.issueId === issue.id && d.scopeHash === scopeHash(data, issue.field)));
}
