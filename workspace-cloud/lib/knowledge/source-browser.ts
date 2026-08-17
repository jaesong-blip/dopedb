export const MAX_SOURCE_BROWSE_QUERY_BYTES = 512;
export const MAX_SOURCE_BROWSE_MATCHES = 50;
export const MAX_SOURCE_BROWSE_FILE_BYTES = 1024 * 1024;
export const MAX_SOURCE_BROWSE_LINES = 400;
export const MAX_SOURCE_BROWSE_TEXT_BYTES = 128 * 1024;
export const MAX_SOURCE_BROWSE_MANIFEST_BYTES = 64 * 1024 * 1024 * 1024;

export type SourceBrowseManifestFile = {
  path: string;
  blobSha: string;
  bytes: number;
};

export function validSourceBrowseSearch(rawQuery: string, limit: number) {
  const query = rawQuery.trim();
  return query.length > 0
    && Buffer.byteLength(query, "utf8") <= MAX_SOURCE_BROWSE_QUERY_BYTES
    && !/[\u0000-\u001f\u007f-\u009f]/.test(query)
    && Number.isSafeInteger(limit)
    && limit >= 1
    && limit <= MAX_SOURCE_BROWSE_MATCHES;
}

export function validSourceBrowsePath(path: string) {
  return path.length > 0
    && path.length <= 4_096
    && !path.startsWith("/")
    && !path.includes("\\")
    && !/[\u0000-\u001f\u007f-\u009f]/.test(path)
    && path.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

export function validSourceBrowseRange(lineStart: number, lineEnd: number) {
  return Number.isSafeInteger(lineStart)
    && Number.isSafeInteger(lineEnd)
    && lineStart >= 1
    && lineEnd >= lineStart
    && lineEnd - lineStart + 1 <= MAX_SOURCE_BROWSE_LINES;
}

export function sourceBrowseMatches(
  files: ReadonlyArray<SourceBrowseManifestFile>,
  rawQuery: string,
  limit: number,
) {
  const query = rawQuery.trim().toLocaleLowerCase("en-US");
  if (!validSourceBrowseSearch(rawQuery, limit)) {
    throw new Error("Invalid source browse search");
  }
  const terms = query === "*" ? [] : query.split(/\s+/u);
  const matching = files.filter((file) => {
    const path = file.path.toLocaleLowerCase("en-US");
    return terms.every((term) => path.includes(term));
  });
  return {
    matches: matching.slice(0, limit),
    totalMatches: matching.length,
    truncated: matching.length > limit,
  };
}

export function sourceBrowseText(
  bytes: Uint8Array,
  lineStart: number,
  lineEnd: number,
) {
  if (
    bytes.byteLength > MAX_SOURCE_BROWSE_FILE_BYTES
    || !validSourceBrowseRange(lineStart, lineEnd)
  ) {
    throw new Error("Invalid source browse range");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.includes("\0")) throw new Error("Source file is not text");
  const lines = text.split(/\r?\n/u);
  const firstIndex = Math.min(lineStart - 1, lines.length);
  const lastIndex = Math.min(lineEnd, lines.length);
  const selected: string[] = [];
  let selectedBytes = 0;
  for (let index = firstIndex; index < lastIndex; index += 1) {
    const line = lines[index] ?? "";
    const lineBytes = Buffer.byteLength(line, "utf8") + (selected.length > 0 ? 1 : 0);
    if (selectedBytes + lineBytes > MAX_SOURCE_BROWSE_TEXT_BYTES) break;
    selected.push(line);
    selectedBytes += lineBytes;
  }
  const returnedLineEnd = selected.length === 0
    ? Math.min(lineStart - 1, lines.length)
    : firstIndex + selected.length;
  return {
    lineStart: firstIndex + 1,
    lineEnd: returnedLineEnd,
    totalLines: lines.length,
    truncated: returnedLineEnd < lastIndex,
    text: selected.join("\n"),
  };
}
