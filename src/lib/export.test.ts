import { describe, expect, it } from "vitest";
import { csvChunks, jsonChunks, tsvChunks } from "./export";
import { toCsv } from "./sqlBuild";

async function collect(chunks: AsyncIterable<string>) {
  const output: string[] = [];
  for await (const chunk of chunks) output.push(chunk);
  return output;
}

describe("chunked result export", () => {
  it("streams CSV, JSON, and TSV in bounded pieces without flattening rows", async () => {
    const rows = Array.from(
      { length: 10_000 },
      (_, index) => [index, `row-${index}`] as const,
    );
    const csv = await collect(csvChunks(["id", "name"], rows));
    const json = await collect(jsonChunks(["id", "name"], rows));
    const tsv = await collect(tsvChunks(["id", "name"], rows));
    expect(csv.length).toBeGreaterThan(1);
    expect(json.length).toBeGreaterThan(2);
    expect(tsv.length).toBeGreaterThan(1);
    expect(csv[0]).toContain("id,name");
    expect(json[0]).toBe("[");
    expect(json[json.length - 1]).toBe("]");
  });

  it("matches materialized CSV escaping for CR/LF, quotes, Unicode, nulls, and objects", async () => {
    const columns = ["plain", "quoted", "object"];
    const rows = [
      [null, "a\r\nb,\"c\"", { korean: "한글", emoji: "🧪" }],
      ["unicode", "line\rbreak", undefined],
    ];
    expect((await collect(csvChunks(columns, rows))).join(""))
      .toBe(`\uFEFF${toCsv(columns, rows)}`);
    expect((await collect(csvChunks(columns, []))).join(""))
      .toBe(`\uFEFF${toCsv(columns, [])}`);
  });
});
