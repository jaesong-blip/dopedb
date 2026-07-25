// Shared TS mirrors of Rust serde types. Migrated feature-private contracts live in
// their feature domain; keep remaining camelCase shapes aligned with their Rust source.

export type Engine = "postgres" | "mysql" | "sqlite" | "mongodb";
export type Provider = "auto" | "generic" | "neon" | "planetScale" | "gcpCloudSql";

export type PlatformFeatureFlag =
  | "operation_runtime_v1"
  | "local_broker_v1"
  | "cli_v1"
  | "skill_manager_v1"
  | "terminal_dock_v1"
  | "catalog_v2"
  | "ddl_ir_v1"
  | "table_changes_v1"
  | "erd_v1"
  | "jobs_v1"
  | "plugins_v1"
  | "workspace_resources_v1"
  | "realtime_collaboration_v1";

export interface PlatformFeatureFlags {
  enabled: PlatformFeatureFlag[];
}

// PTY-backed Terminal Dock. Sessions are process-local and connection pins are
// immutable for their full lifetime.
export type TerminalProfile = "shell" | "codex" | "claude";
export type TerminalLifecycle =
  | "starting"
  | "running"
  | "stopping"
  | "exited"
  | "failed";
export type TerminalDatabasePolicy = "readOnly" | "approvalRequired";

export interface TerminalSize {
  cols: number;
  rows: number;
  pixelWidth: number;
  pixelHeight: number;
}

export interface TerminalCreateRequest {
  connectionId: string;
  profile: TerminalProfile;
  size: TerminalSize;
  name?: string | null;
}

export interface TerminalConnectionPin {
  workspaceId: string;
  accountScope: string;
  scopeGeneration: number;
  connectionId: string;
  connectionRevision: number;
  connectionName: string;
  database: string;
  environment: string | null;
  engine: Engine;
  policy: TerminalDatabasePolicy;
}

export interface TerminalExit {
  success: boolean;
  code: number | null;
  signal: string | null;
  at: string;
}

export interface TerminalSessionSummary {
  id: string;
  name: string;
  profile: TerminalProfile;
  lifecycle: TerminalLifecycle;
  size: TerminalSize;
  connection: TerminalConnectionPin;
  createdAt: string;
  lastActivityAt: string;
  exit: TerminalExit | null;
}

export interface TerminalOutputChunk {
  sessionId: string;
  sequence: number;
  bytes: number[];
  replay: boolean;
}

export interface TerminalFocusReceipt {
  session: TerminalSessionSummary;
  replayFrom: number | null;
  replayThrough: number;
  replayTruncated: boolean;
}

export interface TerminalStateEvent {
  session: TerminalSessionSummary;
}

export interface TerminalExitEvent {
  sessionId: string;
  exit: TerminalExit;
}

// Mirrors src-tauri/src/cli_install.rs.
export interface CliInstallationStatus {
  version: string;
  bundledAvailable: boolean;
  bundledPath: string | null;
  inAppDirectory: string | null;
  installPath: string;
  installed: boolean;
  current: boolean;
  conflict: boolean;
  pathConfigured: boolean;
  pathChangeRequired: boolean;
  pathChangeSupported: boolean;
  pathChangePreview: string | null;
}

export interface CliInstallReceipt {
  status: CliInstallationStatus;
  binaryChanged: boolean;
  pathChanged: boolean;
}

// Mirrors dopedb-protocol/src/skill_command.rs and
// src-tauri/src/skills/mod.rs (SkillSelfTestReceipt).
export type SkillTarget = "codex" | "claude-code";
export type SkillTargetSelection = SkillTarget | "all";
export type SkillInstallState =
  | "missing"
  | "managed_current"
  | "managed_older"
  | "user_modified"
  | "newer_known"
  | "unknown_conflict"
  | "invalid";
export type SkillStatusReason =
  | "files_differ_from_managed_snapshot"
  | "install_path_inspection_failed"
  | "install_path_symlink"
  | "install_root_not_directory"
  | "install_target_not_directory"
  | "install_target_outside_home"
  | "install_target_symlink"
  | "installed_file_changed"
  | "installed_file_too_large"
  | "installed_skill_byte_limit"
  | "installed_skill_file_count_limit"
  | "installed_skill_nesting_limit"
  | "installed_skill_non_unicode_path"
  | "installed_skill_read_failed"
  | "installed_skill_symlink"
  | "installed_skill_unsafe_path"
  | "installed_skill_unsupported_file"
  | "inventory_escaped_root"
  | "provenance_marker_malformed"
  | "provenance_marker_not_file"
  | "provenance_marker_unreadable"
  | "unknown_managed_snapshot"
  | "unmanaged_files"
  | "unsafe_path_component";
