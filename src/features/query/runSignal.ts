// Fast client-side guidance shown before the authoritative backend classifier runs.
// These signals never grant execution; they only explain obvious risk shapes early.

import type { SafetySettings } from "../../ipc/types";
import type { I18nKey } from "../../lib/i18n";
import type { WorkspaceCredentialMode } from "../connections/domain";

export interface RunSignal {
  tone: "muted" | "warning" | "danger";
  text: string;
  title?: string;
  icon?: "alert" | "info";
}

type Translate = (
  key: I18nKey,
  vars?: Record<string, string | number>,
) => string;

function compactSql(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function likelyMutates(sql: string): boolean {
  return /^(insert|update|delete|merge|replace|create|alter|drop|truncate|grant|revoke|vacuum|analyze|call|execute)\b/i.test(
    compactSql(sql),
  );
}

function likelyRead(sql: string): boolean {
  return /^(select|with|show|describe|desc|explain)\b/i.test(compactSql(sql));
}

function lacksWhereOnBulkMutation(sql: string): boolean {
  const compact = compactSql(sql);
  return /^(update|delete)\b/i.test(compact) && !/\bwhere\b/i.test(compact);
}

function likelyHeavyRead(sql: string): boolean {
  const compact = compactSql(sql);
  return likelyRead(compact) && /\b(cross\s+join|generate_series)\b/i.test(compact);
}

function likelyUnboundedRead(sql: string): boolean {
  const compact = compactSql(sql);
  return likelyRead(compact) && !/\blimit\s+\d+\b/i.test(compact);
}

export function buildRunSignal(
  sql: string,
  statements: string[],
  safety: SafetySettings,
  t: Translate,
  credentialMode: WorkspaceCredentialMode = "local",
): RunSignal | null {
  if (!sql.trim()) return null;
  const effectiveStatements = statements.length > 0 ? statements : [sql];
  const writes = effectiveStatements.some(likelyMutates);
  const sharedReadOnly = credentialMode !== "local";

  if (effectiveStatements.length > 1) {
    if (writes && (sharedReadOnly || !safety.allowWrites)) {
      return {
        tone: "danger",
        icon: "alert",
        text: t(
          sharedReadOnly
            ? "sql.signalSharedReadOnly"
            : "sql.signalWritesDisabled",
        ),
        title: t(
          sharedReadOnly
            ? "sql.sharedWritesUnavailable"
            : "sql.writesDisabledScript",
        ),
      };
    }
    if (effectiveStatements.length >= 12) {
      return {
        tone: "warning",
        icon: "alert",
        text: t("sql.signalLargeScript", { count: effectiveStatements.length }),
        title: t("sql.scriptNote"),
      };
    }
    if (writes) {
      return {
        tone: "warning",
        icon: "alert",
        text: t("sql.signalWriteScript"),
        title: t("sql.scriptNote"),
      };
    }
    return {
      tone: "muted",
      icon: "info",
      text: t("sql.signalReadScript", { count: effectiveStatements.length }),
    };
  }

  const statement = effectiveStatements[0] ?? sql;
  if (lacksWhereOnBulkMutation(statement)) {
    return {
      tone: "warning",
      icon: "alert",
      text: t("sql.signalNoWhere"),
    };
  }
  if (/^explain\s+analyze\b/i.test(compactSql(statement))) {
    return {
      tone: "warning",
      icon: "alert",
      text: t("sql.signalExplainAnalyze"),
    };
  }
  if (likelyMutates(statement)) {
    if (sharedReadOnly || !safety.allowWrites) {
      return {
        tone: "danger",
        icon: "alert",
        text: t(
          sharedReadOnly
            ? "sql.signalSharedReadOnly"
            : "sql.signalWritesDisabled",
        ),
        ...(sharedReadOnly
          ? { title: t("sql.sharedWritesUnavailable") }
          : {}),
      };
    }
    return {
      tone: "warning",
      icon: "alert",
      text: t("sql.signalWriteStatement"),
    };
  }
  if (likelyHeavyRead(statement)) {
    return {
      tone: "warning",
      icon: "alert",
      text: t("sql.signalHeavyRead"),
    };
  }
  if (likelyUnboundedRead(statement)) {
    return {
      tone: "muted",
      icon: "info",
      text: t("sql.signalReadCap", { count: safety.maxRows }),
    };
  }
  return null;
}
