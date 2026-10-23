import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { parseSpreadsheet } from "./parser";
import { LIMITS, parsedRowSchema, validateFile } from "./contracts";

async function rows(text: string | Uint8Array, filename = "supplier.csv") {
  const result = [];
  for await (const row of parseSpreadsheet(typeof text === "string" ? Buffer.from(text) : text, filename)) result.push(row);
  return result;
}

describe("CSV evidence", () => {
  it.each([",", ";"])("supports BOM, %s delimiter, duplicate headers, repeated rows, and leading zeros", async (separator) => {
    const text = "\ufeff" + ["SKU|Notes|Notes", "00123|first|second", "00123|first|second"].map((row) => row.replaceAll("|", separator)).join("\r\n");
    const parsed = await rows(text);
    expect(parsed.map((row) => row.rowNumber)).toEqual([2, 3]);
    expect(parsed[0]?.rawCells.map((cell) => [cell.header, cell.value])).toEqual([["SKU", "00123"], ["Notes", "first"], ["Notes", "second"]]);
    expect(parsed[0]?.rawCells).toEqual(parsed[1]?.rawCells);
  });

  it.each(["\n", "\r\n", "\r"])("preserves physical start lines across blanks and quoted newlines using %j", async (newline) => {
    const text = ["SKU,Notes", "", '001,"first', 'second"', "", "002,last"].join(newline);
    const parsed = await rows(text);
    expect(parsed.map((row) => row.rowNumber)).toEqual([3, 6]);
    expect(parsed[0]?.rawCells[1]?.value).toBe(`first${newline}second`);
  });

  it("uses the first nonblank header, keeps whitespace values, and preserves uneven widths", async () => {
    const parsed = await rows("\nSKU,Notes\n001,  spaced  ,extra\n002\n   ,  \n");
    expect(parsed.map((row) => row.rowNumber)).toEqual([3, 4]);
    expect(parsed[0]?.rawCells[1]?.value).toBe("  spaced  ");
    expect(parsed[0]?.rawCells[2]).toMatchObject({ header: null, value: "extra" });
    expect(parsed[1]?.rawCells[1]).toMatchObject({ value: null, metadata: { missing: true } });
    expect(parsed[0]?.issues[0]?.code).toBe("COLUMN_COUNT");
  });

  it("allows a header-only CSV with zero accepted records", async () => {
    expect(await rows("SKU\n")).toEqual([]);
  });

  it("rejects malformed quotes, invalid UTF-8, and ambiguous delimiters", async () => {
    await expect(rows('SKU,Notes\n001,"unclosed')).rejects.toThrow(/Malformed CSV/);
    await expect(rows(Uint8Array.from([0xff, 0xfe, 0x41]))).rejects.toThrow(/UTF-8/);
    await expect(rows("A,B;C\nx,y;z")).rejects.toThrow(/both plausible/);
  });

  it("accepts 10,000 records and rejects 10,001", async () => {
    const valid = "SKU\n" + Array.from({ length: 10000 }, () => "001").join("\n");
    expect((await rows(valid)).length).toBe(10000);
    await expect(rows(valid + "\n002")).rejects.toThrow(/10,000/);
  });

  it("rejects excessive columns and cell sizes", async () => {
    await expect(rows(Array(257).fill("header").join(",") + "\nx")).rejects.toThrow(/256 columns/);
    await expect(rows("SKU\n" + "x".repeat(LIMITS.cellChars))).rejects.toThrow(/64 KiB/);
  });
});