export type SkillConflictKind =
  | "missing"
  | "modified"
  | "unexpected"
  | "invalid_provenance";

export interface SkillConflict {
  path: string;
  kind: SkillConflictKind;
}

export interface SkillSummary {
  name: string;
  releaseRevision: number;
  appVersion: string;
  packageDigest: string;
}

export interface SkillTargetStatus {
  target: SkillTarget;
  displayName: string;
  installPath: string;
  state: SkillInstallState;
  repairable: boolean;
  currentRevision: number;
  installedRevision: number | null;
  installedPackageDigest: string | null;
  inventoryFingerprint: string;
  reason: SkillStatusReason | null;
  conflicts: SkillConflict[];
}

export interface SkillStatus {
  skill: SkillSummary;
  targets: SkillTargetStatus[];
}

export interface SkillTargetExpectation {
  target: SkillTarget;
  inventoryFingerprint: string;
}

export interface SkillBackup {
  target: SkillTarget;
  path: string;
}

export interface SkillMutationReceipt {
  status: SkillStatus;
  changedTargets: SkillTarget[];
  backups: SkillBackup[];
}

export interface SkillSelfTestReceipt {
  appVersion: string;
  releaseRevision: number;
  guideBytes: number;
}

// Mirrors src-tauri/src/legacy_mcp_cleanup.rs.
export type LegacyMcpCleanupState = "absent" | "ready" | "manual_review";

export interface LegacyMcpCleanupTarget {
  id: string;
  displayName: string;
  path: string;
  state: LegacyMcpCleanupState;
  fingerprint: string | null;
  redactedDiff: string | null;
  reason: string | null;
}

export interface LegacyMcpCleanupStatus {
  targets: LegacyMcpCleanupTarget[];
}

export interface LegacyMcpCleanupExpectation {
  id: string;
  fingerprint: string;
}

export interface LegacyMcpCleanupBackup {
  targetId: string;
  path: string;
}

export interface LegacyMcpCleanupReceipt {
  removedTargetIds: string[];
  backups: LegacyMcpCleanupBackup[];
  status: LegacyMcpCleanupStatus;
}

export interface SafetySettings {
  /** Legacy storage field; target mutations always require exact Operation approval. */
  requireApproval: boolean;
  allowWrites: boolean;
  wrapWritesInTx: boolean;
  explainPreview: boolean;
  autoRunReads: boolean;
  maxRows: number;
  execPreviewRowLimit: number;
}

export interface MonitoringStatus {
  engine: Engine;
  coverage: "full" | "limited" | "basic";
  roleAvailable: boolean;
  roleGranted: boolean;
  currentUser: string | null;
  canManage: boolean;
  note: string;
}

type QueryKind = "read" | "write" | "ddl" | "privilege";

export type RiskLevel = "low" | "medium" | "high";

export interface Classification {
  kind: QueryKind;
  risk: RiskLevel;
  statementCount: number;
  noWhere: boolean;
  tables: string[];
  notes: string[];
  /** True only for a single cleanly-parsed write the L3 exec+ROLLBACK preview can undo. */
  rollbackSafe: boolean;
}

type PreviewMode = "explain" | "execRollback" | "skipped";

export interface PreviewReport {
  mode: PreviewMode;
  estimatedRows: number | null;
  exactRows: number | null;
  plan: string | null;
  note: string | null;
}

// Mirrors exact Operation projections from src-tauri/src/services/query_service.rs
// and operation_service.rs. SQL appears only in the proposal request, never run.
export type OperationState =
  | "planned"
  | "pending_approval"
  | "ready"
  | "approved"
  | "rejected"
  | "expired"
  | "cancelled"
  | "executing"
  | "succeeded"
  | "failed"
  | "outcome_unknown";

export interface SqlOperationProposal {
  operationId: string;
  payloadHash: string;
  state: OperationState;
  approvalRequired: boolean;
  autoRun: boolean;
  confirmationPhrase: string | null;
  expiresAt: string;
  classification: Classification;
  preview: PreviewReport;
}

export interface OperationDecision {
  operationId: string;
  payloadHash: string;
  state: OperationState;
}

export interface DocumentOperationProposal {
  operationId: string;
  payloadHash: string;
  state: OperationState;
  expiresAt: string;
}

export interface ScriptOperationProposal {
  operationId: string;
  payloadHash: string;
  state: OperationState;
  approvalRequired: boolean;
  confirmationPhrase: string | null;
  statementCount: number;
  expiresAt: string;
}

