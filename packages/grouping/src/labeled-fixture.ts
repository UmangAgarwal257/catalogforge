import { cleanRow } from "@catalogforge/cleaning";
import { exampleGroupingSources, exampleCleaningConfig, exampleGroupingConfig } from "./example";
import type { InputRow } from "./contracts";
import type { Label } from "./accuracy";

// Hand labels: similar titles are intentionally unrelated; same-SKU families
// X/Y intentionally contradict each other and must both abstain.
const cases = [
  ["A", "a-20", "A", "2499"], ["A", "a-20", "A", "2499"], ["A", "a-30", "A", "2999"],
  ["B", "b-20", "B", "2499"], [null, "c-20", "C", "2499"],
  ["X", "collision", "X", "2499"], ["Y", "collision", "Y", "2499"], ["E", "e-20", "E", null]
] as const;
export const labeledConfig = { ...exampleGroupingConfig, optionFields: {} };
export const labeledSpecs = cases.map(([family, sku, , price]) => ({ family, sku, price: price === null ? null : price === "2999" ? "29,99 €" : "24,99 €" }));
export const labeledRows: InputRow[] = labeledSpecs.map(({ family, sku, price }, i) => {
  const source = structuredClone(exampleGroupingSources[0]!.source);
  source.id = `00000000-0000-4000-8000-${String(i + 100).padStart(12, "0")}`;
  source.rawCells[0]!.value = sku; source.rawCells[3]!.value = price; source.rawCells[9]!.value = family;
  return { ...cleanRow(source, exampleCleaningConfig), id: source.id, sourceRowId: source.id, canonicalSku: sku,
    mappedFields: Object.keys(exampleCleaningConfig.columns), trustedSku: true, trustedFamily: family !== null };
});
export const groupingLabels: Label[] = cases.map(([, sku, family], i) => ({ sourceRowId: labeledRows[i]!.sourceRowId, family, variant: family === "X" || family === "Y" ? null : sku }));