describe("XLSX evidence", () => {
  it("preserves multiple sheet coordinates, blank rows, textual SKUs, and value metadata", async () => {
    const book = new ExcelJS.Workbook();
    book.addWorksheet("Empty first");
    const first = book.addWorksheet("Pots");
    first.getRow(3).values = ["SKU", "Notes", "Notes", "Date", "Formula"];
    first.getRow(5).values = ["00123", "a", "b", new Date("2026-01-02T00:00:00Z"), { formula: "1+1", result: 2 }];
    first.getCell("D5").numFmt = "yyyy-mm-dd";
    const second = book.addWorksheet("Other");
    second.addRow(["SKU", "Number"]);
    second.addRow(["00009", 9]);
    second.getCell("B2").numFmt = "00000";
    const parsed = await rows(new Uint8Array(await book.xlsx.writeBuffer()), "supplier.xlsx");
    expect(parsed.map((row) => [row.sheetIndex, row.sheetName, row.rowNumber])).toEqual([[1, "Pots", 5], [2, "Other", 2]]);
    expect(parsed[0]?.rawCells[0]?.value).toBe("00123");
    expect(parsed[0]?.rawCells[3]).toMatchObject({ value: "2026-01-02T00:00:00.000Z", metadata: { numFmt: "yyyy-mm-dd" } });
    expect(parsed[0]?.rawCells[4]?.value).toMatchObject({ formula: "1+1", result: 2 });
    expect(parsed[0]?.issues.some((issue) => issue.code === "FORMULA_UNTRUSTED")).toBe(true);
    expect(parsed[1]?.rawCells[1]).toMatchObject({ value: 9, metadata: { numFmt: "00000" } });
  });

  it("repeatedly preserves worksheet order and complete evidence on identical XLSX bytes", async () => {
    const book = new ExcelJS.Workbook();
    book.addWorksheet("Empty");
    const sheet = book.addWorksheet("Pots");
    sheet.getRow(2).values = ["SKU", "Notes", "Notes", "Formula", "Error"];
    sheet.getRow(5).values = ["0007", "first", "second", { formula: "1+1", result: 2 }, { error: "#DIV/0!" }];
    const other = book.addWorksheet("Other");
    other.addRow(["SKU"]); other.addRow(["0008"]);
    const bytes = new Uint8Array(await book.xlsx.writeBuffer());
    const expected = await rows(bytes, "supplier.xlsx");
    expect(expected.map(row => [row.sheetIndex, row.sheetName, row.rowNumber])).toEqual([[1, "Pots", 5], [2, "Other", 2]]);
    expect(expected[0]?.rawCells.map(cell => [cell.header, cell.value])).toEqual([
      ["SKU", "0007"], ["Notes", "first"], ["Notes", "second"], ["Formula", { formula: "1+1", result: 2 }], ["Error", { error: "#DIV/0!" }]
    ]);
    for (let attempt = 0; attempt < 100; attempt++) expect(await rows(bytes, "supplier.xlsx")).toEqual(expected);
  });

  it.each([[100, 8], [1000, 8], [10000, 8], [10000, 32]])("parses exactly %i records across %i columns without changing evidence", async (count, width) => {
    const book = new ExcelJS.Workbook(); book.addWorksheet("Empty");
    const sheet = book.addWorksheet("Supplier");
    sheet.getRow(2).values = Array.from({ length: width! }, (_, column) => column === 0 ? "SKU" : "Notes");
    for (let row = 0; row < count!; row++) sheet.getRow(row + 4).values = Array.from({ length: width! }, (_, column) => column === 0 ? String(row).padStart(6, "0") : `v-${row}-${column}`);
    const parsed = await rows(new Uint8Array(await book.xlsx.writeBuffer()), "supplier.xlsx");
    expect(parsed).toHaveLength(count!);
    for (const [index, row] of parsed.entries()) {
      expect([row.sheetIndex, row.sheetName, row.rowNumber]).toEqual([1, "Supplier", index + 4]);
      expect(row.rawCells.map(cell => [cell.columnIndex, cell.header, cell.value])).toEqual(
        Array.from({ length: width! }, (_, column) => [column, column === 0 ? "SKU" : "Notes", column === 0 ? String(index).padStart(6, "0") : `v-${index}-${column}`])
      );
    }
  });

  it("retains worksheet, physical-row and column limits with buffered loading", async () => {
    const sheets = new ExcelJS.Workbook();
    for (let i = 0; i <= LIMITS.sheets; i++) sheets.addWorksheet(`Sheet ${i}`).addRow(["SKU"]);
    await expect(rows(new Uint8Array(await sheets.xlsx.writeBuffer()), "sheets.xlsx")).rejects.toThrow(/100 sheets/);
    const wide = new ExcelJS.Workbook(); wide.addWorksheet("Wide").getRow(1).values = Array(LIMITS.columns + 1).fill("Header");
    await expect(rows(new Uint8Array(await wide.xlsx.writeBuffer()), "wide.xlsx")).rejects.toThrow(/256 columns/);
    const sparse = new ExcelJS.Workbook(); sparse.addWorksheet("Sparse").getCell(`A${LIMITS.physicalRows + 1}`).value = "SKU";
    await expect(rows(new Uint8Array(await sparse.xlsx.writeBuffer()), "sparse.xlsx")).rejects.toThrow(/physical row/);
  });

  it("enforces the record limit across sheets", async () => {
    const book = new ExcelJS.Workbook();
    for (const name of ["First", "Second"]) {
      const sheet = book.addWorksheet(name); sheet.addRow(["SKU"]);
      for (let i = 0; i < (name === "First" ? 5000 : 5001); i++) sheet.addRow(["001"]);
    }
    await expect(rows(new Uint8Array(await book.xlsx.writeBuffer()), "supplier.xlsx")).rejects.toThrow(/10,000/);
  });

  it("rejects corrupt and excessive declared-expansion archives", async () => {
    await expect(rows(Buffer.from("PK\x03\x04not a workbook"), "bad.xlsx")).rejects.toThrow(/directory/);
    const book = new ExcelJS.Workbook(); book.addWorksheet("Sheet").addRow(["SKU"]);
    const bytes = Buffer.from(await book.xlsx.writeBuffer());
    const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 1, 2]));
    bytes.writeUInt32LE(0xffffffff, central + 24);
    await expect(rows(bytes, "large.xlsx")).rejects.toThrow(/expansion limit/);
  });
});

it("validates file type/size/content and each ordered cell structure", () => {
  expect(() => validateFile(Buffer.from("a"), "file.exe")).toThrow(/CSV or XLSX/);
  expect(() => validateFile(Buffer.alloc(LIMITS.fileBytes + 1), "file.csv")).toThrow(/10 MiB/);
  expect(() => validateFile(Buffer.from("not a ZIP"), "file.xlsx")).toThrow(/XLSX/);
  expect(() => validateFile(Buffer.from([0]), "file.csv")).toThrow(/binary/);
  expect(parsedRowSchema.safeParse({ sheetIndex: 0, sheetName: "CSV", rowNumber: 2, rawCells: [{ header: "SKU", value: "001" }], issues: [] }).success).toBe(false);
});
