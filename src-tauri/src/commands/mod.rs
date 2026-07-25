//! The `#[tauri::command]` boundary. Commands already migrated to
//! [`crate::services`] are thin adapters; the remaining legacy commands stay here
//! only until their service boundary is extracted. Every command returns an
//! [`AppResult`] that serializes to `{ kind, message }` for the frontend.
//!
//! Safety invariants live in the service/operation path: writes, DDL, and privilege
//! changes are blocked unless policy authorizes the exact request. The executor
//! re-checks its gates as defense in depth, while the database's read-only session
//! remains the authoritative stop.

use tauri::State;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::model::{Dashboard, DocumentQuery, HistoryEntry, PlatformFeatureFlags, SafetySettings};
use crate::services::{
    AuditSnapshotReceipt, AuditVerdict, DashboardRunError, DashboardRunReceipt,
    DashboardRunRequest, DesktopDocumentProposalReceipt, DesktopDocumentProposalRequest,
    DesktopDocumentReadError, DesktopScriptProposalReceipt, DesktopScriptProposalRequest,
    DesktopScriptRunError, DesktopScriptRunReceipt, DesktopSqlClassificationReceipt,
    DesktopSqlClassificationRequest, DesktopSqlInspectionError, DesktopSqlPreviewReceipt,
    DesktopSqlPreviewRequest, DesktopSqlProposalReceipt, DesktopSqlProposalRequest,
    DesktopSqlRunError, DesktopSqlRunReceipt, DocumentReadReceipt, ErdLayout,
    MonitoringProposalReceipt, MonitoringProposalRequest, MonitoringServiceError,
    MonitoringStatusReceipt, OperationDecisionReceipt, OperationDecisionRequest,
    SaveErdLayoutOutcome, SaveErdLayoutRequest, SchemaChangePreviewRequest,
    SchemaChangeProposalReceipt, TableScriptContext,
};
use crate::state::AppState;

#[tauri::command]
pub async fn cli_installation_status(
    state: State<'_, AppState>,
) -> AppResult<crate::cli_install::CliInstallationStatus> {
    if !state
        .features
        .is_enabled(crate::features::FeatureFlag::CliV1)
    {
        return Err(AppError::Blocked {
            reason: "the CLI feature is disabled for this app runtime".into(),
        });
    }
    tokio::task::spawn_blocking(crate::cli_install::installation_status)
        .await
        .map_err(|_| AppError::Config("the CLI status worker stopped unexpectedly".into()))?
}

#[tauri::command]
pub async fn install_cli(
    state: State<'_, AppState>,
    update_path: bool,
    replace_existing: bool,
) -> AppResult<crate::cli_install::CliInstallReceipt> {
    if !state
        .features
        .is_enabled(crate::features::FeatureFlag::CliV1)
    {
        return Err(AppError::Blocked {
            reason: "the CLI feature is disabled for this app runtime".into(),
        });
    }
    tokio::task::spawn_blocking(move || crate::cli_install::install(update_path, replace_existing))
        .await
        .map_err(|_| AppError::Config("the CLI installer worker stopped unexpectedly".into()))?
}

#[tauri::command]
pub async fn skill_status(
    state: State<'_, AppState>,
    target: dopedb_protocol::SkillTargetSelection,
) -> AppResult<dopedb_protocol::SkillStatusResult> {
    require_skill_manager(&state)?;
    let skills = state.skills.clone();
    tokio::task::spawn_blocking(move || skills.status(target))
        .await
        .map_err(|_| AppError::Config("the Skill inventory worker stopped unexpectedly".into()))?
}

#[tauri::command]
pub async fn install_skill(
    state: State<'_, AppState>,
    target: dopedb_protocol::SkillTargetSelection,
    expected: Vec<dopedb_protocol::SkillTargetExpectation>,
) -> AppResult<dopedb_protocol::SkillMutationResult> {
    require_skill_manager(&state)?;
    let skills = state.skills.clone();
    tokio::task::spawn_blocking(move || {
        skills.install(dopedb_protocol::SkillMutationArguments { target, expected })
    })
    .await
    .map_err(|_| AppError::Config("the Skill install worker stopped unexpectedly".into()))?
}

