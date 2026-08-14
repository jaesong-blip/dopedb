// Closed, lossy mappings for product analytics call sites. Helpers consume
// potentially sensitive runtime inputs and return only the bounded enums or
// UUID context accepted by the analytics domain.
import type {
  ConnectionEngine,
  WorkspaceCredentialMode,
} from "../connections/domain";
import type { CatalogScope } from "../../lib/queries";
import type {
  ProductAnalyticsDurationBucket,
  ProductAnalyticsEngine,
  ProductAnalyticsWorkspaceContextInput,
  ProductEventPropertiesByName,
} from "./domain";
import { isProductAnalyticsUuid } from "./domain";

type RowCountBucket = ProductEventPropertiesByName["query_execution_completed"]["rowCountBucket"];
type StatementClass = ProductEventPropertiesByName["query_execution_completed"]["statementClass"];
type AccessMode = ProductEventPropertiesByName["environment_connection_bound"]["accessMode"];
type CredentialMode = ProductEventPropertiesByName["connection_verification_completed"]["credentialMode"];

const WRITE_KEYWORDS = new Set([
  "ALTER",
  "ANALYZE",
  "ATTACH",
  "BEGIN",
  "CALL",
  "COMMENT",
  "COMMIT",
  "COPY",
  "CREATE",
  "DELETE",
  "DETACH",
  "DO",
  "DROP",
  "EXEC",
  "EXECUTE",
  "GRANT",
  "INSERT",
  "LOCK",
  "MERGE",
  "RELEASE",
  "RENAME",
  "REPLACE",
  "RESET",
  "REVOKE",
  "ROLLBACK",
  "SAVEPOINT",
  "SET",
  "TRUNCATE",
  "UNLOCK",
  "UPDATE",
  "UPSERT",
  "USE",
  "VACUUM",
]);

const WITH_TERMINAL_KEYWORDS = new Set([
  "DELETE",
  "INSERT",
  "MERGE",
  "REPLACE",
  "SELECT",
  "UPDATE",
]);

function asciiIdentifierStart(value: string | undefined) {
  return value !== undefined && /[A-Za-z_]/.test(value);
}

function asciiIdentifierPart(value: string | undefined) {
  return value !== undefined && /[A-Za-z0-9_$]/.test(value);
}

function dollarQuoteTag(sql: string, start: number) {
  if (sql[start] !== "$") return null;
  if (sql[start + 1] === "$") return "$$";
  if (!asciiIdentifierStart(sql[start + 1])) return null;
  let end = start + 2;
  while (/[A-Za-z0-9_]/.test(sql[end] ?? "")) end += 1;
  return sql[end] === "$" ? sql.slice(start, end + 1) : null;
}

function skipQuoted(sql: string, start: number, quote: string) {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === "\\") {
      index += 2;
      continue;
    }
    if (sql[index] !== quote) {
      index += 1;
      continue;
    }
    if (sql[index + 1] === quote) {
      index += 2;
      continue;
    }
    return index + 1;
  }
  return sql.length;
}

