import { describe, expect, it } from "vitest";
import { cleanRow } from "./clean";
import { configIdentity } from "./persistence";
import { exampleConfig, exampleSource } from "./example";
import type { CleaningConfig, CleaningSource } from "./contracts";

const config = (changes: Partial<CleaningConfig> = {}): CleaningConfig => ({ ...structuredClone(exampleConfig), ...changes });
function sourceCell(index: number, value: CleaningSource["rawCells"][number]["value"]) {
  const source = structuredClone(exampleSource); source.rawCells[index]!.value = value; return source;
}
const price = (value: string | number | null, changes: Partial<CleaningConfig> = {}) =>
  cleanRow(sourceCell(3, value), config({ defaultCurrency: "EUR", ...changes }));
const codes = (result: ReturnType<typeof cleanRow>) => result.issues.map((issue) => issue.code);
const untrustedCells: CleaningSource["rawCells"][number]["value"][] = [{ formula: "1+1", result: 2 }, { error: "#VALUE!" }, true];

it("cleans the realistic one-row fixture with exact values, qualifications, lists and source-backed evidence", () => {
  const before = structuredClone(exampleSource);
  const result = cleanRow(exampleSource, exampleConfig);
  expect(result.outcome).toBe("READY");
  expect(result.normalized).toMatchObject({ sku: "00123", title: "Terracotta Pot", priceMinor: "129900", currency: "EUR",
    quantity: 12, weightGrams: 1800, weightExactGrams: "1800", dimensionsCm: { diameter: "20.32" }, attributes: { colour: "terracota" } });
  expect(result.normalized.descriptionHtml).toBe('<p>Frost-resistant, <strong>not frost-proof</strong>.</p><p>Bring indoors below 0 °C.</p><ul><li>Drainage hole</li><li>Indoor use</li></ul>');
  expect(result.normalized.descriptionText).toBe("Frost-resistant, not frost-proof.\nBring indoors below 0 °C.\n- Drainage hole\n- Indoor use");
  expect(result.evidence.priceMinor).toContainEqual({ kind: "cell", sourceRowId: exampleSource.id, columnIndex: 3, valuePointer: "/value" });
  expect(result.evidence.priceMinor).toContainEqual({ kind: "configuration", path: "/symbolCurrencies/€" });
  expect(result.evidence.priceMinor).toContainEqual({ kind: "transformation", rule: "money.minor-units.v1" });
  expect(result.evidence.descriptionHtml?.filter((item) => item.kind === "cell").map((item) => item.columnIndex)).toEqual([2]);
  expect(result.issues).toContainEqual(expect.objectContaining({ code: "HTML_SANITIZED", severity: "WARNING" }));
  expect(exampleSource).toEqual(before);
  expect(cleanRow(exampleSource, exampleConfig)).toEqual(result);
});

