//! Shared serde types — the data contract between the Rust core and the React
//! frontend. All types serialize `camelCase`. Keep this file authoritative:
//! module agents conform to these shapes rather than redefining them.
//!
use std::collections::HashMap;

use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Supported target database engines.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Engine {
    Postgres,
    Mysql,
    Sqlite,
    Mongodb,
}

impl Engine {
    /// Document-family engines: no SQL surface, queried through the typed
    /// document API. THE single place a future document engine gets added —
    /// every SQL-vs-document branch asks this instead of matching variants.
    pub fn is_document(self) -> bool {
        matches!(self, Engine::Mongodb)
    }
}

/// Hosting/control-plane provider. `Auto` preserves connection-URL convenience while
/// keeping provider-specific behavior separate from the database wire protocol.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Provider {
    #[default]
    Auto,
    Generic,
    Neon,
    PlanetScale,
    GcpCloudSql,
}

/// Process-stable experimental platform gates. An empty list is fail-closed.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformFeatureFlags {
    pub enabled: Vec<String>,
}

/// Cached server authority for a shared connection. Personal connections are Local;
/// team modes are narrowing permissions and never elevate the target DB credential.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceConnectionAccess {
    View,
    Read,
    Write,
    Manage,
    #[default]
    Local,
}

impl WorkspaceConnectionAccess {
    pub fn can_read(self) -> bool {
        matches!(self, Self::Read | Self::Write | Self::Manage | Self::Local)
    }

    pub fn can_write(self) -> bool {
        matches!(self, Self::Write | Self::Manage | Self::Local)
    }

    pub fn can_manage(self) -> bool {
        matches!(self, Self::Manage | Self::Local)
    }
}

/// Credential source for a connection. Managed secrets are leased into process memory
/// only; member-local and personal secrets may reference the OS credential store.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceCredentialMode {
    #[default]
    Local,
    MemberLocal,
    Managed,
}

/// A saved connection. Plaintext secrets never live here. `secretRef` points at an OS
/// credential item; managed profiles instead obtain a short-lived in-memory lease.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    pub id: Uuid,
    pub name: String,
    pub engine: Engine,
    /// Provider overlay selected by the user; `Auto` resolves from the endpoint.
    #[serde(default)]
    pub provider: Provider,
    /// Explicit driver selection. `None` asks the registry for its best compatible driver.
    #[serde(default)]
    pub driver_id: Option<String>,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    pub sslmode: String,
    #[serde(default)]
    pub extra_params: HashMap<String, String>,
    /// Open connections read-only by default.
    pub readonly_default: bool,
    /// Master per-connection gate for the write path (default false).
    pub allow_writes: bool,
    /// Credential-store item id for the secret, if one has been stored.
    pub secret_ref: Option<String>,
    /// Environment label ("dev" | "staging" | "prod") — drives the sidebar/header chip.
    #[serde(default)]
    pub env: Option<String>,
    /// Shared schema family. Connections with the same value are compared as
    /// dev/staging/prod siblings, using prod as the default baseline when present.
    #[serde(default)]
    pub schema_group: Option<String>,
    /// Local cache of the authenticated workspace member's effective permission.
    #[serde(default)]
    pub workspace_access: WorkspaceConnectionAccess,
    /// Personal, member-local OS credential, or server-brokered in-memory lease.
    #[serde(default)]
    pub credential_mode: WorkspaceCredentialMode,
}

/// Per-connection safety configuration (mirrors `connection_safety` in app.db).
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SafetySettings {
    /// Legacy persisted compatibility field. Exact Operation approval is always
    /// required for target mutations regardless of this value.
    pub require_approval: bool,
    pub allow_writes: bool,
    pub wrap_writes_in_tx: bool,
    pub explain_preview: bool,
    pub auto_run_reads: bool,
    /// Row cap applied to read result sets.
    pub max_rows: u64,
    /// L3 gate (design-review #4): skip execute-preview when the EXPLAIN row estimate
    /// exceeds this and show the estimate only ("would lock ~N rows").
    pub exec_preview_row_limit: i64,
}

/// Monitoring capability exposed by one saved connection. PostgreSQL can opt in to
/// the built-in `pg_monitor` role; other engines keep a basic, role-free collector.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitoringStatus {
    pub engine: Engine,
    /// "full" when pg_monitor is granted, "limited" without it, "basic" for
    /// engines that do not use PostgreSQL's predefined monitoring roles.
    pub coverage: String,
    pub role_available: bool,
    pub role_granted: bool,
    pub current_user: Option<String>,
    /// Best-effort hint only. The server remains authoritative when GRANT/REVOKE runs.
    pub can_manage: bool,
    pub note: String,
}