#[tauri::command]
pub async fn repair_skill(
    state: State<'_, AppState>,
    target: dopedb_protocol::SkillTargetSelection,
    expected: Vec<dopedb_protocol::SkillTargetExpectation>,
) -> AppResult<dopedb_protocol::SkillMutationResult> {
    require_skill_manager(&state)?;
    let skills = state.skills.clone();
    tokio::task::spawn_blocking(move || {
        skills.repair(dopedb_protocol::SkillMutationArguments { target, expected })
    })
    .await
    .map_err(|_| AppError::Config("the Skill repair worker stopped unexpectedly".into()))?
}

#[tauri::command]
pub async fn remove_skill(
    state: State<'_, AppState>,
    target: dopedb_protocol::SkillTargetSelection,
    expected: Vec<dopedb_protocol::SkillTargetExpectation>,
) -> AppResult<dopedb_protocol::SkillMutationResult> {
    require_skill_manager(&state)?;
    let skills = state.skills.clone();
    tokio::task::spawn_blocking(move || {
        skills.remove(dopedb_protocol::SkillMutationArguments { target, expected })
    })
    .await
    .map_err(|_| AppError::Config("the Skill removal worker stopped unexpectedly".into()))?
}

#[tauri::command]
pub async fn skill_self_test(
    state: State<'_, AppState>,
) -> AppResult<crate::skills::SkillSelfTestReceipt> {
    require_skill_manager(&state)?;
    let skills = state.skills.clone();
    tokio::task::spawn_blocking(move || {
        let binary = crate::cli_install::bundled_cli_binary()?;
        skills.self_test_cli(&binary)
    })
    .await
    .map_err(|_| AppError::Config("the Skill self-test worker stopped unexpectedly".into()))?
}

fn require_skill_manager(state: &AppState) -> AppResult<()> {
    if state
        .features
        .is_enabled(crate::features::FeatureFlag::SkillManagerV1)
    {
        Ok(())
    } else {
        Err(AppError::Blocked {
            reason: "the Skill Manager feature is disabled for this app runtime".into(),
        })
    }
}

#[tauri::command]
pub fn platform_feature_flags(state: State<'_, AppState>) -> PlatformFeatureFlags {
    PlatformFeatureFlags {
        enabled: state
            .features
            .enabled_names()
            .into_iter()
            .map(str::to_string)
            .collect(),
    }
}

// ── saved dashboards ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_dashboards(
    state: State<'_, AppState>,
    connection_id: Uuid,
) -> AppResult<Vec<Dashboard>> {
    state.services.dashboard.list(connection_id).await
}

#[tauri::command]
pub async fn delete_dashboard(state: State<'_, AppState>, id: Uuid) -> AppResult<()> {
    state.services.dashboard.delete(id).await
}

/// Rerun one saved dashboard through the authoritative L2 read-only session.
/// Connection auto-run/write settings never select a writable executor here; the
/// current connection engine is used to revalidate the stored SQL on every run.
#[tauri::command]
pub async fn run_dashboard(
    state: State<'_, AppState>,
    id: Uuid,
    query_id: Option<Uuid>,
) -> AppResult<DashboardRunReceipt> {
    state
        .services
        .dashboard
        .run(DashboardRunRequest {
            dashboard_id: id,
            query_id,
        })
        .await
        .map_err(DashboardRunError::into_error)
}

// ── safety pipeline (L1 / L3) ────────────────────────────────────────────────

#[tauri::command]
pub async fn classify_sql(
    state: State<'_, AppState>,
    id: Uuid,
    sql: String,
) -> AppResult<DesktopSqlClassificationReceipt> {
    state
        .services
        .query
        .classify_desktop_sql(DesktopSqlClassificationRequest {
            connection_id: id,
            sql,
        })
        .await
        .map_err(DesktopSqlInspectionError::into_error)
}

