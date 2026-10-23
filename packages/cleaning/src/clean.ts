import { cleaningConfigSchema, cleaningSourceSchema, cleaningOutputSchema, currencySchema, dimensionUnitSchema, weightUnitSchema,
  type CleaningOutput, type Evidence, type CleaningIssue } from "./contracts";
import { cleanDescription } from "./html";
import { count, decimal, decimalText, grams, minorUnits, multiply, ValueIssue } from "./numbers";

const empty = (): CleaningOutput["normalized"] => ({ sku: null, title: null, descriptionHtml: null, descriptionText: null,
  priceMinor: null, currency: null, quantity: null, weightGrams: null, weightExactGrams: null, dimensionsCm: {}, attributes: {} });
const own = <T>(map: Record<string, T> | undefined, key: string): T | undefined => map && Object.hasOwn(map, key) ? map[key] : undefined;
const pointer = (key: string) => key.replace(/~/g, "~0").replace(/\//g, "~1");

/** Pure: no database, network, clock, random values, or ambient locale. */
export function cleanRow(sourceInput: unknown, configInput: unknown): CleaningOutput {
  const config = cleaningConfigSchema.parse(configInput);
  const parsed = cleaningSourceSchema.safeParse(sourceInput);
  const normalized = empty();
  const evidence: Record<string, Evidence[]> = {};
  const issues: CleaningIssue[] = [];
  const issue = (field: string, code: string, message: string, severity: CleaningIssue["severity"] = "REVIEW") => {
    issues.push({ field, code, message, severity, evidence: (evidence[field] ?? []).map((item) => ({ ...item })) });
  };
  const rule = (field: string, name: string) => { (evidence[field] ??= []).push({ kind: "transformation", rule: name }); };
  const setting = (field: string, path: string) => { (evidence[field] ??= []).push({ kind: "configuration", path }); };
  if (!parsed.success) {
    issue("source", "INVALID_SOURCE", "Source cells do not satisfy the ordered evidence contract.", "ERROR");
    return cleaningOutputSchema.parse({ normalized, evidence, issues, outcome: "FAILED" });
  }
  const source = parsed.data;
  if (source.storeId !== config.storeId || source.sheetIndex !== config.sheetIndex) {
    issue("source", "MAPPING_SCOPE", "Configuration does not belong to this source store/sheet.", "ERROR");
    return cleaningOutputSchema.parse({ normalized, evidence, issues, outcome: "FAILED" });
  }
  function resolve(field: string): string | number | null {
    evidence[field] = [];
    const values: (string | number)[] = [];
    let invalid = false;
    for (const binding of own(config.columns, field) ?? []) {
      const cell = source.rawCells[binding.columnIndex];
      if (!cell || cell.header !== binding.expectedHeader) {
        setting(field, `/columns/${pointer(field)}`);
        issue(field, "MAPPING_HEADER", "Mapped column is absent or its header differs from the approved mapping.");
        invalid = true;
        continue;
      }
      evidence[field]!.push({ kind: "cell", sourceRowId: source.id, columnIndex: binding.columnIndex, valuePointer: "/value" });
      let value: unknown = cell.value;
      if (value === null || cell.metadata?.missing === true) continue;
      if (typeof value === "object" && !Array.isArray(value) && value !== null && "richText" in value &&
        Object.keys(value).length === 1 && Array.isArray(value.richText) && value.richText.every((part) => part && typeof part === "object" && typeof part.text === "string")) {
        value = value.richText.map((part: { text: string }) => part.text).join("");
        rule(field, "text.rich-text.v1");
        issue(field, "RICH_TEXT_FORMATTING", "Rich text formatting may carry meaning; text was retained for review.");
      }
      if (typeof value !== "string" && typeof value !== "number") {
        issue(field, "UNSUPPORTED_CELL", "Formula, error, boolean or structured value requires explicit review.");
        invalid = true;
        continue;
      }
      if (typeof value === "number" && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
        issue(field, "UNSAFE_NUMBER", "Numeric evidence cannot be represented safely."); invalid = true; continue;
      }
      let candidate: string | number = value;
      if (typeof candidate === "string") {
        if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd\u200b-\u200f\u202a-\u202e\u2066-\u2069]/.test(candidate)) {
          issue(field, "SUSPICIOUS_TEXT", "Text contains replacement, control or invisible directional characters; no repair was guessed.");
        }
        const trimmed = candidate.trim();
        if (trimmed !== candidate) rule(field, "text.trim.v1");
        candidate = trimmed;
        if (!candidate) continue;
        if (own(config.nullTokens, field)?.includes(candidate)) { setting(field, `/nullTokens/${pointer(field)}`); rule(field, "missing.configured-token.v1"); continue; }
      }
      values.push(candidate);
    }
    if (invalid) return null;
    if (new Set(values.map((value) => `${typeof value}:${value}`)).size > 1) {
      issue(field, "CONFLICTING_CELLS", "Mapped source cells disagree; no first/last-column winner was chosen.");
      return null;
    }
    return values[0] ?? null;
  }
  const fields = Object.fromEntries(Object.keys(config.columns).sort().map((field) => [field, resolve(field)]));
  const value = (field: string) => own(fields, field) ?? null;
  const attempt = (field: string, action: () => void) => {
    try { action(); } catch (error) { if (!(error instanceof ValueIssue)) throw error; issue(field, error.code, error.message); }
  };
  const numeric = (field: string, input: string | number) => {
    if (typeof input === "string" && config.numberFormat) setting(field, "/numberFormat");
    rule(field, "number.exact-decimal.v1");
    return decimal(input, config.numberFormat);
  };
  const sku = value("sku");
  if (sku !== null) {
    normalized.sku = String(sku);
    if (typeof sku === "number") issue("sku", "NUMERIC_SKU", "Numeric SKU needs identity review; leading zeros were not reconstructed.");
  }
  const title = value("title");
  if (title !== null) {
    normalized.title = String(title).replace(/[\s\u00a0]+/g, " ");
    rule("title", "text.collapse-whitespace.v1");
    if (/[<>]/.test(normalized.title)) issue("title", "TITLE_MARKUP", "Title contains markup-like characters; retain as text and review.");
  }
  const description = value("description");
  if (description !== null) {
    const cleaned = cleanDescription(String(description));
    normalized.descriptionHtml = cleaned.html || null;
    normalized.descriptionText = cleaned.text || null;
    setting("description", "/htmlPolicy"); rule("description", "html.basic.v1");
    if (cleaned.changed) issue("description", "HTML_SANITIZED", "HTML was normalized or disallowed markup/attributes removed.", "WARNING");
    if (cleaned.discardedComment) issue("description", "DESCRIPTION_COMMENT_REVIEW", "A nonempty HTML comment was discarded; inspect the original cell before using this description.");
    if (cleaned.meaningfulLoss || !cleaned.text) issue("description", "DESCRIPTION_CONTENT_REVIEW", "Basic HTML cleaning cannot safely preserve all meaningful content; inspect the original cell.");
    evidence.descriptionHtml = [...evidence.description!];
    evidence.descriptionText = [...evidence.description!, { kind: "transformation", rule: "html.plain-text-boundaries.v1" }];
  }
  for (const field of Object.keys(config.columns).sort()) {
    if (!field.startsWith("attributes.")) continue;
    const raw = value(field);
    let text = raw === null ? null : String(raw);
    if (text !== null) {
      const alias = own(own(config.aliases, field), text);
      if (alias !== undefined) { text = alias; setting(field, `/aliases/${pointer(field)}`); rule(field, "attribute.approved-alias.v1"); }
    }
    normalized.attributes[field.slice(11)] = text;
  }
  const quantity = value("quantity");
  if (quantity !== null) attempt("quantity", () => { normalized.quantity = count(numeric("quantity", quantity)); rule("quantity", "quantity.whole-count.v1"); });

  // Currency candidates must agree, including explicit defaults. Defaults are
  // used only in the absence of supplier currency evidence, never to override it.
  const price = value("price");
  let amount = price;
  const currencies: string[] = [];
  let badCurrency = issues.some((item) => item.field === "currency");
  const code = value("currency");
  if (code !== null) { currencies.push(String(code).toUpperCase()); rule("currency", "currency.uppercase.v1"); }
  if (typeof price === "string") {
    let text = price;
    for (let i = 0; i < 4; i++) {
      const prefix = /^([A-Za-z]{3}|[€£$¥])\s*/.exec(text);
      const suffix = /\s*([A-Za-z]{3}|[€£$¥])$/.exec(text);
      const token = prefix?.[1] ?? suffix?.[1];
      if (!token) break;
      evidence.currency ??= [];
      evidence.currency.push(...(evidence.price ?? []).filter((item) => item.kind === "cell"));
      if (/^[A-Za-z]{3}$/.test(token)) currencies.push(token.toUpperCase());
      else {
        const mapped = own(config.symbolCurrencies, token);
        setting("currency", `/symbolCurrencies/${pointer(token)}`);
        if (mapped) currencies.push(mapped);
        else { issue("currency", "AMBIGUOUS_CURRENCY", "Currency symbol has no approved supplier-specific interpretation."); badCurrency = true; }
      }
      rule("currency", "currency.extract-token.v1");
      text = (prefix ? text.slice(prefix[0].length) : text.slice(0, -suffix![0].length)).trim();
    }
    amount = text;
  }
  if (!currencies.length && !badCurrency && config.defaultCurrency) {
    currencies.push(config.defaultCurrency); setting("currency", "/defaultCurrency");
  }
  if (currencies.some((candidate) => !currencySchema.safeParse(candidate).success)) {
    issue("currency", "UNSUPPORTED_CURRENCY", "Only explicitly supported EUR, GBP and USD minor-unit rules are available."); badCurrency = true;
  }
  if (new Set(currencies).size > 1) { issue("currency", "CURRENCY_CONFLICT", "Supplier currency sources disagree; no conversion or override was applied."); badCurrency = true; }
  if (!badCurrency && currencies.length) normalized.currency = currencySchema.parse(currencies[0]);
  evidence.priceMinor = [...(evidence.price ?? []), ...(evidence.currency ?? [])];
  if (amount !== null) attempt("priceMinor", () => {
    const parsedAmount = numeric("priceMinor", amount);
    const minor = minorUnits(parsedAmount);
    if (normalized.currency) { normalized.priceMinor = minor; rule("priceMinor", "money.minor-units.v1"); }
    else issue("priceMinor", "PRICE_CURRENCY_REQUIRED", "Price requires an unambiguous supported currency.");
    if (minor === "0") issue("priceMinor", "ZERO_PRICE_REVIEW", "Zero was preserved; free-product policy requires review.");
  });
  function measurement(field: string, fallback: string | null, configPath: string, weight: boolean) {
    const raw = value(field);
    if (raw === null) return;
    attempt(field, () => {
      let amount: string | number = raw;
      let unit: string | null = null;
      if (typeof raw === "string") {
        const parts = /^(.*?)\s*([A-Za-z]+)$/.exec(raw);
        if (parts) { amount = parts[1]!.trim(); unit = parts[2]!; }
      }
      if (unit) {
        const alias = own(own(config.unitAliases, field), unit);
        if (alias) { unit = alias; setting(field, `/unitAliases/${pointer(field)}`); rule(field, "unit.approved-alias.v1"); }
        if (fallback && fallback !== unit) throw new ValueIssue("UNIT_CONFLICT", "Cell unit conflicts with the configured field unit.");
      } else if (fallback) { unit = fallback; setting(field, configPath); }
      else throw new ValueIssue("UNIT_REQUIRED", "Specify a unit in the source cell or explicit configuration.");
      const supported = weight ? weightUnitSchema.safeParse(unit) : dimensionUnitSchema.safeParse(unit);
      if (!supported.success) throw new ValueIssue("UNSUPPORTED_UNIT", "Unit is not supported for this measurement.");
      const factors: Record<string, string> = weight ? { g: "1", kg: "1000", lb: "453.59237", oz: "28.349523125" } : { cm: "1", mm: "0.1", m: "100", in: "2.54" };
      const converted = multiply(numeric(field, amount), factors[unit]!);
      rule(field, weight ? "unit.grams.v1" : "unit.centimetres.v1");
      if (weight) {
        const result = grams(converted);
        normalized.weightExactGrams = decimalText(converted); normalized.weightGrams = result.rounded;
        setting(field, "/weightRounding"); rule(field, "weight.half-up-gram.v1");
        if (result.changed) issue(field, "WEIGHT_ROUNDED", "Weight rounded half-up to whole grams; exact converted grams were retained.", "WARNING");
        evidence.weightGrams = [...(evidence[field] ?? [])]; evidence.weightExactGrams = [...(evidence[field] ?? [])];
      } else normalized.dimensionsCm[field.slice(11)] = decimalText(converted);
    });
  }
  measurement("weight", config.weightUnit, "/weightUnit", true);
  for (const field of Object.keys(config.columns).sort().filter((field) => field.startsWith("dimensions."))) {
    const name = field.slice(11); normalized.dimensionsCm[name] = null;
    measurement(field, own(config.dimensionUnits, name) ?? null, `/dimensionUnits/${pointer(name)}`, false);
    evidence[`dimensionsCm.${name}`] = [...(evidence[field] ?? [])];
  }
  for (const field of config.requiredFields) {
    if (normalized[field] === null || normalized[field] === "") { setting(field, "/requiredFields"); issue(field, "MISSING_REQUIRED", "Required cleaned value is missing or unresolved."); }
  }
  return cleaningOutputSchema.parse({ normalized, evidence, issues,
    outcome: issues.some((item) => item.severity === "ERROR") ? "FAILED" : issues.some((item) => item.severity === "REVIEW") ? "NEEDS_REVIEW" : "READY" });
}

export type { CleaningConfig, CleaningOutput } from "./contracts";