impl Default for SafetySettings {
    fn default() -> Self {
        SafetySettings {
            require_approval: true,
            allow_writes: false,
            wrap_writes_in_tx: true,
            explain_preview: true,
            auto_run_reads: true,
            max_rows: 1000,
            exec_preview_row_limit: 50_000,
        }
    }
}

/// Statement class from L1 parse/classify.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum QueryKind {
    Read,
    Write,
    Ddl,
    Privilege,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RiskLevel {
    Low,
    Medium,
    High,
}

/// Result of L1 classification. A UX pre-filter — L2 is the authoritative boundary.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Classification {
    pub kind: QueryKind,
    pub risk: RiskLevel,
    /// Number of top-level statements parsed. `> 1` is rejected.
    pub statement_count: u32,
    /// UPDATE/DELETE without a WHERE clause (high-risk flag).
    pub no_where: bool,
    pub tables: Vec<String>,
    pub notes: Vec<String>,
    /// True ONLY for exactly one cleanly-parsed top-level INSERT/UPDATE/DELETE —
    /// i.e. a statement the L3 execute+ROLLBACK preview can undo. DDL/utility
    /// statements implicit-commit (RENAME/OPTIMIZE/LOAD DATA…), so ROLLBACK is a
    /// no-op and the preview would take permanent effect BEFORE L4 approval.
    /// Fail-safe/parse-error/multi-statement writes are false. Gates l3_preview.
    #[serde(default)]
    pub rollback_safe: bool,
}

/// How an impact preview was produced (L3).
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PreviewMode {
    /// Read path: EXPLAIN plan only, never executed.
    Explain,
    /// Write path: executed in a txn then unconditionally rolled back for exact N.
    ExecRollback,
    /// Execute-preview skipped (estimate over threshold); estimate shown only.
    Skipped,
}

/// L3 impact preview shown on the approval card.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewReport {
    pub mode: PreviewMode,
    /// EXPLAIN-derived row estimate.
    pub estimated_rows: Option<i64>,
    /// Exact rows_affected from the execute+rollback path.
    pub exact_rows: Option<i64>,
    /// Raw/formatted plan text, if captured.
    pub plan: Option<String>,
    /// Human note, e.g. "would lock ~120000 rows — preview skipped".
    pub note: Option<String>,
}

/// A materialized result set (or a page of one).
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub row_count: usize,
    /// True if the result was cut off at the row cap.
    pub truncated: bool,
    pub duration_ms: u64,
}

/// One typed, read-only MongoDB request — the ONLY way document operations run.
/// There is deliberately no raw-command variant: reads are constructed from these
/// shapes plus a pipeline-stage allowlist, never classified from strings.
/// `filter`/`pipeline`/… accept MongoDB Extended JSON.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", tag = "op")]
pub enum DocumentQuery {
    /// `db.collection.find(filter)` with optional projection/sort/skip/limit.
    Find {
        collection: String,
        #[serde(default)]
        #[cfg_attr(test, ts(optional = nullable))]
        filter: Option<serde_json::Value>,
        #[serde(default)]
        #[cfg_attr(test, ts(optional = nullable))]
        projection: Option<serde_json::Value>,
        #[serde(default)]
        #[cfg_attr(test, ts(optional = nullable))]
        sort: Option<serde_json::Value>,
        #[serde(default)]
        #[cfg_attr(test, ts(optional = nullable))]
        skip: Option<u64>,
        #[serde(default)]
        #[cfg_attr(test, ts(optional = nullable))]
        limit: Option<u64>,
    },
    /// `db.collection.aggregate(pipeline)` — stages pass a read-only allowlist.
    Aggregate {
        collection: String,
        pipeline: Vec<serde_json::Value>,
    },
    /// `db.collection.countDocuments(filter)`.
    Count {
        collection: String,
        #[serde(default)]
        #[cfg_attr(test, ts(optional = nullable))]
        filter: Option<serde_json::Value>,
    },
}

/// A page of documents from one [`DocumentQuery`] run. Each element is one BSON
/// document rendered as relaxed Extended JSON (ObjectId/Date/Decimal128/Int64/
/// Binary keep their meaning — never cast to lossy plain numbers).
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentPage {
    pub documents: Vec<serde_json::Value>,
    pub doc_count: usize,
    /// True if the result was cut off at the row cap.
    pub truncated: bool,
    pub duration_ms: u64,
}

/// Outcome of a `run_sql` call.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecOutcome {
    pub result: Option<QueryResult>,
    pub affected: Option<u64>,
    /// True only when a write actually committed.
    pub committed: bool,
}