#[tauri::command]
pub async fn preview_sql(
    state: State<'_, AppState>,
    id: Uuid,
    sql: String,
) -> AppResult<DesktopSqlPreviewReceipt> {
    state
        .services
        .query
        .preview_desktop_sql(DesktopSqlPreviewRequest {
            connection_id: id,
            sql,
        })
        .await
        .map_err(DesktopSqlInspectionError::into_error)
}

// ── execution (L4 gate → executor → audit) ───────────────────────────────────

#[tauri::command]
pub async fn propose_sql(
    state: State<'_, AppState>,
    id: Uuid,
    sql: String,
    origin: Option<String>,
) -> AppResult<DesktopSqlProposalReceipt> {
    state
        .services
        .query
        .propose_desktop_sql(DesktopSqlProposalRequest {
            connection_id: id,
            sql,
            origin,
        })
        .await
        .map_err(DesktopSqlInspectionError::into_error)
}

#[tauri::command]
pub async fn approve_operation(
    state: State<'_, AppState>,
    operation_id: Uuid,
    payload_hash: String,
    reason: Option<String>,
) -> AppResult<OperationDecisionReceipt> {
    state
        .services
        .operation
        .approve_local(
            &state.local_operation_approval,
            OperationDecisionRequest {
                operation_id,
                expected_payload_hash: payload_hash,
                reason,
            },
        )
        .await
}

#[tauri::command]
pub async fn reject_operation(
    state: State<'_, AppState>,
    operation_id: Uuid,
    payload_hash: String,
    reason: Option<String>,
) -> AppResult<OperationDecisionReceipt> {
    state
        .services
        .operation
        .reject_local(
            &state.local_operation_approval,
            OperationDecisionRequest {
                operation_id,
                expected_payload_hash: payload_hash,
                reason,
            },
        )
        .await
}

#[tauri::command]
pub async fn run_sql(
    state: State<'_, AppState>,
    operation_id: Uuid,
) -> AppResult<DesktopSqlRunReceipt> {
    state
        .services
        .query
        .run_desktop_sql(operation_id)
        .await
        .map_err(DesktopSqlRunError::into_error)
}

// ── typed document queries (MongoDB) ─────────────────────────────────────────

#[tauri::command]
pub async fn propose_document_query(
    state: State<'_, AppState>,
    id: Uuid,
    query: DocumentQuery,
    origin: Option<String>,
) -> AppResult<DesktopDocumentProposalReceipt> {
    state
        .services
        .document
        .propose_desktop_read(DesktopDocumentProposalRequest {
            connection_id: id,
            query,
            origin,
        })
        .await
        .map_err(DesktopDocumentReadError::into_error)
}

/// Typed document execution accepts only a durable single-use operation id. The
/// stored query is reclassified against the MongoDB stage allowlist before use.
#[tauri::command]
pub async fn run_document_query(
    state: State<'_, AppState>,
    operation_id: Uuid,
) -> AppResult<DocumentReadReceipt> {
    state
        .services
        .document
        .run_desktop_read(operation_id)
        .await
        .map_err(DesktopDocumentReadError::into_error)
}

// ── multi-statement script execution ─────────────────────────────────────────

#[tauri::command]
pub async fn propose_script(
    state: State<'_, AppState>,
    id: Uuid,
    sql: String,
    origin: Option<String>,
) -> AppResult<DesktopScriptProposalReceipt> {
    state
        .services
        .script
        .propose_desktop(DesktopScriptProposalRequest {
            connection_id: id,
            sql,
            origin,
            schema_change: None,
            table_change: None,
        })
        .await
        .map_err(DesktopScriptRunError::into_error)
}

