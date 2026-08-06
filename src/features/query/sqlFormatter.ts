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

export async function formatSqlDocument(
  sql: string,
  language: SqlLanguage,
): Promise<string> {
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