// Mirrors src-tauri/src/services/monitoring_service.rs.
export interface MonitoringOperationProposal {
  operationId: string;
  payloadHash: string;
  state: OperationState;
  enabled: boolean;
  sql: string;
  confirmationPhrase: string | null;
  expiresAt: string;
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  durationMs: number;
}

// One typed, read-only MongoDB request (mirrors model.rs DocumentQuery). Filters,
// projections, sorts, and pipeline stages accept MongoDB Extended JSON objects.
export type DocumentQuery =
  | {
      op: "find";
      collection: string;
      filter?: unknown;
      projection?: unknown;
      sort?: unknown;
      skip?: number;
      limit?: number;
    }
  | { op: "aggregate"; collection: string; pipeline: unknown[] }
  | { op: "count"; collection: string; filter?: unknown };

// A page of documents from one DocumentQuery run; each element is one BSON
// document as relaxed Extended JSON (mirrors model.rs DocumentPage).
export interface DocumentPage {
  documents: unknown[];
  docCount: number;
  truncated: boolean;
  durationMs: number;
}

export type DashboardKind = "auto" | "metric" | "line" | "bar" | "table";

export interface DashboardVisualization {
  version: 1;
  kind: DashboardKind;
  xColumn: string | null;
  yColumns: string[];
}

export interface Dashboard {
  id: string;
  connectionId: string;
  title: string;
  description: string;
  sql: string;
  visualization: DashboardVisualization;
  createdAt: string;
  updatedAt: string;
}

export interface ExecOutcome {
  result: QueryResult | null;
  affected: number | null;
  committed: boolean;
}

// One statement's outcome inside a run_script run. A read carries `result`, a write
// carries `affected`, a failed/skipped statement carries `error`.
interface ScriptStatement {
  sql: string;
  result: QueryResult | null;
  affected: number | null;
  error: string | null;
}

export interface ScriptOutcome {
  statements: ScriptStatement[];
  committed: boolean; // true only when a write script's transaction committed
  allReads: boolean; // true when the read-only sequential path ran
}

interface AuditEntry {
  id: string;
  connectionId: string;
  ts: string; // ISO-8601
  engine: Engine;
  agentPrompt: string | null;
  sql: string;
  kind: QueryKind;
  action: string;
  approvedBy: string | null;
  affectedEstimate: number | null;
  error: string | null;
  prevHash: string | null;
  hash: string;
}

interface AuditVerdict {
  ok: boolean;
  firstBadIndex: number | null;
}

export interface AuditSnapshot {
  entries: AuditEntry[];
  verdict: AuditVerdict;
}

export interface HistoryEntry {
  id: string;
  connectionId: string;
  sql: string;
  kind: QueryKind;
  status: string;
  rowCount: number | null;
  durationMs: number | null;
  error: string | null;
  executedAt: string;
  origin: string;
}

// Schema introspection (mirrors src-tauri/src/introspect/mod.rs Catalog).
export interface CatalogColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  pk: boolean;
  ordinal?: number;
  length?: number | null;
  precision?: number | null;
  scale?: number | null;
  defaultExpression?: string | null;
  generatedExpression?: string | null;
  identity?: boolean;
  autoIncrement?: boolean;
  collation?: string | null;
  comment?: string | null;
}

export interface CatalogForeignKey {
  name?: string | null;
  ordinal?: number;
  column: string;
  referencesTable: string;
  referencesColumn: string;
  referencesSchema: string | null;
  updateAction?: string | null;
  deleteAction?: string | null;
  deferrable?: boolean;
  validated?: boolean;
}

export interface CatalogIndexKey {
  column: string | null;
  expression: string | null;
  direction: "asc" | "desc" | null;
}

export interface CatalogIndex {
  name: string;
  columns: string[];
  unique: boolean;
  method?: string | null;
  keys?: CatalogIndexKey[];
  includedColumns?: string[];
  predicate?: string | null;
  valid?: boolean;
}

export interface CatalogTable {
  schema: string | null;
  name: string;
  kind: string; // "table" | "view"
  nativeId?: string | null;
  comment?: string | null;
  partitionParent?: CatalogObjectRef | null;
  partitionChildren?: CatalogObjectRef[];
  columns: CatalogColumn[];
  foreignKeys: CatalogForeignKey[];
  constraints?: CatalogConstraint[];
  indexes: CatalogIndex[];
  rowEstimate: number | null;
}