/// One statement's outcome inside a `run_script` run. Exactly one of `result`/
/// `affected`/`error` is meaningful: a read carries `result`, a write carries
/// `affected`, a failed or skipped statement carries `error`.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptStatement {
    pub sql: String,
    pub result: Option<QueryResult>,
    pub affected: Option<i64>,
    pub error: Option<String>,
}

/// Outcome of a `run_script` call. `committed` is true only for a write script whose
/// single transaction committed; `all_reads` picks the read-only sequential path.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptOutcome {
    pub statements: Vec<ScriptStatement>,
    pub committed: bool,
    pub all_reads: bool,
}

/// One append-only, hash-chained audit record (compliance log).
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub id: Uuid,
    pub connection_id: Uuid,
    pub ts: DateTime<Utc>,
    pub engine: Engine,
    pub agent_prompt: Option<String>,
    pub sql: String,
    pub kind: QueryKind,
    /// e.g. "propose" | "approve" | "reject" | "execute" | "blocked".
    pub action: String,
    pub approved_by: Option<String>,
    pub affected_estimate: Option<i64>,
    pub error: Option<String>,
    pub prev_hash: Option<String>,
    /// SHA256(prev_hash ‖ canonical_row) — tamper-evidence chain link.
    pub hash: String,
}

/// One `query_history` row (UX/replay log, kept separate from the audit log).
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: Uuid,
    pub connection_id: Uuid,
    pub sql: String,
    pub kind: QueryKind,
    /// "ok" | "error" | "blocked".
    pub status: String,
    pub row_count: Option<i64>,
    pub duration_ms: Option<i64>,
    pub error: Option<String>,
    pub executed_at: DateTime<Utc>,
    /// "agent" | "manual" | "dashboard" | "migration".
    pub origin: String,
}

/// Normalizes only platform line-ending representation before test-only generated
/// contract equality checks. Whitespace, declarations, and all other bytes remain
/// significant so the deterministic generators still catch semantic drift.
#[cfg(test)]
pub(crate) fn normalize_generated_contract_newlines(source: &str) -> std::borrow::Cow<'_, str> {
    if source.contains('\r') {
        std::borrow::Cow::Owned(source.replace("\r\n", "\n").replace('\r', "\n"))
    } else {
        std::borrow::Cow::Borrowed(source)
    }
}

#[cfg(test)]
mod contracts {
    use std::path::PathBuf;

    use chrono::{TimeZone, Utc};
    use serde_json::json;
    use ts_rs::{Config, TS};
    use uuid::Uuid;

    use super::{
        AuditEntry, Classification, ConnectionProfile, DocumentPage, DocumentQuery, Engine,
        ExecOutcome, HistoryEntry, MonitoringStatus, PlatformFeatureFlags, PreviewMode,
        PreviewReport, Provider, QueryKind, QueryResult, RiskLevel, SafetySettings, ScriptOutcome,
        ScriptStatement, WorkspaceConnectionAccess, WorkspaceCredentialMode,
    };

    const HEADER: &str = "// Generated from src-tauri/src/model.rs by ts-rs 12.0.1.\n// Do not edit; run pnpm generate:contracts.\n\nexport type JsonValue =\n  | string\n  | number\n  | boolean\n  | null\n  | { [key: string]: JsonValue }\n  | JsonValue[];\n\n";

