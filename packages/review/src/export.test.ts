import { expect, it } from "vitest";
import { categoryFromPath } from "./catalog";
import { csvCell } from "./export";
import { minorToDecimal } from "./contracts";
it.each(["=HYPERLINK(\"https://example.com\")","+SUM(1,2)"," @command","-1+1","\t=1+1","\nvalue"])("neutralizes formula/control-leading text %s", value=>{expect(csvCell(value)).toMatch(/^"'/);});
it("quotes exact UTF-8, multiline values, escaped quotes and zero-prefixed SKU strings",()=>{
 expect(csvCell("000123")).toBe('"000123"');expect(csvCell('Café, "blue"\nNot frost-proof.')).toBe('"Café, ""blue""\nNot frost-proof."');expect(minorToDecimal("9223372036854775807")).toBe("92233720368547758.07");
});

it("accepts exact and once-encoded categories while rejecting unknown or malformed paths",()=>{
 const category="Electronics > Cables & Adapters";expect(categoryFromPath(category)).toBe(category);expect(categoryFromPath(encodeURIComponent(category))).toBe(category);expect(categoryFromPath("%E0%A4%A")).toBeNull();expect(categoryFromPath("Unknown > Category")).toBeNull();expect(categoryFromPath(encodeURIComponent(encodeURIComponent(category)))).toBeNull();
});
