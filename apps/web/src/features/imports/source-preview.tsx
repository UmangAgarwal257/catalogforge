import { Fragment } from "react";
import type { ImportDetails } from "@catalogforge/ingestion/api-contracts";

function CellValue({ value }: { value: unknown }) {
  const text = value === null ? "null" : typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "null";
  if (text.length <= 160) return <span className="whitespace-pre-wrap break-words">{text === "" ? <span className="text-muted-foreground">(empty text)</span> : text}</span>;
  return <details>
    <summary className="min-h-11 cursor-pointer py-2 focus-visible:outline-2 focus-visible:outline-ring">{text.slice(0, 100)}… <span className="font-medium underline">Show full value</span></summary>
    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3 font-mono text-xs" tabIndex={0} aria-label="Complete original cell value">{text}</pre>
  </details>;
}

export function SourcePreview({ rows }: { rows: ImportDetails["rows"] }) {
  const sheets = [...new Set(rows.map((row) => row.sheetIndex))];
  return <div className="space-y-6">{sheets.map((index) => {
    const sheetRows = rows.filter((row) => row.sheetIndex === index);
    const width = Math.max(0, ...sheetRows.map((row) => row.rawCells.length));
    return <section key={index} aria-label={`Sheet ${index + 1}: ${sheetRows[0]?.sheetName}`}>
      <h3 className="mb-2 text-sm font-semibold">{sheetRows[0]?.sheetName} <span className="font-normal text-muted-foreground">· sheet index {index}</span></h3>
      <div className="max-h-[32rem] overflow-auto rounded-lg border focus-visible:outline-2 focus-visible:outline-ring" tabIndex={0} role="region" aria-label={`Original cells in sheet ${index + 1}`}>
        <table className="w-full border-collapse text-left text-sm">
          <caption className="sr-only">Original supplier records. Row numbers are physical coordinates; columns retain their original positions.</caption>
          <thead className="sticky top-0 bg-muted"><tr><th scope="col" className="whitespace-nowrap p-3">Source row</th>{Array.from({ length: width }, (_, column) => {
            const header = sheetRows.map((row) => row.rawCells.find((cell) => cell.columnIndex === column)?.header).find((value) => value !== undefined);
            return <th key={column} scope="col" className="min-w-48 max-w-80 p-3"><CellValue value={header ?? "(no header)"} /><span className="block text-xs font-normal text-foreground/80">Column {column + 1}</span></th>;
          })}</tr></thead>
          <tbody>{sheetRows.map((row) => <Fragment key={row.id}>
            <tr className="border-t align-top"><th scope="row" className="p-3 font-mono font-normal">{row.rowNumber}<span className="mt-1 block font-sans text-xs text-muted-foreground">{row.status}</span></th>{Array.from({ length: width }, (_, column) => {
              const cell = row.rawCells.find((value) => value.columnIndex === column);
              return <td key={column} className="min-w-48 max-w-80 p-3">{cell ? <><CellValue value={cell.value} />{cell.metadata && Object.keys(cell.metadata).length > 0 && <details className="mt-2 text-xs text-muted-foreground"><summary className="min-h-11 cursor-pointer py-2 focus-visible:outline-2 focus-visible:outline-ring">Cell metadata</summary><pre className="max-h-40 overflow-auto whitespace-pre-wrap text-foreground">{JSON.stringify(cell.metadata, null, 2)}</pre></details>}</> : <span className="text-muted-foreground">No cell</span>}</td>;
            })}</tr>
            {row.issues.length > 0 && <tr className="border-t"><td colSpan={width + 1} className="p-3"><details><summary className="min-h-11 cursor-pointer py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring">Source row {row.rowNumber}: {row.issues.length} parsing issue(s)</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(row.issues, null, 2)}</pre></details></td></tr>}
          </Fragment>)}</tbody>
        </table>
      </div>
    </section>;
  })}</div>;
}