    fn output_path() -> PathBuf {
        std::env::var_os("DOPEDB_CONTRACT_OUTPUT")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src/ipc/generated/model.ts")
            })
    }

    fn append<T: TS>(output: &mut String, config: &Config) {
        output.push_str("export ");
        output.push_str(
            &T::decl(config)
                .lines()
                .map(str::trim_end)
                .collect::<Vec<_>>()
                .join("\n"),
        );
        output.push('\n');
    }

    fn generated_contracts() -> String {
        let config = Config::default().with_large_int("number");
        let mut output = String::from(HEADER);
        macro_rules! append_contracts {
            ($($contract:ty),+ $(,)?) => {
                $(append::<$contract>(&mut output, &config);)+
            };
        }
        append_contracts!(
            Engine,
            Provider,
            PlatformFeatureFlags,
            WorkspaceConnectionAccess,
            WorkspaceCredentialMode,
            ConnectionProfile,
            SafetySettings,
            MonitoringStatus,
            QueryKind,
            RiskLevel,
            Classification,
            PreviewMode,
            PreviewReport,
            QueryResult,
            DocumentQuery,
            DocumentPage,
            ExecOutcome,
            ScriptStatement,
            ScriptOutcome,
            AuditEntry,
            HistoryEntry,
        );
        output
    }

    #[test]
    fn generated_model_contracts_are_current() {
        let output_path = output_path();
        let expected = generated_contracts();
        if std::env::var_os("DOPEDB_CONTRACT_GENERATE").is_some() {
            std::fs::create_dir_all(output_path.parent().expect("contract output parent"))
                .expect("create contract output directory");
            std::fs::write(&output_path, expected).expect("write generated model contracts");
            return;
        }

        let actual = std::fs::read_to_string(&output_path)
            .unwrap_or_else(|error| panic!("read {}: {error}", output_path.display()));
        assert_eq!(
            super::normalize_generated_contract_newlines(&actual),
            super::normalize_generated_contract_newlines(&expected),
            "Rust model serde contract drifted; run pnpm generate:contracts"
        );
    }

    #[test]
    fn generated_contract_newline_normalization_preserves_all_other_drift() {
        let expected = "export type Contract = { field: string };\n";
        assert_eq!(
            super::normalize_generated_contract_newlines(
                "export type Contract = { field: string };\r\n"
            ),
            super::normalize_generated_contract_newlines(expected),
        );
        assert_ne!(
            super::normalize_generated_contract_newlines(
                "export type Contract = { field: string }; \r\n"
            ),
            super::normalize_generated_contract_newlines(expected),
        );
        assert_ne!(
            super::normalize_generated_contract_newlines(
                "export type Contract = { field: number };\r\n"
            ),
            super::normalize_generated_contract_newlines(expected),
        );
    }

    #[test]
    fn generated_model_contracts_preserve_serde_edge_cases() {
        let generated = generated_contracts();
        for expected in [
            "driverId: string | null",
            "env: string | null",
            "schemaGroup: string | null",
            "export type Provider = \"auto\" | \"generic\" | \"neon\" | \"planetScale\" | \"gcpCloudSql\";",
            "export type QueryResult = { columns: Array<string>, rows: Array<Array<JsonValue>>",
            "extraParams: { [key in string]: string }",
            "export type DocumentQuery = { \"op\": \"find\"",
            "filter?: JsonValue | null",
            "pipeline: Array<JsonValue>",
        ] {
            assert!(
                generated.contains(expected),
                "missing generated contract: {expected}"
            );
        }
    }

    #[test]
    fn serde_wire_samples_match_required_nullable_generated_contracts() {
        let query = DocumentQuery::Find {
            collection: "events".into(),
            filter: None,
            projection: Some(json!({"id": 1})),
            sort: None,
            skip: None,
            limit: Some(10),
        };
        let query_json = serde_json::to_value(query).expect("serialize document query");
        assert_eq!(query_json["op"], "find");
        assert!(query_json.as_object().unwrap().contains_key("filter"));
        assert!(query_json["filter"].is_null());
        assert!(query_json.as_object().unwrap().contains_key("sort"));
        assert!(query_json["sort"].is_null());
        assert_eq!(query_json["projection"], json!({"id": 1}));

        // Request deserialization deliberately accepts omitted defaults even though the
        // response serialization above keeps those keys required and nullable.
        let omitted_find: DocumentQuery = serde_json::from_value(json!({
            "op": "find",
            "collection": "events"
        }))
        .expect("deserialize omitted find defaults");
        assert!(matches!(
            omitted_find,
            DocumentQuery::Find {
                filter: None,
                projection: None,
                sort: None,
                skip: None,
                limit: None,
                ..
            }
        ));
        assert!(matches!(
            serde_json::from_value::<DocumentQuery>(json!({
                "op": "aggregate", "collection": "events", "pipeline": []
            }))
            .expect("deserialize aggregate tag"),
            DocumentQuery::Aggregate { .. }
        ));
        assert!(matches!(
            serde_json::from_value::<DocumentQuery>(json!({
                "op": "count", "collection": "events"
            }))
            .expect("deserialize count tag"),
            DocumentQuery::Count { filter: None, .. }
        ));

        let audit = AuditEntry {
            id: Uuid::from_u128(1),
            connection_id: Uuid::from_u128(2),
            ts: Utc.timestamp_opt(0, 0).single().unwrap(),
            engine: Engine::Postgres,
            agent_prompt: None,
            sql: "select 1".into(),
            kind: QueryKind::Read,
            action: "execute".into(),
            approved_by: None,
            affected_estimate: None,
            error: None,
            prev_hash: None,
            hash: "a".repeat(64),
        };
        let audit_json = serde_json::to_value(audit).expect("serialize audit entry");
        assert_eq!(audit_json["connectionId"], Uuid::from_u128(2).to_string());
        assert_eq!(audit_json["id"], Uuid::from_u128(1).to_string());
        assert!(audit_json["agentPrompt"].is_null());
        assert!(audit_json["ts"].as_str().unwrap().ends_with('Z'));
    }
}