describe("exact conservative money", () => {
  it.each([
    ["1.299,00 €", { decimal: ",", grouping: "." }, "129900"],
    ["1,299.00", { decimal: ".", grouping: "," }, "129900"],
    ["1 299,00", { decimal: ",", grouping: " " }, "129900"],
    ["1\u202f299,00", { decimal: ",", grouping: " " }, "129900"],
    ["12.5", null, "1250"], ["12,50", null, "1250"], ["1.299,00 €", null, "129900"],
    ["1,299,000", null, "129900000"], ["1.299", { decimal: ",", grouping: "." }, "129900"],
    ["0.29", null, "29"], [12.5, { decimal: ",", grouping: "." }, "1250"],
    ["92233720368547758.07", null, "9223372036854775807"]
  ] as const)("parses %s without float arithmetic", (input, format, expected) => {
    expect(price(input, { numberFormat: format }).normalized.priceMinor).toBe(expected);
  });
  it.each([
    ["1,299", "AMBIGUOUS_NUMBER"], ["1.299", "AMBIGUOUS_NUMBER"], ["1.2345", "PRICE_PRECISION"],
    ["-2", "INVALID_NUMBER"], ["1e3", "INVALID_NUMBER"], ["+2", "INVALID_NUMBER"],
    ["12.00 net", "UNSUPPORTED_CURRENCY"], ["10–20", "INVALID_NUMBER"], ["92233720368547758.08", "PRICE_RANGE"]
  ])("reviews %s", (input, code) => {
    const result = price(input!, { numberFormat: null });
    expect(result.normalized.priceMinor).toBeNull(); expect(codes(result)).toContain(code); expect(result.outcome).toBe("NEEDS_REVIEW");
  });
  it("validates grouping and refuses precision loss even with an explicit locale", () => {
    expect(codes(price("12.99,00"))).toContain("INVALID_GROUPING");
    expect(codes(price("1,299"))).toContain("PRICE_PRECISION");
  });
  it("preserves missing and zero as distinct values", () => {
    expect(price(null).normalized.priceMinor).toBeNull(); expect(price(" ").normalized.priceMinor).toBeNull();
    const zero = price("0"); expect(zero.normalized.priceMinor).toBe("0"); expect(codes(zero)).toContain("ZERO_PRICE_REVIEW");
  });
  it("does not treat $ as USD without supplier policy", () => {
    expect(codes(price("$8"))).toContain("AMBIGUOUS_CURRENCY");
    const result = price("$8", { symbolCurrencies: { "$": "USD" } });
    expect(result.normalized).toMatchObject({ priceMinor: "800", currency: "USD" });
  });
  it("supports an explicitly approved pound symbol", () => {
    expect(price("£8", { symbolCurrencies: { "£": "GBP" } }).normalized).toMatchObject({ priceMinor: "800", currency: "GBP" });
  });
  it("keeps defaults distinct from supplier currency and never overrides a conflict", () => {
    const result = price("12", { defaultCurrency: "USD" });
    expect(result.evidence.currency).toEqual([{ kind: "configuration", path: "/defaultCurrency" }]);
    const source = sourceCell(3, "12 €"); source.rawCells.push({ columnIndex: 9, header: "Currency", value: "GBP" });
    const mapping = config(); mapping.columns.currency = [{ columnIndex: 9, expectedHeader: "Currency" }];
    const conflict = cleanRow(source, mapping);
    expect(conflict.normalized.currency).toBeNull(); expect(conflict.normalized.priceMinor).toBeNull();
    expect(codes(conflict)).toContain("CURRENCY_CONFLICT");
    expect(conflict.evidence.priceMinor?.filter((item) => item.kind === "cell").map((item) => item.columnIndex)).toEqual(expect.arrayContaining([3, 9]));
  });
  it("rejects unsupported currencies instead of assuming an exponent", () => {
    expect(codes(price("JPY 8"))).toContain("UNSUPPORTED_CURRENCY");
  });
});