#[tauri::command]
pub async fn propose_table_changes(
    state: State<'_, AppState>,
    id: Uuid,
    statements: Vec<String>,
    catalog_fingerprint: String,
) -> AppResult<DesktopScriptProposalReceipt> {
    if !state
        .features
        .is_enabled(crate::features::FeatureFlag::TableChangesV1)
    {
        return Err(AppError::Blocked {
            reason: "staged table changes are disabled for this app runtime".into(),
        });
    }
    if statements.is_empty() {
        return Err(AppError::Config(
            "at least one staged table change is required".into(),
        ));
    }
    let statement_count = statements.len();
    state
        .services
        .script
        .propose_desktop(DesktopScriptProposalRequest {
            connection_id: id,
            sql: statements.join(";\n"),
            origin: Some("table_editor".into()),
            schema_change: None,
            table_change: Some(TableScriptContext {
                catalog_fingerprint,
                expected_affected: vec![1; statement_count],
            }),
        })
        .await
        .map_err(DesktopScriptRunError::into_error)
}

/// Execute a previously persisted script by operation id only.
#[tauri::command]
pub async fn run_script(
    state: State<'_, AppState>,
    operation_id: Uuid,
) -> AppResult<DesktopScriptRunReceipt> {
    state
        .services
        .script
        .run_desktop(operation_id)
        .await
        .map_err(DesktopScriptRunError::into_error)
}

fn require_schema_editor(state: &AppState) -> AppResult<()> {
    if state
        .features
        .is_enabled(crate::features::FeatureFlag::CatalogV2)
        && state
            .features
            .is_enabled(crate::features::FeatureFlag::DdlIrV1)
    {
        Ok(())
    } else {
        Err(AppError::Blocked {
            reason: "the structured schema editor is disabled for this app runtime".into(),
        })
    }
}

#[tauri::command]
pub async fn preview_schema_change(
    state: State<'_, AppState>,
    id: Uuid,
    request: dopedb_protocol::SchemaChangeRequest,
) -> AppResult<dopedb_protocol::DdlPlan> {
    require_schema_editor(&state)?;
    state
        .services
        .schema
        .preview(SchemaChangePreviewRequest {
            connection_id: id,
            request,
        })
        .await
}

#[tauri::command]
pub async fn propose_schema_change(
    state: State<'_, AppState>,
    id: Uuid,
    request: dopedb_protocol::SchemaChangeRequest,
) -> AppResult<SchemaChangeProposalReceipt> {
    require_schema_editor(&state)?;
    state
        .services
        .schema
        .propose(SchemaChangePreviewRequest {
            connection_id: id,
            request,
        })
        .await
        .map_err(DesktopScriptRunError::into_error)
}

#[tauri::command]
pub async fn run_schema_change(
    state: State<'_, AppState>,
    operation_id: Uuid,
) -> AppResult<DesktopScriptRunReceipt> {
    require_schema_editor(&state)?;
    state
        .services
        .schema
        .run(operation_id)
        .await
        .map_err(DesktopScriptRunError::into_error)
}

fn require_erd(state: &AppState) -> AppResult<()> {
    if state
        .features
        .is_enabled(crate::features::FeatureFlag::ErdV1)
    {
        Ok(())
    } else {
        Err(AppError::Blocked {
            reason: "persistent ERD layouts are disabled for this app runtime".into(),
        })
    }
}

#[tauri::command]
pub async fn list_erd_layouts(state: State<'_, AppState>, id: Uuid) -> AppResult<Vec<ErdLayout>> {
    require_erd(&state)?;
    state.services.erd.list(id).await
}

#[tauri::command]
pub async fn save_erd_layout(
    state: State<'_, AppState>,
    request: SaveErdLayoutRequest,
) -> AppResult<SaveErdLayoutOutcome> {
    require_erd(&state)?;
    state.services.erd.save(request).await
}

#[tauri::command]
pub async fn delete_erd_layout(
    state: State<'_, AppState>,
    connection_id: Uuid,
    id: Uuid,
    expected_revision: i64,
) -> AppResult<()> {
    require_erd(&state)?;
    state
        .services
        .erd
        .delete(connection_id, id, expected_revision)
        .await
}