export type CatalogObjectKindV2 =
  | "namespace"
  | "table"
  | "view"
  | "materialized_view"
  | "routine"
  | "trigger"
  | "sequence"
  | "index"
  | "constraint"
  | "collection"
  | "other";

export interface CatalogObjectRef {
  catalog: string | null;
  namespace: string | null;
  name: string;
  kind: CatalogObjectKindV2;
  nativeId: string | null;
}

export type CatalogConstraintKind = "primary" | "unique" | "foreign" | "check";

export interface CatalogConstraint {
  name: string;
  kind: CatalogConstraintKind;
  columns: string[];
  referencedRelation: CatalogObjectRef | null;
  referencedColumns: string[];
  checkExpression: string | null;
  updateAction: string | null;
  deleteAction: string | null;
  deferrable: boolean;
  validated: boolean;
}

export type CatalogObjectKind =
  | "function"
  | "procedure"
  | "trigger"
  | "sequence"
  | "materialized_view";

export interface CatalogObject {
  schema: string | null;
  name: string;
  kind: CatalogObjectKind | string;
  detail?: string | null;
  parent?: string | null;
}

export interface Catalog {
  tables: CatalogTable[];
  // Optional while schema caches created by older app versions are still present.
  objects?: CatalogObject[];
}

export interface CatalogNamespace {
  name: string;
  comment: string | null;
}

export interface CatalogRelationV2 {
  object: CatalogObjectRef;
  comment: string | null;
  rowEstimate: number | null;
  partitionParent: CatalogObjectRef | null;
  partitionChildren: CatalogObjectRef[];
  columns: Array<{
    name: string;
    ordinal: number;
    nativeType: string;
    typeFamily: string;
    length: number | null;
    precision: number | null;
    scale: number | null;
    nullable: boolean;
    defaultExpression: string | null;
    generatedExpression: string | null;
    identity: boolean;
    autoIncrement: boolean;
    collation: string | null;
    comment: string | null;
    sensitivity: string | null;
  }>;
  constraints: CatalogConstraint[];
  indexes: Array<{
    name: string;
    method: string | null;
    keys: CatalogIndexKey[];
    includedColumns: string[];
    predicate: string | null;
    unique: boolean;
    valid: boolean;
  }>;
}

export interface CatalogSnapshot {
  schemaVersion: number;
  connectionId: string;
  engine: Engine;
  database: string;
  capturedAt: string;
  fingerprint: string;
  namespaces: CatalogNamespace[];
  relations: CatalogRelationV2[];
  routines: unknown[];
  otherObjects: unknown[];
}

// Subscription-backed Terminal providers and their local CLI status.
// Mirrors src-tauri/src/agent_cli.rs.
export type AgentProvider = "claude" | "codex";

export interface CliInfo {
  id: AgentProvider;
  name: string;
  installed: boolean;
  authenticated: boolean;
  authMethod: string | null;
  note: string;
}

// Read-only records from conversations created before the Terminal migration.
export interface ChatThread {
  id: string;
  provider: AgentProvider;
  connectionId: string | null;
  title: string;
  cliSessionId: string | null;
  model: string | null;
  effort: string | null;
  createdAt: string;
  updatedAt: string;
}

// One archived persisted message row.
export interface ChatMessageRecord {
  id: string;
  threadId: string;
  role: "user" | "assistant";
  text: string;
  error: string | null;
  createdAt: string;
}

// The `{ kind, message, position? }` object AppError serializes to.
interface AppErrorShape {
  kind: string;
  message: string;
  /** 1-based character offset into the executed SQL (Postgres only). */
  position?: number;
}

export function errMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    return String((e as AppErrorShape).message);
  }
  return String(e);
}

/** True only when Rust confirmed a non-mutating query cancellation response. */
export function isQueryCancellationError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const shaped = e as Partial<AppErrorShape>;
  return shaped.kind === "safety"
    && typeof shaped.message === "string"
    && shaped.message.includes("query cancelled");
}

export interface AppErrorDetails {
  kind: string | null;
  message: string;
  position: number | null;
  raw: string;
}

export function errDetails(e: unknown): AppErrorDetails {
  if (e && typeof e === "object" && "message" in e) {
    const shaped = e as Partial<AppErrorShape>;
    let raw = String(e);
    try {
      raw = JSON.stringify(e, null, 2) ?? raw;
    } catch {
      // Fall back to String(e).
    }
    return {
      kind: typeof shaped.kind === "string" ? shaped.kind : null,
      message: String(shaped.message),
      position: typeof shaped.position === "number" ? shaped.position : null,
      raw,
    };
  }
  return { kind: null, message: String(e), position: null, raw: String(e) };
}