describe("mapping, identity and exact evidence", () => {
  it("does not choose between conflicting duplicate headers", () => {
    const mapping = config(); mapping.columns.description!.push({ columnIndex: 8, expectedHeader: "Notes" });
    const result = cleanRow(exampleSource, mapping);
    expect(codes(result)).toContain("CONFLICTING_CELLS"); expect(result.normalized.descriptionHtml).toBeNull();
    expect(result.issues.find((issue) => issue.code === "CONFLICTING_CELLS")!.evidence.filter((item) => item.kind === "cell")).toHaveLength(2);
  });
  it("flags absent/renamed columns without falling back to other headers", () => {
    const mapping = config(); mapping.columns.sku![0]!.expectedHeader = "Other SKU";
    expect(codes(cleanRow(exampleSource, mapping))).toContain("MAPPING_HEADER");
  });
  it("does not reconstruct numeric SKU zeros from Excel formatting", () => {
    const source = sourceCell(0, 123); source.rawCells[0]!.metadata = { numFmt: "00000" };
    const result = cleanRow(source, exampleConfig);
    expect(result.normalized.sku).toBe("123"); expect(codes(result)).toContain("NUMERIC_SKU");
  });
  it("preserves SKU case and internal characters for database identity canonicalization later", () => {
    expect(cleanRow(sourceCell(0, "  AbC-00 X  "), exampleConfig).normalized.sku).toBe("AbC-00 X");
  });
  it("applies aliases only from the explicit config", () => {
    const mapping = config({ aliases: { "attributes.colour": { terracota: "terracotta" } } });
    const result = cleanRow(exampleSource, mapping);
    expect(result.normalized.attributes.colour).toBe("terracotta");
    expect(result.evidence["attributes.colour"]).toContainEqual({ kind: "configuration", path: "/aliases/attributes.colour" });
    expect(cleanRow(exampleSource, exampleConfig).normalized.attributes.colour).toBe("terracota");
  });
  it("does not read inherited object properties as approved aliases", () => {
    expect(cleanRow(sourceCell(7, "toString"), exampleConfig).normalized.attributes.colour).toBe("toString");
  });
  it("recognizes only configured missing-value tokens", () => {
    expect(codes(cleanRow(sourceCell(4, "N/A"), exampleConfig))).toContain("INVALID_NUMBER");
    const mapping = config({ nullTokens: { quantity: ["N/A"] } });
    expect(cleanRow(sourceCell(4, "N/A"), mapping).normalized.quantity).toBeNull();
    expect(cleanRow(sourceCell(0, "N/A"), mapping).normalized.sku).toBe("N/A");
  });
  it.each(untrustedCells)("reviews untrusted mapped structured evidence %j", (value) => {
    const result = cleanRow(sourceCell(3, value), exampleConfig);
    expect(codes(result)).toContain("UNSUPPORTED_CELL"); expect(result.outcome).toBe("NEEDS_REVIEW");
  });
  it("retains rich text and requires review of potentially meaningful formatting", () => {
    const result = cleanRow(sourceCell(1, { richText: [{ text: "Not " }, { text: "frost-proof", font: { strike: true } }] }), exampleConfig);
    expect(result.normalized.title).toBe("Not frost-proof"); expect(codes(result)).toContain("RICH_TEXT_FORMATTING");
  });
  it("flags broken/control text without guessing a repair", () => {
    const result = cleanRow(sourceCell(1, "Pot\ufffd\u200b"), exampleConfig);
    expect(result.normalized.title).toBe("Pot\ufffd\u200b"); expect(codes(result)).toContain("SUSPICIOUS_TEXT");
  });
  it("fails malformed ordered evidence and mismatched scope", () => {
    const source = structuredClone(exampleSource); source.rawCells[0]!.columnIndex = 2;
    expect(cleanRow(source, exampleConfig).outcome).toBe("FAILED");
    expect(cleanRow(exampleSource, config({ sheetIndex: 1 })).outcome).toBe("FAILED");
    expect(cleanRow(exampleSource, config({ storeId: crypto.randomUUID() })).outcome).toBe("FAILED");
  });
  it("rejects an oversized source cell instead of truncating its evidence", () => {
    const source = sourceCell(2, "x".repeat(65537));
    const before = structuredClone(source);
    expect(cleanRow(source, exampleConfig).outcome).toBe("FAILED");
    expect(source).toEqual(before);
  });
  it("validates configuration rather than silently ignoring unsupported policy", () => {
    expect(() => cleanRow(exampleSource, { ...exampleConfig, guessPrices: true })).toThrow();
    expect(() => cleanRow(exampleSource, config({ numberFormat: { decimal: ",", grouping: "," } }))).toThrow();
  });
  it("hashes configs independently of object key order and changes identity for changed mappings", () => {
    const reordered = Object.fromEntries(Object.entries(exampleConfig).reverse());
    expect(configIdentity(reordered).configHash).toBe(configIdentity(exampleConfig).configHash);
    const mapping = config(); mapping.columns.description = [{ columnIndex: 8, expectedHeader: "Notes" }];
    expect(configIdentity(mapping).configHash).not.toBe(configIdentity(exampleConfig).configHash);
  });
});

