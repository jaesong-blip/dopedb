// Shared typed wrappers around Tauri `invoke`. Migrated vertical slices keep their
// adapter beside the feature; remaining names match src-tauri/src/commands/mod.rs.
// Argument keys always match the Rust parameter names.

import { invoke } from "@tauri-apps/api/core";
import type {
  AuditSnapshot,
  Catalog,
  CatalogOverview,
  CatalogSnapshot,
  CliInstallReceipt,
  CliInstallationStatus,
  DocumentPage,
  DocumentOperationProposal,
  DocumentQuery,
  HistoryEntry,
  LegacyMcpCleanupExpectation,
  LegacyMcpCleanupReceipt,
  LegacyMcpCleanupStatus,
  MonitoringOperationProposal,
  MonitoringStatus,
  OperationDecision,
  ScriptOutcome,
  SafetySettings,
  ScriptOperationProposal,
  SkillMutationReceipt,
  SkillSelfTestReceipt,
  SkillStatus,
  SkillTargetExpectation,
  SkillTargetSelection,
} from "./types";

export function cliInstallationStatus(): Promise<CliInstallationStatus> {
  return invoke("cli_installation_status");
}

export function installCli(
  updatePath: boolean,
  replaceExisting: boolean,
): Promise<CliInstallReceipt> {
  return invoke("install_cli", { updatePath, replaceExisting });
}

export function skillStatus(target: SkillTargetSelection): Promise<SkillStatus> {
  return invoke("skill_status", { target });
}

export function repairSkill(
  target: SkillTargetSelection,
  expected: SkillTargetExpectation[],
): Promise<SkillMutationReceipt> {
  return invoke("repair_skill", { target, expected });
}

export function removeSkill(
  target: SkillTargetSelection,
  expected: SkillTargetExpectation[],
): Promise<SkillMutationReceipt> {
  return invoke("remove_skill", { target, expected });
}

export function skillSelfTest(): Promise<SkillSelfTestReceipt> {
  return invoke("skill_self_test");
}

export function legacyMcpCleanupStatus(): Promise<LegacyMcpCleanupStatus> {
  return invoke("legacy_mcp_cleanup_status");
}

export function legacyMcpCleanupApply(
  expectations: LegacyMcpCleanupExpectation[],
): Promise<LegacyMcpCleanupReceipt> {
  return invoke("legacy_mcp_cleanup_apply", { expectations });
}

function getSchema(id: string): Promise<string> {
  return invoke("get_schema", { id });
}

// Introspected schema, parsed. Backend returns the Catalog as a JSON string.
export async function getCatalog(id: string): Promise<Catalog> {
  return JSON.parse(await getSchema(id)) as Catalog;
}

// Force a live re-introspection (bypasses the one-shot schema cache) and return it.
export async function refreshCatalog(id: string): Promise<Catalog> {
  return JSON.parse(await invoke<string>("refresh_schema", { id })) as Catalog;
}

export function getCatalogSnapshot(id: string): Promise<CatalogSnapshot> {
  return invoke("get_catalog_snapshot", { id });
}

// Complete relation tree only. Detailed catalog metadata remains deferred server-side.
export function getCatalogOverview(id: string): Promise<CatalogOverview> {
  return invoke("get_catalog_overview", { id });
}

// The CREATE-TABLE DDL for one table (MySQL/SQLite native; Postgres synthesized).
export function getTableDdl(
  id: string,
  table: string,
  schema?: string | null,
): Promise<string> {
  return invoke("get_table_ddl", { id, schema: schema ?? null, table });
}

export function approveOperation(
  operationId: string,
  payloadHash: string,
  reason?: string,
): Promise<OperationDecision> {
  return invoke("approve_operation", {
    operationId,
    payloadHash,
    reason: reason ?? null,
  });
}

export function rejectOperation(
  operationId: string,
  payloadHash: string,
  reason?: string,
): Promise<OperationDecision> {
  return invoke("reject_operation", {
    operationId,
    payloadHash,
    reason: reason ?? null,
  });
}

// Run one typed, read-only document query on a MongoDB connection. Aggregate
// write stages are rejected backend-side; there is no document write path.
export function runDocumentQuery(
  operationId: string,
): Promise<DocumentPage> {
  return invoke("run_document_query", { operationId });
}

export function proposeDocumentQuery(
  id: string,
  query: DocumentQuery,
  origin?: string,
): Promise<DocumentOperationProposal> {
  return invoke("propose_document_query", {
    id,
    query,
    origin: origin ?? null,
  });
}

export async function runDocumentRead(
  id: string,
  query: DocumentQuery,
  origin?: string,
): Promise<DocumentPage> {
  const proposal = await proposeDocumentQuery(id, query, origin);
  return runDocumentQuery(proposal.operationId);
}

// Cancel an in-flight operation by its operation id.
export function cancelQuery(queryId: string): Promise<boolean> {
  return invoke("cancel_query", { queryId });
}

// Consume a persisted script operation. Mutating proposals must already carry their
// exact approval and execute in one backend transaction.
export function runScript(
  operationId: string,
): Promise<ScriptOutcome> {
  return invoke("run_script", { operationId });
}

export function proposeScript(
  id: string,
  sql: string,
  origin?: string,
  namespace?: string,
): Promise<ScriptOperationProposal> {
  return invoke("propose_script", {
    id,
    sql,
    namespace: namespace ?? null,
    origin: origin ?? null,
  });
}

export function proposeTableChanges(
  id: string,
  statements: string[],
  catalogFingerprint: string,
): Promise<ScriptOperationProposal> {
  return invoke("propose_table_changes", {
    id,
    statements,
    catalogFingerprint,
  });
}

export function getSafety(id: string): Promise<SafetySettings> {
  return invoke("get_safety", { id });
}

export function setSafety(id: string, settings: SafetySettings): Promise<void> {
  return invoke("set_safety", { id, settings });
}

export function getMonitoringStatus(id: string): Promise<MonitoringStatus> {
  return invoke("get_monitoring_status", { id });
}

export function proposePostgresMonitoring(
  id: string,
  enabled: boolean,
): Promise<MonitoringOperationProposal> {
  return invoke("propose_postgres_monitoring", { id, enabled });
}

export function setPostgresMonitoring(
  operationId: string,
): Promise<MonitoringStatus> {
  return invoke("set_postgres_monitoring", { operationId });
}

// Backend hash-chain verification (rowid order + real SHA-256 recompute). Authoritative —
// a client-side link-only check can't detect an in-place field edit. firstBadIndex is the
// insertion-order (oldest-first) position of the first tampered row, or null when ok.
export function auditVerify(id: string): Promise<{ ok: boolean; firstBadIndex: number | null }> {
  return invoke("audit_verify", { connectionId: id });
}

// Rows and verdict come from one ordered backend read, so the integrity result always
// describes the exact audit entries rendered by the Activity detail panel.
export function auditSnapshot(id: string): Promise<AuditSnapshot> {
  return invoke("audit_snapshot", { connectionId: id });
}

export function listHistory(id: string): Promise<HistoryEntry[]> {
  return invoke("list_history", { id });
}

// Native picker (null = user cancelled the dialog).
export function pickFile(): Promise<string | null> {
  return invoke("pick_file");
}
