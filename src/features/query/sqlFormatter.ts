import type { SqlLanguage } from "sql-formatter";

export type SqlFormatRequest = {
  requestId: number;
  sql: string;
  language: SqlLanguage;
};

export type SqlFormatResponse =
  | { requestId: number; formatted: string; error: null }
  | { requestId: number; formatted: null; error: string };

type PendingFormat = {
  resolve: (formatted: string) => void;
  reject: (error: Error) => void;
};

let formatterWorker: Worker | null = null;
let requestSequence = 0;
const pendingFormats = new Map<number, PendingFormat>();
const LARGE_DOCUMENT_BYTES = 128 * 1024;
const FORMAT_CHUNK_BYTES = 64 * 1024;

function stopFormatterWorker(message: string) {
  formatterWorker?.terminate();
  formatterWorker = null;
  const error = new Error(message);
  for (const pending of pendingFormats.values()) pending.reject(error);
  pendingFormats.clear();
}

function getFormatterWorker() {
  if (formatterWorker) return formatterWorker;
  if (typeof Worker === "undefined") return null;
  const worker = new Worker(new URL("./sqlFormatter.worker.ts", import.meta.url), {
    type: "module",
  });
  worker.onmessage = (event: MessageEvent<SqlFormatResponse>) => {
    const pending = pendingFormats.get(event.data.requestId);
    if (!pending) return;
    pendingFormats.delete(event.data.requestId);
    if (event.data.error !== null) pending.reject(new Error(event.data.error));
    else pending.resolve(event.data.formatted);
  };
  worker.onerror = () => stopFormatterWorker("SQL formatter worker failed");
  worker.onmessageerror = () =>
    stopFormatterWorker("SQL formatter worker returned an invalid response");
  formatterWorker = worker;
  return worker;
}

function hasCompoundStatement(sql: string, language: SqlLanguage) {
  if (language === "mysql") {
    return /^\s*delimiter\b/im.test(sql)
      || /\bcreate\s+(?:definer\s*=\s*\S+\s+)?(?:procedure|function|trigger|event)\b/i.test(
        sql,
      );
  }
  if (language === "sqlite") return /\bcreate\s+trigger\b/i.test(sql);
  return false;
}

/**
 * Split only at top-level statement terminators. Large formatter requests are
 * handled by short-lived workers per bounded chunk so parser scratch memory is
 * released instead of becoming a multi-gigabyte resident worker. Compound
 * MySQL/SQLite statements stay on the conservative single-worker path.
 */
export function splitSqlFormatChunks(
  sql: string,
  language: SqlLanguage,
): string[] {
  if (sql.length < LARGE_DOCUMENT_BYTES || hasCompoundStatement(sql, language)) {
    return [sql];
  }
  const chunks: string[] = [];
  let start = 0;
  let quote: "single" | "double" | "backtick" | null = null;
  let lineComment = false;
  let blockComment = false;
  let dollarTag: string | null = null;
  for (let index = 0; index < sql.length; index += 1) {
    const current = sql[index];
    const next = sql[index + 1] ?? "";
    if (lineComment) {
      if (current === "\n" || current === "\r") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (current === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (dollarTag !== null) {
      if (sql.startsWith(dollarTag, index)) {
        index += dollarTag.length - 1;
        dollarTag = null;
      }
      continue;
    }
    if (quote !== null) {
      const marker = quote === "single" ? "'" : quote === "double" ? '"' : "`";
      if (current === "\\") {
        index += 1;
      } else if (current === marker && next === marker) {
        index += 1;
      } else if (current === marker) {
        quote = null;
      }
      continue;
    }
    if ((current === "-" && next === "-") || current === "#") {
      lineComment = true;
      if (current === "-") index += 1;
      continue;
    }
    if (current === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (current === "'") quote = "single";
    else if (current === '"') quote = "double";
    else if (current === "`") quote = "backtick";
    else if (current === "$" && language === "postgresql") {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index));
      if (tag) {
        dollarTag = tag[0];
        index += tag[0].length - 1;
      }
    } else if (current === ";" && index + 1 - start >= FORMAT_CHUNK_BYTES) {
      chunks.push(sql.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (start < sql.length) chunks.push(sql.slice(start));
  return chunks.length > 1 ? chunks : [sql];
}

function formatWithDedicatedWorker(sql: string, language: SqlLanguage) {
  return new Promise<string>((resolve, reject) => {
    const worker = new Worker(new URL("./sqlFormatter.worker.ts", import.meta.url), {
      type: "module",
    });
    const requestId = ++requestSequence;
    const stop = () => worker.terminate();
    worker.onmessage = (event: MessageEvent<SqlFormatResponse>) => {
      if (event.data.requestId !== requestId) return;
      stop();
      if (event.data.error !== null) reject(new Error(event.data.error));
      else resolve(event.data.formatted);
    };
    worker.onerror = () => {
      stop();
      reject(new Error("SQL formatter worker failed"));
    };
    worker.onmessageerror = () => {
      stop();
      reject(new Error("SQL formatter worker returned an invalid response"));
    };
    try {
      worker.postMessage({ requestId, sql, language } satisfies SqlFormatRequest);
    } catch (error) {
      stop();
      reject(
        error instanceof Error
          ? error
          : new Error("SQL formatter request could not be sent"),
      );
    }
  });
}

export async function formatSqlDocument(
  sql: string,
  language: SqlLanguage,
): Promise<string> {
  const chunks = splitSqlFormatChunks(sql, language);
  if (chunks.length > 1 && typeof Worker !== "undefined") {
    const formatted: string[] = [];
    for (const chunk of chunks) {
      formatted.push(await formatWithDedicatedWorker(chunk, language));
    }
    return formatted.join("\n\n");
  }
  const worker = getFormatterWorker();
  if (!worker) {
    const formatter = await import("sql-formatter");
    return formatter.format(sql, {
      language,
      keywordCase: "upper",
      tabWidth: 2,
      linesBetweenQueries: 2,
    });
  }
  const requestId = ++requestSequence;
  const request: SqlFormatRequest = { requestId, sql, language };
  return new Promise((resolve, reject) => {
    pendingFormats.set(requestId, { resolve, reject });
    try {
      worker.postMessage(request);
    } catch (error) {
      pendingFormats.delete(requestId);
      reject(
        error instanceof Error
          ? error
          : new Error("SQL formatter request could not be sent"),
      );
    }
  });
}