describe("units, quantity and HTML", () => {
  it("converts with exact factors and records rounding", () => {
    const result = cleanRow(sourceCell(5, "1 lb"), exampleConfig);
    expect(result.normalized).toMatchObject({ weightGrams: 454, weightExactGrams: "453.59237" });
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "WEIGHT_ROUNDED", severity: "WARNING" }));
  });
  it.each([["1 oz", 28, "28.349523125"], ["10 g", 10, "10"], ["0,0005 kg", 1, "0.5"]] as const)("converts weight %s with explicit half-up rounding", (input, rounded, exact) => {
    expect(cleanRow(sourceCell(5, input), exampleConfig).normalized).toMatchObject({ weightGrams: rounded, weightExactGrams: exact });
  });
  it.each([["100 mm", "10"], ["2 m", "200"], ["1 cm", "1"]])("converts dimension %s", (input, expected) => {
    expect(cleanRow(sourceCell(6, input!), exampleConfig).normalized.dimensionsCm.diameter).toBe(expected);
  });
  it("records configured units separately from unit-bearing cells", () => {
    const result = cleanRow(sourceCell(5, "1,8"), config({ weightUnit: "kg" }));
    expect(result.normalized.weightGrams).toBe(1800);
    expect(result.evidence.weightGrams).toContainEqual({ kind: "configuration", path: "/weightUnit" });
    expect(cleanRow(exampleSource, exampleConfig).evidence.weightGrams).not.toContainEqual({ kind: "configuration", path: "/weightUnit" });
  });
  it("accepts unit aliases only when configured", () => {
    expect(codes(cleanRow(sourceCell(5, "1 lbs"), exampleConfig))).toContain("UNSUPPORTED_UNIT");
    expect(cleanRow(sourceCell(5, "1 lbs"), config({ unitAliases: { weight: { lbs: "lb" } } })).normalized.weightGrams).toBe(454);
  });
  it.each([["1,8", "UNIT_REQUIRED"], ["-1 kg", "INVALID_NUMBER"], ["1 ton", "UNSUPPORTED_UNIT"], ["9999999999 kg", "WEIGHT_RANGE"]])("reviews weight %s", (value, code) => {
    expect(codes(cleanRow(sourceCell(5, value!), exampleConfig))).toContain(code);
  });
  it("does not ignore a conflict between configured and cell units", () => {
    expect(codes(cleanRow(exampleSource, config({ weightUnit: "g" })))).toContain("UNIT_CONFLICT");
  });
  it.each([["0", 0], ["12", 12], ["12,0", 12]])("keeps whole quantities %s", (value, expected) => {
    expect(cleanRow(sourceCell(4, value!), exampleConfig).normalized.quantity).toBe(expected);
  });
  it.each(["12,5", "12 packs", "1-4", "-1", "2147483648"]) ("reviews invalid quantity %s", (value) => {
    const result = cleanRow(sourceCell(4, value), exampleConfig);
    expect(result.normalized.quantity).toBeNull(); expect(result.outcome).toBe("NEEDS_REVIEW");
  });
  it("makes harmless script/handler removal nonblocking and preserves negation", () => {
    const result = cleanRow(sourceCell(2, '<p onclick="alert(1)">Not frost-proof &amp; bring indoors.</p><script>alert(1)</script><img src=x onerror=alert(1)>'), exampleConfig);
    expect(result.outcome).toBe("READY"); expect(result.normalized.descriptionText).toBe("Not frost-proof & bring indoors.");
    expect(result.normalized.descriptionHtml).not.toMatch(/onclick|onerror|script|img/);
  });
  it.each(['<img alt="Not frost-proof" src="care.png">', '<iframe>Care instructions</iframe>', '<p><s>Frost-proof</s></p>', '<svg><text>Bring indoors</text></svg>']) ("requires review when meaningful content may be lost: %s", (value) => {
    expect(codes(cleanRow(sourceCell(2, value), exampleConfig))).toContain("DESCRIPTION_CONTENT_REVIEW");
  });
  it.each([
    "<p>Frost-resistant.</p><!-- Not frost-proof: bring indoors below 0 °C. -->",
    "<p>Pot</p><!-- Indoor use only -->",
    "<p>Pot</p><!-- Not food-safe",
    "<p>Pot</p><!-- Not frost-proof --!>"
  ])("requires review for discarded nonempty comments: %s", (value) => {
    const source = sourceCell(2, value);
    const before = structuredClone(source);
    const result = cleanRow(source, exampleConfig);
    expect(result.outcome).toBe("NEEDS_REVIEW");
    expect(codes(result)).toContain("DESCRIPTION_COMMENT_REVIEW");
    expect(result.evidence.descriptionHtml).toContainEqual(expect.objectContaining({ kind: "cell", columnIndex: 2 }));
    expect(source).toEqual(before);
  });
  it("does not require review for an empty comment", () => {
    expect(cleanRow(sourceCell(2, "<p>Pot</p><!--   -->"), exampleConfig).outcome).toBe("READY");
  });
  it.each([
    ["Not<p>frost-proof.</p>", "Not\nfrost-proof."],
    ["For indoor use<p>only.</p>Not<p>food-safe.</p>", "For indoor use\nonly.\nNot\nfood-safe."],
    ["Not<ul><li>frost-proof</li><li>food-safe</li></ul>Bring indoors.", "Not\n- frost-proof\n- food-safe\nBring indoors."],
    ["Care<ol><li>Bring indoors<p>below 0 °C.</p></li></ol>Only.", "Care\n- Bring indoors\nbelow 0 °C.\nOnly."],
    ["Not<div>frost-proof.</div><blockquote>Indoor use only.</blockquote>", "Not\nfrost-proof.\nIndoor use only."]
  ])("preserves block boundaries and qualifiers: %s", (value, expected) => {
    const result = cleanRow(sourceCell(2, value!), exampleConfig);
    expect(result.normalized.descriptionText).toBe(expected);
    expect(result.outcome).toBe("READY");
  });
  it("keeps escaped markup as text without double decoding or execution", () => {
    const result = cleanRow(sourceCell(2, '<p>&lt;script&gt; is literal; &amp;lt; is also literal.</p>'), exampleConfig);
    expect(result.normalized.descriptionText).toBe("<script> is literal; &lt; is also literal.");
    expect(result.normalized.descriptionHtml).toContain("&lt;script&gt;");
  });
  it("preserves common block wrappers as separate paragraphs", () => {
    const result = cleanRow(sourceCell(2, "<div>Not frost-proof.</div><div>Bring indoors.</div>"), exampleConfig);
    expect(result.normalized.descriptionText).toBe("Not frost-proof.\nBring indoors.");
    expect(result.outcome).toBe("READY");
  });
  it("requires review when CSS or discarded attributes carry possible business meaning", () => {
    expect(codes(cleanRow(sourceCell(2, '<span style="text-decoration:line-through">Frost-proof</span>'), exampleConfig))).toContain("DESCRIPTION_CONTENT_REVIEW");
    expect(codes(cleanRow(sourceCell(2, '<abbr title="Bring indoors">Care</abbr>'), exampleConfig))).toContain("DESCRIPTION_CONTENT_REVIEW");
  });
  it("does not attribute numeric XLSX values to an unused locale setting", () => {
    expect(price(12.5).evidence.priceMinor).not.toContainEqual({ kind: "configuration", path: "/numberFormat" });
  });
});
