import type { NumberFormat } from "./contracts";

export class ValueIssue extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}
export type Decimal = { integer: bigint; scale: number };
const power = (scale: number) => 10n ** BigInt(scale);

// All arithmetic after lexical validation is integer arithmetic, including money.
export function decimal(value: string | number, format: NumberFormat): Decimal {
  if (typeof value === "number" && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
    throw new ValueIssue("UNSAFE_NUMBER", "Numeric source value is outside the safe representation range.");
  }
  let text = String(value).trim().replace(/[\u00a0\u202f]/g, " ");
  if (!text || text.length > 100 || /[eE+\-]/.test(text)) throw new ValueIssue("INVALID_NUMBER", "Use a nonnegative decimal value without exponents or signs.");
  // Excel numeric values already have a decimal representation, not display-locale separators.
  if (typeof value === "number") format = { decimal: ".", grouping: null };
  if (!format) {
    if (/^\d+$/.test(text)) format = { decimal: ".", grouping: null };
    else if (/^\d+[.,]\d{3}$/.test(text)) throw new ValueIssue("AMBIGUOUS_NUMBER", "Specify the decimal/grouping convention for this value.");
    else if (/^\d+[.,]\d+$/.test(text)) format = { decimal: text.includes(",") ? "," : ".", grouping: null };
    else if (/^\d{1,3}(,\d{3})+\.\d+$/.test(text) || /^\d{1,3}(,\d{3}){2,}$/.test(text)) format = { decimal: ".", grouping: "," };
    else if (/^\d{1,3}(\.\d{3})+,\d+$/.test(text) || /^\d{1,3}(\.\d{3}){2,}$/.test(text)) format = { decimal: ",", grouping: "." };
    else throw new ValueIssue("INVALID_NUMBER", "Value does not match a supported unambiguous number format.");
  }
  const parts = text.split(format.decimal);
  if (parts.length > 2) throw new ValueIssue("INVALID_NUMBER", "Multiple decimal separators.");
  let whole = parts[0]!;
  const fraction = parts[1] ?? "";
  if (parts.length === 2 && !/^\d{1,9}$/.test(fraction)) throw new ValueIssue("INVALID_NUMBER", "Use one to nine decimal digits.");
  if (format.grouping && whole.includes(format.grouping)) {
    const groups = whole.split(format.grouping);
    if (!/^\d{1,3}$/.test(groups[0]!) || groups.slice(1).some((group) => !/^\d{3}$/.test(group))) throw new ValueIssue("INVALID_GROUPING", "Thousands groups must contain exactly three digits.");
    whole = groups.join("");
  }
  if (!/^\d+$/.test(whole)) throw new ValueIssue("INVALID_NUMBER", "Value does not match the configured number format.");
  text = whole + fraction;
  return { integer: BigInt(text), scale: fraction.length };
}
export function minorUnits(value: Decimal): string {
  if (value.scale > 2) throw new ValueIssue("PRICE_PRECISION", "Supported currencies allow at most two fractional digits; no rounding was applied.");
  const result = value.integer * power(2 - value.scale);
  if (result > 9223372036854775807n) throw new ValueIssue("PRICE_RANGE", "Price exceeds PostgreSQL BIGINT range.");
  return result.toString();
}
export function count(value: Decimal): number {
  const divisor = power(value.scale);
  if (value.integer % divisor) throw new ValueIssue("QUANTITY_FRACTION", "Quantity must be a whole count; packs and ranges need review.");
  const integer = value.integer / divisor;
  if (integer > 2147483647n) throw new ValueIssue("QUANTITY_RANGE", "Quantity exceeds the supported integer range.");
  return Number(integer);
}
export function multiply(value: Decimal, factor: string): Decimal {
  const exact = decimal(factor, { decimal: ".", grouping: null });
  return { integer: value.integer * exact.integer, scale: value.scale + exact.scale };
}
export function decimalText(value: Decimal): string {
  const text = value.integer.toString().padStart(value.scale + 1, "0");
  return value.scale ? `${text.slice(0, -value.scale)}.${text.slice(-value.scale)}`.replace(/0+$/, "").replace(/\.$/, "") : text;
}
export function grams(value: Decimal): { rounded: number; changed: boolean } {
  const divisor = power(value.scale);
  const remainder = value.integer % divisor;
  const rounded = value.integer / divisor + (remainder * 2n >= divisor ? 1n : 0n);
  if (rounded > 2147483647n) throw new ValueIssue("WEIGHT_RANGE", "Weight exceeds the supported integer range.");
  return { rounded: Number(rounded), changed: remainder !== 0n };
}
