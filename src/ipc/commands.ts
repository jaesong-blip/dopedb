// Shared typed wrappers around Tauri `invoke`. Migrated vertical slices keep their
// adapter beside the feature; remaining names match src-tauri/src/commands/mod.rs.
// Argument keys always match the Rust parameter names.

import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  AuditSnapshot,
  Catalog,
  CatalogSnapshot,
  ChatMessageRecord,
  ChatThread,
  CliInstallReceipt,
  CliInstallationStatus,
  CliInfo,
  Classification,
  ConnectionProfile,
  Dashboard,
  DocumentPage,
  DocumentOperationProposal,
  DocumentQuery,
  DriverDescriptor,
  ErdLayout,
  ExecOutcome,
  HistoryEntry,
  CreateJobRequest,
  Job,
  JobDetail,
  JobFileCapability,
  JobFormat,
  JobInputInspection,
  JobProposal,
  LegacyMcpCleanupExpectation,
  LegacyMcpCleanupReceipt,
  LegacyMcpCleanupStatus,
  MonitoringOperationProposal,
  MonitoringStatus,
  OperationDecision,
  PlatformFeatureFlags,
  PreviewReport,
  DdlPlan,
  ScriptOutcome,
  SafetySettings,
  ScriptOperationProposal,
  SaveErdLayoutOutcome,
  SaveErdLayoutRequest,
  SchemaChangeProposal,
  SchemaChangeRequest,
  SqlOperationProposal,
  SkillMutationReceipt,
  SkillSelfTestReceipt,
  SkillStatus,
  SkillTargetExpectation,
  SkillTargetSelection,
  TerminalCreateRequest,
  TerminalFocusReceipt,
  TerminalOutputChunk,
  TerminalSessionSummary,
  TerminalSize,
  QueryResult,
  Workspace,
  WorkspaceAuthState,
  WorkspaceDeviceAuthorization,
  WorkspaceFeatureState,
  WorkspaceLoginPoll,
} from "./types";

export function terminalOutputChannel(
  onMessage: (message: TerminalOutputChunk) => void,
): Channel<TerminalOutputChunk> {
  const channel = new Channel<TerminalOutputChunk>();
  channel.onmessage = onMessage;
  return channel;
}

export function terminalCreate(
  request: TerminalCreateRequest,
  onOutput: Channel<TerminalOutputChunk>,
): Promise<TerminalSessionSummary> {
  return invoke("terminal_create", { request, onOutput });
}

export function terminalList(): Promise<TerminalSessionSummary[]> {
  return invoke("terminal_list");
}

export function terminalFocus(
  id: string,
  afterSequence: number | null,
  onOutput: Channel<TerminalOutputChunk>,
): Promise<TerminalFocusReceipt> {
  return invoke("terminal_focus", { id, afterSequence, onOutput });
}

export function terminalWrite(id: string, bytes: number[]): Promise<void> {
  return invoke("terminal_write", { id, bytes });
}

export function terminalResize(id: string, size: TerminalSize): Promise<void> {
  return invoke("terminal_resize", { id, size });
}

export function terminalKill(id: string): Promise<TerminalSessionSummary> {
  return invoke("terminal_kill", { id });
}

export function terminalRestart(
  id: string,
  onOutput: Channel<TerminalOutputChunk>,
): Promise<TerminalSessionSummary> {
  return invoke("terminal_restart", { id, onOutput });
}

export function terminalRename(
  id: string,
  name: string,
): Promise<TerminalSessionSummary> {
  return invoke("terminal_rename", { id, name });
}

export function terminalShutdownAll(): Promise<void> {
  return invoke("terminal_shutdown_all");
}

export function workspaceFeatureState(): Promise<WorkspaceFeatureState> {
  return invoke("workspace_feature_state");
}

export function platformFeatureFlags(): Promise<PlatformFeatureFlags> {
  return invoke("platform_feature_flags");
}

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

