import type { CleaningConfig, CleaningSource } from "./contracts";

// Test/demo policy only. Real suppliers must provide their own explicit config.
export const exampleConfig: CleaningConfig = {
  storeId: "00000000-0000-4000-8000-000000000001", supplierId: "00000000-0000-4000-8000-000000000002", sheetIndex: 0,
  columns: {
    sku: [{ columnIndex: 0, expectedHeader: "SKU" }], title: [{ columnIndex: 1, expectedHeader: "Title" }],
    description: [{ columnIndex: 2, expectedHeader: "Notes" }], price: [{ columnIndex: 3, expectedHeader: "Price" }],
    quantity: [{ columnIndex: 4, expectedHeader: "Qty" }], weight: [{ columnIndex: 5, expectedHeader: "Weight" }],
    "dimensions.diameter": [{ columnIndex: 6, expectedHeader: "Diameter" }], "attributes.colour": [{ columnIndex: 7, expectedHeader: "Colour" }]
  },
  numberFormat: { decimal: ",", grouping: "." }, defaultCurrency: null, symbolCurrencies: { "€": "EUR" },
  weightUnit: null, dimensionUnits: {}, unitAliases: {}, aliases: {}, nullTokens: {},
  requiredFields: ["sku", "title", "priceMinor", "currency"], htmlPolicy: "basic-v1", weightRounding: "half-up-gram-v1"
};
export const exampleSource: CleaningSource = {
  id: "00000000-0000-4000-8000-000000000003", storeId: exampleConfig.storeId, sheetIndex: 0,
  rawCells: [
    { columnIndex: 0, header: "SKU", value: " 00123 " },
    { columnIndex: 1, header: "Title", value: " Terracotta   Pot " },
    { columnIndex: 2, header: "Notes", value: '<p>Frost-resistant, <strong>not frost-proof</strong>.</p><p>Bring indoors below 0 °C.</p><ul><li>Drainage hole</li><li>Indoor use</li></ul><script>alert(1)</script>' },
    { columnIndex: 3, header: "Price", value: "1.299,00 €" },
    { columnIndex: 4, header: "Qty", value: " 12 " },
    { columnIndex: 5, header: "Weight", value: "1,8 kg" },
    { columnIndex: 6, header: "Diameter", value: "8 in" },
    { columnIndex: 7, header: "Colour", value: " terracota " },
    { columnIndex: 8, header: "Notes", value: "Supplier note in a duplicate header; not implicitly merged." }
  ]
};