// ── safety settings ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_safety(state: State<'_, AppState>, id: Uuid) -> AppResult<SafetySettings> {
    state.services.safety.get(id).await
}

#[tauri::command]
pub async fn set_safety(
    state: State<'_, AppState>,
    id: Uuid,
    settings: SafetySettings,
) -> AppResult<()> {
    state.services.safety.update(id, settings).await
}

// ── lightweight monitoring access ───────────────────────────────────────────

#[tauri::command]
pub async fn get_monitoring_status(
    state: State<'_, AppState>,
    id: Uuid,
) -> AppResult<MonitoringStatusReceipt> {
    state
        .services
        .monitoring
        .status(id)
        .await
        .map_err(MonitoringServiceError::into_error)
}

/// Persist one immutable fixed-role proposal. The desktop must render its literal
/// SQL and hash before using the separate exact approval command.
#[tauri::command]
pub async fn propose_postgres_monitoring(
    state: State<'_, AppState>,
    id: Uuid,
    enabled: bool,
) -> AppResult<MonitoringProposalReceipt> {
    state
        .services
        .monitoring
        .propose_postgres_role(MonitoringProposalRequest {
            connection_id: id,
            enabled,
        })
        .await
        .map_err(MonitoringServiceError::into_error)
}

/// Consume one exactly approved fixed-role proposal by operation id only.
#[tauri::command]
pub async fn set_postgres_monitoring(
    state: State<'_, AppState>,
    operation_id: Uuid,
) -> AppResult<MonitoringStatusReceipt> {
    state
        .services
        .monitoring
        .run_postgres_role(operation_id)
        .await
        .map_err(MonitoringServiceError::into_error)
}

// ── logs ─────────────────────────────────────────────────────────────────────

/// Verify the hash-chain for a connection's audit log. Returns `{ ok, firstBadIndex }`
/// where `firstBadIndex` is the insertion-order position of the first tampered row.
#[tauri::command]
pub async fn audit_verify(
    state: State<'_, AppState>,
    connection_id: Uuid,
) -> AppResult<AuditVerdict> {
    state.services.activity.verify_audit(connection_id).await
}

/// Fetch the displayed audit rows and verify that exact ordered snapshot in one read.
#[tauri::command]
pub async fn audit_snapshot(
    state: State<'_, AppState>,
    connection_id: Uuid,
) -> AppResult<AuditSnapshotReceipt> {
    state.services.activity.audit_snapshot(connection_id).await
}

#[tauri::command]
pub async fn list_history(state: State<'_, AppState>, id: Uuid) -> AppResult<Vec<HistoryEntry>> {
    state.services.activity.history(id).await
}

// ── Terminal agent discovery + legacy chat archive ────────────────────────────

/// Claude Code / Codex CLI installed + subscription-login status for the
/// connection-pinned Terminal profiles.
#[tauri::command]
pub async fn detect_agent_clis() -> Vec<crate::agent_cli::CliInfo> {
    crate::agent_cli::detect_clis().await
}

/// Read-only archive of conversations created by the retired in-app chat.
#[tauri::command]
pub async fn list_chat_threads(
    state: State<'_, AppState>,
) -> AppResult<Vec<crate::legacy_chat::ChatThread>> {
    state.services.legacy_chat.list_threads().await
}

/// One archived thread's messages, oldest first.
#[tauri::command]
pub async fn get_chat_messages(
    state: State<'_, AppState>,
    thread_id: Uuid,
) -> AppResult<Vec<crate::legacy_chat::ChatMessageRecord>> {
    state.services.legacy_chat.messages(thread_id).await
}

// ── native picker ─────────────────────────────────────────────────────────────

/// Native file picker for a SQLite database path. None means the user cancelled.
#[tauri::command]
pub async fn pick_file(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog()
        .file()
        .blocking_pick_file()
        .and_then(|path| path.into_path().ok())
        .map(|path| path.to_string_lossy().into_owned())
}