export function installSkill(
  target: SkillTargetSelection,
  expected: SkillTargetExpectation[],
): Promise<SkillMutationReceipt> {
  return invoke("install_skill", { target, expected });
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

export function workspaceAuthState(): Promise<WorkspaceAuthState> {
  return invoke("workspace_auth_state");
}

export function refreshWorkspaceAuthState(): Promise<WorkspaceAuthState> {
  return invoke("refresh_workspace_auth_state");
}

export function signOutWorkspace(userId?: string): Promise<WorkspaceAuthState> {
  return invoke("workspace_sign_out", { userId: userId ?? null });
}

export function signOutAllWorkspaces(): Promise<WorkspaceAuthState> {
  return invoke("workspace_sign_out_all");
}

export function beginWorkspaceLogin(): Promise<WorkspaceDeviceAuthorization> {
  return invoke("begin_workspace_login");
}

export function pollWorkspaceLogin(deviceCode: string): Promise<WorkspaceLoginPoll> {
  return invoke("poll_workspace_login", { deviceCode });
}

export function workspaceConsoleUrl(workspaceId?: string): Promise<string> {
  return invoke("workspace_console_url", { workspaceId: workspaceId ?? null });
}

export function listWorkspaces(): Promise<Workspace[]> {
  return invoke("list_workspaces");
}

export function refreshWorkspaceMemberships(): Promise<Workspace[]> {
  return invoke("refresh_workspace_memberships");
}

export function getActiveWorkspace(): Promise<Workspace> {
  return invoke("get_active_workspace");
}

export function setActiveWorkspace(
  id: string,
  accountUserId?: string,
): Promise<Workspace> {
  return invoke("set_active_workspace", { id, accountUserId: accountUserId ?? null });
}

export function setActiveWorkspaceAccount(userId: string): Promise<Workspace> {
  return invoke("set_active_workspace_account", { userId });
}

export function copyConnectionToWorkspace(
  connectionId: string,
  workspaceId: string,
  accountUserId: string,
): Promise<ConnectionProfile> {
  return invoke("copy_connection_to_workspace", {
    connectionId,
    workspaceId,
    accountUserId,
  });
}

export function bindWorkspaceConnectionCredentials(
  id: string,
  username: string,
  password: string,
): Promise<ConnectionProfile> {
  return invoke("bind_workspace_connection_credentials", { id, username, password });
}

export function listConnections(): Promise<ConnectionProfile[]> {
  return invoke("list_connections");
}

export function listDrivers(): Promise<DriverDescriptor[]> {
  return invoke("list_drivers");
}

export function installDriver(id: string): Promise<DriverDescriptor> {
  return invoke("install_driver", { id });
}

// NOTE(integrator): ConnectionProfile carries no plaintext secret. The optional
// `password` is passed alongside the profile so the backend can stash it in the
// OS credential store and set `secretRef`. If upsert_connection does not accept a `password`
// arg, drop it here and add a dedicated store_secret command.
export function upsertConnection(
  profile: ConnectionProfile,
  password?: string,
): Promise<ConnectionProfile> {
  return invoke("upsert_connection", { profile, password });
}

export function setConnectionsSchemaGroup(
  ids: string[],
  schemaGroup: string | null,
): Promise<ConnectionProfile[]> {
  return invoke("set_connections_schema_group", { ids, schemaGroup });
}

export function deleteConnection(id: string): Promise<void> {
  return invoke("delete_connection", { id });
}

// Reachability check for an ad-hoc (possibly unsaved) profile. Persists nothing.
export function testConnectionProfile(
  profile: ConnectionProfile,
  password?: string,
): Promise<void> {
  return invoke("test_connection_profile", { profile, password });
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

// The CREATE-TABLE DDL for one table (MySQL/SQLite native; Postgres synthesized).
export function getTableDdl(
  id: string,
  table: string,
  schema?: string | null,
): Promise<string> {
  return invoke("get_table_ddl", { id, schema: schema ?? null, table });
}

export function classifySql(id: string, sql: string): Promise<Classification> {
  return invoke("classify_sql", { id, sql });
}

export function previewSql(id: string, sql: string): Promise<PreviewReport> {
  return invoke("preview_sql", { id, sql });
}

export function proposeSql(
  id: string,
  sql: string,
  origin?: string,
): Promise<SqlOperationProposal> {
  return invoke("propose_sql", {
    id,
    sql,
    origin: origin ?? null,
  });
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

export function runSql(operationId: string): Promise<ExecOutcome> {
  return invoke("run_sql", { operationId });
}

// Plan and consume a SQL read without exposing an approval shortcut. Callers that
// may generate mutations must use the explicit proposal/approval/run sequence.
export async function runSqlRead(
  id: string,
  sql: string,
  origin?: string,
): Promise<ExecOutcome> {
  const proposal = await proposeSql(id, sql, origin);
  if (proposal.approvalRequired || proposal.classification.kind !== "read") {
    throw new Error("read execution helper rejected a target-mutating proposal");
  }
  return runSql(proposal.operationId);
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
): Promise<ScriptOperationProposal> {
  return invoke("propose_script", {
    id,
    sql,
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

export function previewSchemaChange(
  id: string,
  request: SchemaChangeRequest,
): Promise<DdlPlan> {
  return invoke("preview_schema_change", { id, request });
}

export function proposeSchemaChange(
  id: string,
  request: SchemaChangeRequest,
): Promise<SchemaChangeProposal> {
  return invoke("propose_schema_change", { id, request });
}

export function runSchemaChange(operationId: string): Promise<ScriptOutcome> {
  return invoke("run_schema_change", { operationId });
}

export function listErdLayouts(id: string): Promise<ErdLayout[]> {
  return invoke("list_erd_layouts", { id });
}

export function saveErdLayout(
  request: SaveErdLayoutRequest,
): Promise<SaveErdLayoutOutcome> {
  return invoke("save_erd_layout", { request });
}

export function deleteErdLayout(
  connectionId: string,
  id: string,
  expectedRevision: number,
): Promise<void> {
  return invoke("delete_erd_layout", {
    connectionId,
    id,
    expectedRevision,
  });
}

export function pickJobInput(
  connectionId: string,
): Promise<JobFileCapability | null> {
  return invoke("pick_job_input", { connectionId });
}

export function pickJobOutput(
  connectionId: string,
  suggestedName: string,
): Promise<JobFileCapability | null> {
  return invoke("pick_job_output", { connectionId, suggestedName });
}

export function inspectJobInput(
  connectionId: string,
  capabilityId: string,
  format: JobFormat,
): Promise<JobInputInspection> {
  return invoke("inspect_job_input", {
    connectionId,
    capabilityId,
    format,
  });
}

export function createJob(request: CreateJobRequest): Promise<JobProposal> {
  return invoke("create_job", { request });
}

export function listJobs(connectionId: string): Promise<Job[]> {
  return invoke("list_jobs", { connectionId });
}

export function getJob(
  connectionId: string,
  jobId: string,
): Promise<JobDetail> {
  return invoke("get_job", { connectionId, jobId });
}

export function startJob(connectionId: string, jobId: string): Promise<Job> {
  return invoke("start_job", { connectionId, jobId });
}

export function pauseJob(connectionId: string, jobId: string): Promise<Job> {
  return invoke("pause_job", { connectionId, jobId });
}

export function cancelJob(connectionId: string, jobId: string): Promise<Job> {
  return invoke("cancel_job", { connectionId, jobId });
}

export function revealJobArtifact(
  connectionId: string,
  artifactId: string,
): Promise<void> {
  return invoke("reveal_job_artifact", { connectionId, artifactId });
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

export function listDashboards(connectionId: string): Promise<Dashboard[]> {
  return invoke("list_dashboards", { connectionId });
}

export function deleteDashboard(id: string): Promise<void> {
  return invoke("delete_dashboard", { id });
}

export function runDashboard(id: string, queryId?: string): Promise<QueryResult> {
  return invoke("run_dashboard", { id, queryId: queryId ?? null });
}

// Native picker (null = user cancelled the dialog).
export function pickFile(): Promise<string | null> {
  return invoke("pick_file");
}

// Install/auth status for supported subscription-backed Terminal profiles.
export function detectAgentClis(): Promise<CliInfo[]> {
  return invoke("detect_agent_clis");
}

// Read-only legacy conversation archive.
export function listChatThreads(): Promise<ChatThread[]> {
  return invoke("list_chat_threads");
}

// One thread's message history, oldest first.
export function getChatMessages(threadId: string): Promise<ChatMessageRecord[]> {
  return invoke("get_chat_messages", { threadId });
}
