import { cleanRow } from "@catalogforge/cleaning";
import { exampleConfig, exampleSource } from "@catalogforge/cleaning/example";
import type { GroupingConfig, InputRow } from "./contracts";

export const exampleGroupingConfig: GroupingConfig = {
  namespace: "supplier-family-v1", familyAttribute: "familyId", skuFamilies: {}, missingFamily: "REVIEW",
  optionFields: { diameter: "dimensionsCm.diameter" }, productAttributes: ["colour"]
};
export const exampleCleaningConfig = structuredClone(exampleConfig);
exampleCleaningConfig.columns["attributes.familyId"] = [{ columnIndex: 9, expectedHeader: "Family" }];
export const exampleGroupingSources = [14, 15, 212].map((rowNumber, index) => {
  const source = structuredClone(exampleSource);
  source.id = `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`;
  source.rawCells[0]!.value = index === 1 ? "TC-PL-30" : index === 2 ? " TC-PL-20 " : "TC-PL-20";
  source.rawCells[3]!.value = index === 1 ? null : "24,99 €";
  source.rawCells[6]!.value = index === 1 ? "30 cm" : "20 cm";
  source.rawCells.push({ columnIndex: 9, header: "Family", value: "TC-POT" });
  return { rowNumber, source };
});
// These canonical tokens are fixture expectations, not a SKU normalization rule.
export const exampleGroupingRows: InputRow[] = exampleGroupingSources.map(({ source }, index) => ({
  ...cleanRow(source, exampleCleaningConfig), id: source.id, sourceRowId: source.id,
  mappedFields: Object.keys(exampleCleaningConfig.columns), canonicalSku: index === 1 ? "tc-pl-30" : "tc-pl-20", trustedSku: true, trustedFamily: true
}));