function scanStatementShape(sql: string) {
  let index = 0;
  let statementCount = 0;
  let statementHasCode = false;
  let parenthesisDepth = 0;
  let firstKeyword: string | null = null;
  let withTerminalKeyword: string | null = null;
  let withContainsWrite = false;

  function finishStatement() {
    if (statementHasCode) statementCount += 1;
    statementHasCode = false;
    parenthesisDepth = 0;
  }

  while (index < sql.length) {
    const char = sql[index];
    if (/\s|\uFEFF/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "-" && sql[index + 1] === "-") {
      const end = sql.indexOf("\n", index + 2);
      index = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (char === "#") {
      const end = sql.indexOf("\n", index + 1);
      index = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (char === "/" && sql[index + 1] === "*") {
      let depth = 1;
      index += 2;
      while (index < sql.length && depth > 0) {
        if (sql[index] === "/" && sql[index + 1] === "*") {
          depth += 1;
          index += 2;
        } else if (sql[index] === "*" && sql[index + 1] === "/") {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      statementHasCode = true;
      index = skipQuoted(sql, index, char);
      continue;
    }
    if (char === "[") {
      statementHasCode = true;
      index += 1;
      while (index < sql.length) {
        if (sql[index] !== "]") {
          index += 1;
          continue;
        }
        if (sql[index + 1] === "]") {
          index += 2;
          continue;
        }
        index += 1;
        break;
      }
      continue;
    }
    if (char === "$") {
      const tag = dollarQuoteTag(sql, index);
      if (tag) {
        statementHasCode = true;
        const end = sql.indexOf(tag, index + tag.length);
        index = end < 0 ? sql.length : end + tag.length;
        continue;
      }
    }
    if (char === ";") {
      finishStatement();
      index += 1;
      continue;
    }
    if (char === "(") {
      statementHasCode = true;
      parenthesisDepth += 1;
      index += 1;
      continue;
    }
    if (char === ")") {
      statementHasCode = true;
      parenthesisDepth = Math.max(0, parenthesisDepth - 1);
      index += 1;
      continue;
    }
    if (asciiIdentifierStart(char)) {
      const start = index;
      index += 1;
      while (asciiIdentifierPart(sql[index])) index += 1;
      statementHasCode = true;
      if (statementCount === 0) {
        const keyword = sql.slice(start, index).toUpperCase();
        if (firstKeyword === null) {
          firstKeyword = keyword;
        } else if (firstKeyword === "WITH") {
          if (WRITE_KEYWORDS.has(keyword)) withContainsWrite = true;
          if (
            parenthesisDepth === 0 &&
            withTerminalKeyword === null &&
            WITH_TERMINAL_KEYWORDS.has(keyword)
          ) {
            withTerminalKeyword = keyword;
          }
        }
      }
      continue;
    }
    statementHasCode = true;
    index += 1;
  }
  finishStatement();
  return {
    statementCount,
    firstKeyword,
    withContainsWrite,
    withTerminalKeyword,
  };
}

export function productAnalyticsWorkspaceContext(
  scope: CatalogScope,
): ProductAnalyticsWorkspaceContextInput | null {
  if (
    !scope.ready ||
    scope.error !== undefined ||
    scope.workspaceId === null ||
    !isProductAnalyticsUuid(scope.workspaceId)
  ) {
    return null;
  }
  if (scope.workspaceKind === "personal") {
    return { workspaceId: scope.workspaceId, workspaceKind: "personal" };
  }
  if (
    scope.workspaceKind !== "team" ||
    scope.accountScope === null ||
    !isProductAnalyticsUuid(scope.accountScope)
  ) {
    return null;
  }
  return {
    workspaceId: scope.workspaceId,
    workspaceKind: "team",
    actorId: scope.accountScope,
  };
}

export function productAnalyticsDurationBucket(
  durationMs: number | null | undefined,
): ProductAnalyticsDurationBucket {
  if (
    typeof durationMs !== "number" ||
    !Number.isFinite(durationMs) ||
    durationMs < 0
  ) {
    return "unknown";
  }
  if (durationMs < 100) return "under_100ms";
  if (durationMs < 1_000) return "100ms_1s";
  if (durationMs < 10_000) return "1s_10s";
  if (durationMs < 60_000) return "10s_60s";
  return "over_60s";
}

export function productAnalyticsRowCountBucket(
  rowCount: number | bigint | null | undefined,
): RowCountBucket {
  if (typeof rowCount === "number") {
    if (!Number.isSafeInteger(rowCount) || rowCount < 0) return "unknown";
  } else if (typeof rowCount === "bigint") {
    if (rowCount < 0n) return "unknown";
  } else {
    return "unknown";
  }
  if (rowCount === 0 || rowCount === 0n) return "zero";
  if (rowCount === 1 || rowCount === 1n) return "one";
  if (rowCount <= 10) return "2_10";
  if (rowCount <= 100) return "11_100";
  if (rowCount <= 1_000) return "101_1000";
  return "over_1000";
}

export function productAnalyticsStatementClass(sql: string): StatementClass {
  const shape = scanStatementShape(sql);
  if (shape.statementCount > 1) return "script";
  if (shape.firstKeyword === "WITH") {
    if (shape.withContainsWrite) return "write";
    if (shape.withTerminalKeyword === "SELECT") return "select";
    return "other_read";
  }
  if (shape.firstKeyword === "SELECT") return "select";
  if (shape.firstKeyword === "EXPLAIN") return "explain";
  if (shape.firstKeyword === "SHOW") return "show";
  return shape.firstKeyword !== null && WRITE_KEYWORDS.has(shape.firstKeyword)
    ? "write"
    : "other_read";
}

export function productAnalyticsConnectionEngine(
  engine: ConnectionEngine,
): ProductAnalyticsEngine {
  return engine;
}

export function productAnalyticsAccessMode(
  credentialMode: WorkspaceCredentialMode,
): AccessMode {
  return credentialMode === "managed" ? "managed" : "local";
}

export function productAnalyticsCredentialMode(
  credentialMode: WorkspaceCredentialMode | null | undefined,
): CredentialMode {
  if (credentialMode === null || credentialMode === undefined) return "none";
  return credentialMode === "managed" ? "managed" : "local";
}
