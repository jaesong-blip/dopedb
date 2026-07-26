// Shared result-export helpers. CSV/JSON shaping lives in sqlBuild (pure, tested);
// this file owns the browser side: clipboard text and file downloads.
import { toCsv, toJson } from "./sqlBuild";

function download(name: string, text: string, mime: string) {
  downloadBlob(name, new Blob([text], { type: mime }));
}

function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

function csvCell(value: unknown): string {
  const text = cellText(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// Browser downloads end as a retained Blob snapshot. Serialization stays
// chunked, but the file is not falsely described as a streaming sink.
async function terminalSnapshotBlobFromChunks(
  chunks: AsyncIterable<string>,
  mime: string,
): Promise<Blob> {
  const parts: BlobPart[] = [];
  for await (const chunk of chunks) parts.push(chunk);
  return new Blob(parts, { type: mime });
}

export async function* tsvChunks(
  columns: readonly string[],
  rows: Iterable<readonly unknown[]>,
): AsyncGenerator<string> {
  yield `${columns.join("\t")}\n`;
  let buffer = "";
  for (const row of rows) {
    buffer += `${row.map(cellText).join("\t")}\n`;
    if (buffer.length >= 64 * 1024) {
      yield buffer;
      buffer = "";
    }
  }
  if (buffer) yield buffer;
}

export async function* csvChunks(
  columns: readonly string[],
  rows: Iterable<readonly unknown[]>,
): AsyncGenerator<string> {
  yield `\uFEFF${columns.map(csvCell).join(",")}`;
  let buffer = "";
  for (const row of rows) {
    buffer += "\n";
    buffer += row.map(csvCell).join(",");
    if (buffer.length >= 64 * 1024) {
      yield buffer;
      buffer = "";
    }
  }
  if (buffer) yield buffer;
}

export async function* jsonChunks(
  columns: readonly string[],
  rows: Iterable<readonly unknown[]>,
): AsyncGenerator<string> {
  yield "[";
  let first = true;
  let buffer = "";
  for (const row of rows) {
    const object = Object.fromEntries(
      columns.map((column, index) => [column, row[index] ?? null]),
    );
    buffer += `${first ? "" : ","}${JSON.stringify(object)}`;
    first = false;
    if (buffer.length >= 64 * 1024) {
      yield buffer;
      buffer = "";
    }
  }
  if (buffer) yield buffer;
  yield "]";
}

export async function downloadCsvTerminalSnapshot(
  base: string,
  columns: readonly string[],
  rows: Iterable<readonly unknown[]>,
) {
  downloadBlob(
    `${base}.csv`,
    await terminalSnapshotBlobFromChunks(csvChunks(columns, rows), "text/csv"),
  );
}

export async function downloadJsonTerminalSnapshot(
  base: string,
  columns: readonly string[],
  rows: Iterable<readonly unknown[]>,
) {
  downloadBlob(
    `${base}.json`,
    await terminalSnapshotBlobFromChunks(
      jsonChunks(columns, rows),
      "application/json",
    ),
  );
}

export async function copyTsvTerminalSnapshot(
  columns: readonly string[],
  rows: Iterable<readonly unknown[]>,
) {
  const blob = await terminalSnapshotBlobFromChunks(
    tsvChunks(columns, rows),
    "text/plain",
  );
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard.write) {
    await navigator.clipboard.write([
      new ClipboardItem({ "text/plain": blob }),
    ]);
    return;
  }
  throw new Error("terminal snapshot clipboard export is unavailable in this WebView");
}

// UTF-8 BOM so Excel opens non-ASCII (e.g. Korean) CSV correctly.
export function downloadCsv(
  base: string,
  columns: string[],
  rows: unknown[][],
) {
  download(`${base}.csv`, "\uFEFF" + toCsv(columns, rows), "text/csv");
}

export function downloadJson(
  base: string,
  columns: string[],
  rows: unknown[][],
) {
  // Pretty-print small exports; skip the 2-space indent past 5000 rows so the JSON string
  // is ~half the size and stringify runs ~2x faster on the main thread. toJson stays the
  // pretty path (its self-test pins that output); large path shapes rows inline & compact.
  const text =
    rows.length > 5000
      ? JSON.stringify(
          rows.map((r) =>
            Object.fromEntries(columns.map((c, i) => [c, r[i] ?? null])),
          ),
        )
      : toJson(columns, rows);
  download(`${base}.json`, text, "application/json");
}

// Tab-separated text for pasting into spreadsheets.
export function toTsv(columns: string[], rows: unknown[][]): string {
  return [columns, ...rows].map((r) => r.map(cellText).join("\t")).join("\n");
}

// Filename-safe local timestamp, e.g. 2026-07-03-14-05-09.
export function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}
