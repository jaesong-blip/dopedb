//! Release-profile packaged benchmark transport.
//!
//! The command is inert in ordinary builds. The feature build uses an isolated
//! application identity/data root, accepts only numeric renderer measurements, emits
//! one bounded JSON line, and exits. It never serializes SQL, rows, prompts, paths, or
//! credentials into the artifact.

use serde::{Deserialize, Serialize};
use tauri::State;

#[cfg(feature = "packaged-benchmark")]
use std::collections::HashMap;
#[cfg(feature = "packaged-benchmark")]
use std::fs::OpenOptions;
#[cfg(feature = "packaged-benchmark")]
use std::time::{Duration, Instant};
#[cfg(feature = "packaged-benchmark")]
use uuid::Uuid;

#[cfg(feature = "packaged-benchmark")]
use futures::TryStreamExt;
#[cfg(feature = "packaged-benchmark")]
use sqlx::Row;
#[cfg(feature = "packaged-benchmark")]
use tauri::Manager;

use crate::error::{AppError, AppResult};
#[cfg(feature = "packaged-benchmark")]
use crate::startup::StartupSummary;
use crate::state::AppState;

#[cfg(not(feature = "packaged-benchmark"))]
const DISABLED: &str = "packaged benchmark transport is disabled";

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RendererMetrics {
    renderer_elapsed_ms: f64,
    react_commit_count: u64,
    react_commit_duration_ms: f64,
    max_react_commit_duration_ms: f64,
    long_task_supported: bool,
    long_task_count: u64,
    max_long_task_ms: f64,
    frame_sample_count: u64,
    frame_over_50_ms_count: u64,
    max_frame_gap_ms: f64,
    ipc_call_count: u64,
    ipc_total_duration_ms: f64,
    viewport_width: u32,
    viewport_height: u32,
    device_pixel_ratio: f64,
    webview_engine: String,
    webview_version: String,
    actions: Vec<ActionMetrics>,
    idle_observation_ms: f64,
    idle_ipc_call_count: u64,
    webview_heap_bytes: Option<u64>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActionMetrics {
    name: String,
    samples_ms: Vec<f64>,
    react_commit_count: u64,
    react_commit_duration_ms: f64,
    max_frame_gap_ms: f64,
    frame_sample_count: u64,
    dropped_frame_count: u64,
    ipc_call_count: u64,
    ipc_duration_ms: f64,
    ipc_payload_bytes: u64,
    sqlite_transaction_count: u64,
    retained_bytes: u64,
    backend_request_to_first_row_ms: Option<f64>,
    backend_first_row_to_ipc_batch_ms: Option<f64>,
    ipc_batch_to_react_commit_ms: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PackagedBenchmarkConfig {
    scenario: String,
    kind: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PackagedBackendReceipt {
    action: String,
    backend_request_to_first_row_ms: Option<f64>,
    backend_first_row_to_ipc_batch_ms: Option<f64>,
    ipc_payload_bytes: u64,
    sqlite_transaction_count: u64,
    retained_bytes: u64,
    row_count: u64,
    columns: Vec<String>,
    rows: Vec<Vec<i64>>,
}

#[cfg(feature = "packaged-benchmark")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PackagedBenchmarkReport<'a> {
    schema_version: u32,
    measurement_scope: &'static str,
    app_version: &'static str,
    scenario: &'a str,
    connection_count: u32,
    startup: StartupSummary,
    renderer: &'a RendererMetrics,
}

#[tauri::command]
pub(crate) async fn packaged_benchmark_config(
    app: tauri::AppHandle,
) -> AppResult<PackagedBenchmarkConfig> {
    #[cfg(not(feature = "packaged-benchmark"))]
    {
        let _ = app;
        Err(AppError::NotFound(DISABLED.into()))
    }
    #[cfg(feature = "packaged-benchmark")]
    {
        let scenario = benchmark_scenario()?;
        let kind = if scenario.starts_with("connections-") {
            "startup"
        } else if WORKLOAD_SCENARIOS.contains(&scenario.as_str()) {
            "workload"
        } else {
            return Err(AppError::Config(
                "packaged benchmark scenario is unsupported".into(),
            ));
        };
        // Every measured process must own a visible paint clock. In particular,
        // repeated cold/warm startup launches can otherwise be left inactive by
        // macOS before the renderer records its first-shell frame.
        focus_benchmark_window(&app).await?;
        Ok(PackagedBenchmarkConfig { scenario, kind })
    }
}

#[tauri::command]
pub(crate) async fn run_packaged_benchmark_backend(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    action: String,
) -> AppResult<PackagedBackendReceipt> {
    #[cfg(not(feature = "packaged-benchmark"))]
    {
        let _ = (state, app, action);
        Err(AppError::NotFound(DISABLED.into()))
    }
    #[cfg(feature = "packaged-benchmark")]
    {
        let scenario = benchmark_scenario()?;
        let allowed = match scenario.as_str() {
            "query-result" => matches!(
                action.as_str(),
                "query-first-batch"
                    | "query-page-store-1m"
                    | "query-start-cancellable-export"
                    | "query-cancel"
                    | "query-export"
            ),
            "table-first-row" => action == "table-first-page",
            "agent-transcript" => action == "agent-stream-10k",
            "agent-tools" => action == "agent-skill-reload",
            "long-lived-data" => matches!(
                action.as_str(),
                "history-10k" | "audit-100k" | "local-history-50" | "dashboard-multi-tile"
            ),
            _ => false,
        };
        if !allowed {
            return Err(AppError::Config(
                "packaged benchmark action does not match its scenario".into(),
            ));
        }
        let needs_focus_recovery = action == "query-page-store-1m";
        if needs_focus_recovery {
            focus_benchmark_window(&app).await?;
        }
        benchmark_progress(&action, "start")?;
        let receipt = if matches!(
            action.as_str(),
            "query-page-store-1m"
                | "query-start-cancellable-export"
                | "query-cancel"
                | "query-export"
        ) {
            let action_for_worker = action.clone();
            let metric = tokio::task::spawn_blocking(move || {
                crate::features::queries::run_packaged_result_store_benchmark(&action_for_worker)
            })
            .await
            .map_err(|_| AppError::Config("packaged result worker stopped".into()))??;
            packaged_result_receipt(action.clone(), metric)?
        } else if action == "agent-stream-10k" {
            packaged_agent_receipt(state.packaged_benchmark_store(), action.clone()).await?
        } else if action == "agent-skill-reload" {
            let action_for_worker = action.clone();
            tokio::task::spawn_blocking(move || packaged_skill_reload_receipt(action_for_worker))
                .await
                .map_err(|_| AppError::Config("packaged Skill reload worker stopped".into()))??
        } else {
            packaged_read_receipt(state.packaged_benchmark_store(), action.clone()).await?
        };
        benchmark_progress(&action, "complete")?;
        if needs_focus_recovery {
            focus_benchmark_window(&app).await?;
        }
        Ok(receipt)
    }
}

#[tauri::command]
pub(crate) async fn complete_packaged_benchmark(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    metrics: RendererMetrics,
) -> AppResult<()> {
    #[cfg(not(feature = "packaged-benchmark"))]
    {
        let _ = (state, app, metrics);
        Err(AppError::NotFound(DISABLED.into()))
    }
    #[cfg(feature = "packaged-benchmark")]
    {
        validate_metrics(&metrics)?;
        state.wait_for_post_paint_recovery().await?;
        let scenario = benchmark_scenario()?;
        let connection_count = benchmark_connection_count()?;
        let report = PackagedBenchmarkReport {
            schema_version: 2,
            measurement_scope: "packaged_release_user_journeys",
            app_version: env!("CARGO_PKG_VERSION"),
            scenario: &scenario,
            connection_count,
            startup: state.startup_trace.summary(),
            renderer: &metrics,
        };
        let payload = serde_json::to_string(&report)?;
        if payload.len() > 64 * 1024 {
            return Err(AppError::Config(
                "packaged benchmark report is too large".into(),
            ));
        }
        println!("DOPEDB_PACKAGED_BENCHMARK:{payload}");
        use std::io::Write;
        std::io::stdout().flush()?;
        app.exit(0);
        Ok(())
    }
}

#[tauri::command]
pub(crate) fn fail_packaged_benchmark(
    app: tauri::AppHandle,
    phase: String,
    reason: String,
) -> AppResult<()> {
    #[cfg(not(feature = "packaged-benchmark"))]
    {
        let _ = (app, phase, reason);
        Err(AppError::NotFound(DISABLED.into()))
    }
    #[cfg(feature = "packaged-benchmark")]
    {
        if phase != "scenario-setup" && !ACTION_NAMES.contains(&phase.as_str()) {
            return Err(AppError::Config(
                "packaged benchmark failure phase is invalid".into(),
            ));
        }
        if !matches!(
            reason.as_str(),
            "surface_unavailable"
                | "paint_timeout"
                | "backend_command"
                | "type_error"
                | "range_error"
                | "unexpected"
        ) {
            return Err(AppError::Config(
                "packaged benchmark failure reason is invalid".into(),
            ));
        }
        let payload = serde_json::to_string(&serde_json::json!({
            "schemaVersion": 2,
            "phase": phase,
            "reason": reason,
        }))?;
        println!("DOPEDB_PACKAGED_BENCHMARK_FAILURE:{payload}");
        use std::io::Write;
        std::io::stdout().flush()?;
        app.exit(2);
        Ok(())
    }
}

#[cfg(feature = "packaged-benchmark")]
pub(crate) fn prepare_fixture_if_requested() -> AppResult<bool> {
    let Some(raw) = std::env::var_os("DOPEDB_PACKAGED_BENCHMARK_PREPARE_CONNECTIONS") else {
        return Ok(false);
    };
    let raw = raw
        .to_str()
        .ok_or_else(|| AppError::Config("benchmark connection count is invalid".into()))?;
    let count = parse_connection_count(raw)?;
    tauri::async_runtime::block_on(async move {
        let store = crate::store::Store::open().await?;
        prepare_connections(&store, count).await?;
        let fixture_kind = benchmark_fixture_kind()?;
        match fixture_kind {
            "standard" => {}
            "table-data" if count == 20 => prepare_table_data(&store).await?,
            "long-lived" if count == 20 => prepare_long_lived_data(&store).await?,
            "recovery" if count == 20 => prepare_recovery_data(&store).await?,
            "table-data" | "long-lived" | "recovery" => {
                return Err(AppError::Config(
                    "dense benchmark fixtures require 20 connections".into(),
                ));
            }
            _ => {
                return Err(AppError::Config(
                    "packaged benchmark fixture kind is invalid".into(),
                ));
            }
        }
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(store.pool())
            .await?;
        store.pool().close().await;
        Ok::<(), AppError>(())
    })?;
    println!(
        "DOPEDB_PACKAGED_BENCHMARK_FIXTURE:{}",
        serde_json::json!({
            "schemaVersion": 1,
            "connectionCount": count,
            "fixtureKind": benchmark_fixture_kind()?,
        })
    );
    Ok(true)
}

#[cfg(feature = "packaged-benchmark")]
fn benchmark_fixture_kind() -> AppResult<&'static str> {
    match std::env::var("DOPEDB_PACKAGED_BENCHMARK_FIXTURE_KIND")
        .unwrap_or_else(|_| "standard".into())
        .as_str()
    {
        "standard" => Ok("standard"),
        "table-data" => Ok("table-data"),
        "long-lived" => Ok("long-lived"),
        "recovery" => Ok("recovery"),
        _ => Err(AppError::Config(
            "packaged benchmark fixture kind is invalid".into(),
        )),
    }
}

#[cfg(feature = "packaged-benchmark")]
async fn prepare_connections(store: &crate::store::Store, count: usize) -> AppResult<()> {
    use crate::model::{
        ConnectionProfile, Engine, Provider, WorkspaceConnectionAccess, WorkspaceCredentialMode,
    };

    let root = crate::app_paths::data_root()?;
    for index in 0..count {
        let database = root.join(format!("fixture-{index:02}.sqlite"));
        OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&database)?;
        let profile = ConnectionProfile {
            id: Uuid::from_u128(0xbed0_0000_0000_0000_0000_0000_0000_0000 + index as u128 + 1),
            name: format!("Benchmark {:02}", index + 1),
            engine: Engine::Sqlite,
            provider: Provider::Generic,
            driver_id: None,
            host: String::new(),
            port: 0,
            database: database.to_string_lossy().into_owned(),
            username: String::new(),
            sslmode: "disable".into(),
            extra_params: HashMap::new(),
            readonly_default: true,
            allow_writes: false,
            secret_ref: None,
            env: Some(if index % 5 == 0 { "staging" } else { "dev" }.into()),
            schema_group: None,
            workspace_access: WorkspaceConnectionAccess::Local,
            credential_mode: WorkspaceCredentialMode::Local,
            provider_target: None,
        };
        store.upsert_connection(&profile).await?;
    }
    Ok(())
}

#[cfg(feature = "packaged-benchmark")]
async fn prepare_table_data(store: &crate::store::Store) -> AppResult<()> {
    sqlx::query(
        r#"WITH digits(d) AS (VALUES(0),(1),(2),(3),(4),(5),(6),(7),(8),(9)),
           numbers(n) AS (SELECT a.d + 10*b.d FROM digits a, digits b)
           INSERT INTO query_history
             (id, connection_id, account_scope, sql, kind, status, row_count,
              duration_ms, error, executed_at, origin)
           SELECT printf('benchmark-table-page-%03d', n),
                  'bed00000-0000-0000-0000-000000000001', 'personal',
                  printf('SELECT %d /* table page */', n), 'read', 'ok', 1,
                  n % 10, NULL, printf('2026-01-01T00:00:%02dZ', n % 60), 'manual'
           FROM numbers"#,
    )
    .execute(store.pool())
    .await?;
    Ok(())
}

#[cfg(feature = "packaged-benchmark")]
async fn prepare_long_lived_data(store: &crate::store::Store) -> AppResult<()> {
    use sha2::{Digest, Sha256};

    const WORKSPACE_ID: &str = "00000000-0000-0000-0000-000000000001";
    const CONNECTION_ID: &str = "bed00000-0000-0000-0000-000000000001";
    const DOCUMENT_ID: &str = "bed00000-0000-0000-0000-00000000d0c0";
    let mut transaction = store.pool().begin().await?;
    sqlx::query(
        r#"WITH digits(d) AS (VALUES(0),(1),(2),(3),(4),(5),(6),(7),(8),(9)),
           numbers(n) AS (
             SELECT a.d + 10*b.d + 100*c.d + 1000*d.d
             FROM digits a, digits b, digits c, digits d
           )
           INSERT INTO query_history
             (id, connection_id, account_scope, sql, kind, status, row_count,
              duration_ms, error, executed_at, origin)
           SELECT printf('benchmark-history-%05d', n),
                  'bed00000-0000-0000-0000-000000000001', 'personal',
                  printf('SELECT %d /* packaged benchmark */', n), 'read', 'ok', 1,
                  n % 100, NULL, printf('2026-01-01T00:%06dZ', n), 'manual'
           FROM numbers"#,
    )
    .execute(&mut *transaction)
    .await?;
    sqlx::query(
        r#"WITH digits(d) AS (VALUES(0),(1),(2),(3),(4),(5),(6),(7),(8),(9)),
           numbers(n) AS (
             SELECT a.d + 10*b.d + 100*c.d + 1000*d.d + 10000*e.d
             FROM digits a, digits b, digits c, digits d, digits e
           )
           INSERT INTO audit_log
             (id, connection_id, ts, engine, agent_prompt, sql, kind, action,
              approved_by, affected_estimate, error, prev_hash, hash)
           SELECT printf('benchmark-audit-%06d', n),
                  'bed00000-0000-0000-0000-000000000001',
                  printf('2026-01-01T01:%06dZ', n), 'sqlite',
                  printf('synthetic prompt %d', n),
                  printf('SELECT %d /* packaged benchmark */', n),
                  'read', 'execute', NULL, 1, NULL,
                  CASE WHEN n = 0 THEN NULL ELSE printf('%064x', n) END,
                  printf('%064x', n + 1)
           FROM numbers"#,
    )
    .execute(&mut *transaction)
    .await?;
    sqlx::query(
        r#"INSERT INTO sql_documents
          (id, workspace_id, account_scope, connection_id, title, dialect,
           selected_database, selected_schema, resolve_mode, content, local_revision,
           dirty, sync_status, created_at, updated_at)
         VALUES (?1, ?2, 'personal', ?3, 'Benchmark', 'sqlite', 'benchmark',
                 NULL, 'playground', '', 50, 0, 'local', ?4, ?4)"#,
    )
    .bind(DOCUMENT_ID)
    .bind(WORKSPACE_ID)
    .bind(CONNECTION_ID)
    .bind("2026-01-01T00:00:00Z")
    .execute(&mut *transaction)
    .await?;
    let revision_content = format!("SELECT '{}';", "r".repeat(1024 * 1024 - 10));
    let revision_hash = hex::encode(Sha256::digest(revision_content.as_bytes()));
    for revision in 1_i64..=50 {
        sqlx::query(
            r#"INSERT INTO sql_document_revisions
              (document_id, local_revision, content_hash, content, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)"#,
        )
        .bind(DOCUMENT_ID)
        .bind(revision)
        .bind(&revision_hash)
        .bind(&revision_content)
        .bind(format!("2026-01-01T00:00:{revision:02}Z"))
        .execute(&mut *transaction)
        .await?;
    }
    for tile in 0_i64..8 {
        sqlx::query(
            r#"INSERT INTO dashboards
              (id, connection_id, title, description, sql, visualization_json,
               workspace_id, revision, sync_status, state, created_at, updated_at)
             VALUES (?1, ?2, ?3, '', ?4, ?5, ?6, 1, 'local', 'published', ?7, ?7)"#,
        )
        .bind(format!("bed00000-0000-0000-0000-00000000da{tile:02}"))
        .bind(CONNECTION_ID)
        .bind(format!("Benchmark tile {tile}"))
        .bind(format!("SELECT {tile}"))
        .bind(r#"{"schemaVersion":1,"kind":"table","xColumn":null,"yColumns":[]}"#)
        .bind(WORKSPACE_ID)
        .bind(format!("2026-01-01T00:01:{tile:02}Z"))
        .execute(&mut *transaction)
        .await?;
    }
    transaction.commit().await?;
    Ok(())
}

#[cfg(feature = "packaged-benchmark")]
async fn prepare_recovery_data(store: &crate::store::Store) -> AppResult<()> {
    use dopedb_protocol::{ObjectKind, ObjectRef};
    use serde_json::json;

    use crate::features::jobs::domain::JobConsistency;
    use crate::features::jobs::{JobFormat, JobPlan};
    use crate::kernel::identity::JobFileCapabilityId;

    const WORKSPACE_ID: &str = "00000000-0000-0000-0000-000000000001";
    const CONNECTION_ID: &str = "bed00000-0000-0000-0000-000000000001";
    const OLD_RUNTIME_ID: &str = "bed00000-0000-0000-0000-00000000f001";
    const READ_OPERATION_ID: &str = "bed00000-0000-0000-0000-000000000a01";
    const EXPORT_OPERATION_ID: &str = "bed00000-0000-0000-0000-000000000a02";
    const JOB_ID: &str = "bed00000-0000-0000-0000-000000000b01";
    const NOW: &str = "2026-01-01T00:00:00Z";

    let export_plan = JobPlan::Export {
        capability_id: JobFileCapabilityId::from(Uuid::from_u128(
            0xbed0_0000_0000_0000_0000_0000_0000_d001,
        )),
        relation: ObjectRef {
            catalog: Some("benchmark".into()),
            namespace: Some("main".into()),
            name: "fixture".into(),
            kind: ObjectKind::Table,
            native_id: None,
        },
        consistency: JobConsistency::PerBatchCurrent,
        columns: Vec::new(),
        field_names: Vec::new(),
        batch_size: 256,
    };
    let plan_value = serde_json::to_value(&export_plan)?;
    let plan_json = serde_json::to_string(&plan_value)?;
    let plan_hash = crate::operations::canonical_hash(&plan_value)?;
    let operation_payloads = [
        (
            READ_OPERATION_ID,
            "read_query",
            "benchmark-read-recovery",
            json!({}),
        ),
        (
            EXPORT_OPERATION_ID,
            "export",
            "benchmark-export-recovery",
            json!({
                "format": JobFormat::Csv,
                "inputInspection": null,
                "jobId": JOB_ID,
                "plan": plan_value,
                "planHash": plan_hash,
                "sourceSha256": null,
                "sqlAudit": null,
            }),
        ),
    ];
    let mut transaction = store.pool().begin().await?;
    for (id, operation_kind, idempotency_key, payload) in operation_payloads {
        let payload_json = crate::operations::canonical_json(&payload)?;
        let payload_hash = crate::operations::canonical_hash(&payload)?;
        sqlx::query(
            r#"INSERT INTO operations
              (id, runtime_id, workspace_id, account_scope, connection_id,
               connection_revision, terminal_session_id, actor_kind, actor_id,
               actor_provenance_json, operation_kind, payload_schema_version,
               payload_json, payload_hash, schema_fingerprint, risk_level, preview_json,
               policy_snapshot_json, policy_revision, state, single_use, idempotency_key,
               expires_at, started_at, finished_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'personal', ?4, 1, NULL, 'system', 'benchmark',
                     '{"originSurface":"benchmark"}', ?5, 1, ?6, ?7, NULL,
                     'low', '{}', '{}', 'benchmark-v1', 'executing', 1, ?8,
                     NULL, ?9, NULL, ?9, ?9)"#,
        )
        .bind(id)
        .bind(OLD_RUNTIME_ID)
        .bind(WORKSPACE_ID)
        .bind(CONNECTION_ID)
        .bind(operation_kind)
        .bind(payload_json)
        .bind(payload_hash)
        .bind(idempotency_key)
        .bind(NOW)
        .execute(&mut *transaction)
        .await?;
    }
    sqlx::query(
        r#"INSERT INTO jobs
          (id, operation_id, workspace_id, account_scope, connection_id, kind, format,
           plan_json, plan_hash, state, source_summary, target_summary, resumable,
           pause_requested, created_at, started_at, updated_at)
         VALUES (?1, ?2, ?3, 'personal', ?4, 'export', 'csv', ?5, ?6,
                 'running', 'synthetic source', 'synthetic target', 0, 0, ?7, ?7, ?7)"#,
    )
    .bind(JOB_ID)
    .bind(EXPORT_OPERATION_ID)
    .bind(WORKSPACE_ID)
    .bind(CONNECTION_ID)
    .bind(plan_json)
    .bind(&plan_hash)
    .bind(NOW)
    .execute(&mut *transaction)
    .await?;
    sqlx::query(
        r#"INSERT INTO agent_acp_sessions
          (id, connection_id, workspace_id, account_scope, provider, title, lifecycle,
           acp_session_id, error, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'personal', 'codex', 'Benchmark recovery', 'running',
                 'benchmark-resume', NULL, ?4, ?4)"#,
    )
    .bind("bed00000-0000-0000-0000-000000000c01")
    .bind(CONNECTION_ID)
    .bind(WORKSPACE_ID)
    .bind(NOW)
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(())
}

#[cfg(feature = "packaged-benchmark")]
fn benchmark_scenario() -> AppResult<String> {
    let value = std::env::var("DOPEDB_PACKAGED_BENCHMARK_SCENARIO")
        .map_err(|_| AppError::Config("benchmark scenario is required".into()))?;
    let valid = !value.is_empty()
        && value.len() <= 96
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
    if !valid {
        return Err(AppError::Config("benchmark scenario is invalid".into()));
    }
    Ok(value)
}

#[cfg(feature = "packaged-benchmark")]
fn benchmark_connection_count() -> AppResult<u32> {
    let value = std::env::var("DOPEDB_PACKAGED_BENCHMARK_CONNECTIONS")
        .map_err(|_| AppError::Config("benchmark connection count is required".into()))?;
    u32::try_from(parse_connection_count(&value)?)
        .map_err(|_| AppError::Config("benchmark connection count is invalid".into()))
}

#[cfg(feature = "packaged-benchmark")]
fn parse_connection_count(value: &str) -> AppResult<usize> {
    match value {
        "0" => Ok(0),
        "5" => Ok(5),
        "20" => Ok(20),
        _ => Err(AppError::Config(
            "benchmark connection count must be 0, 5, or 20".into(),
        )),
    }
}

#[cfg(feature = "packaged-benchmark")]
fn validate_metrics(metrics: &RendererMetrics) -> AppResult<()> {
    let durations = [
        metrics.renderer_elapsed_ms,
        metrics.react_commit_duration_ms,
        metrics.max_react_commit_duration_ms,
        metrics.max_long_task_ms,
        metrics.max_frame_gap_ms,
        metrics.ipc_total_duration_ms,
        metrics.idle_observation_ms,
    ];
    let counts = [
        metrics.react_commit_count,
        metrics.long_task_count,
        metrics.frame_sample_count,
        metrics.frame_over_50_ms_count,
        metrics.ipc_call_count,
        metrics.idle_ipc_call_count,
    ];
    if durations
        .iter()
        .any(|value| !value.is_finite() || *value < 0.0 || *value > 600_000.0)
        || counts.iter().any(|value| *value > 10_000_000)
        || !(1..=16_384).contains(&metrics.viewport_width)
        || !(1..=16_384).contains(&metrics.viewport_height)
        || !metrics.device_pixel_ratio.is_finite()
        || !(0.25..=16.0).contains(&metrics.device_pixel_ratio)
        || !matches!(
            metrics.webview_engine.as_str(),
            "webkit" | "webview2" | "unknown"
        )
        || !safe_version(&metrics.webview_version)
        || metrics.actions.len() > 64
        || metrics
            .actions
            .iter()
            .any(|measurement| !valid_action_metrics(measurement))
        || metrics
            .webview_heap_bytes
            .is_some_and(|bytes| bytes > 64 * 1024 * 1024 * 1024)
    {
        return Err(AppError::Config(
            "packaged benchmark renderer metrics are invalid".into(),
        ));
    }
    Ok(())
}

#[cfg(feature = "packaged-benchmark")]
fn packaged_result_receipt(
    action: String,
    metric: crate::features::queries::PackagedResultStoreMetric,
) -> AppResult<PackagedBackendReceipt> {
    let first_to_batch = metric
        .first_row_ms
        .map(|first| (metric.elapsed_ms - first).max(0.0));
    Ok(PackagedBackendReceipt {
        action,
        backend_request_to_first_row_ms: metric.first_row_ms,
        backend_first_row_to_ipc_batch_ms: first_to_batch,
        ipc_payload_bytes: metric.encoded_bytes,
        sqlite_transaction_count: metric.transaction_count,
        retained_bytes: metric.retained_bytes,
        row_count: metric.row_count,
        columns: Vec::new(),
        rows: Vec::new(),
    })
}

#[cfg(feature = "packaged-benchmark")]
fn packaged_skill_reload_receipt(action: String) -> AppResult<PackagedBackendReceipt> {
    use dopedb_protocol::{SkillInstallState, SkillTargetSelection};

    // Recreate the manager from the process home instead of reusing AppState.
    // This exercises the same embedded bundle + disk inventory boundary that a
    // clean app restart uses, without weakening the production command surface.
    let manager = crate::skills::SkillManager::new()?;
    let status = manager.status(SkillTargetSelection::All)?;
    if status.targets.len() != 2
        || status
            .targets
            .iter()
            .any(|target| target.state != SkillInstallState::ManagedCurrent)
        || status.targets.iter().any(|target| {
            target.installed_revision != Some(status.skill.release_revision)
                || target.installed_package_digest.as_deref()
                    != Some(status.skill.package_digest.as_str())
        })
    {
        return Err(AppError::Config(
            "packaged Skill inventory did not survive manager recreation".into(),
        ));
    }
    Ok(PackagedBackendReceipt {
        action,
        backend_request_to_first_row_ms: None,
        backend_first_row_to_ipc_batch_ms: None,
        ipc_payload_bytes: 0,
        sqlite_transaction_count: 0,
        retained_bytes: 0,
        row_count: u64::try_from(status.targets.len())
            .map_err(|_| AppError::Config("packaged Skill target count is invalid".into()))?,
        columns: Vec::new(),
        rows: Vec::new(),
    })
}

#[cfg(feature = "packaged-benchmark")]
async fn packaged_agent_receipt(
    store: &crate::store::Store,
    action: String,
) -> AppResult<PackagedBackendReceipt> {
    use crate::features::agents::domain::{
        AcpSessionEvent, AcpSessionEventPayload, AcpSessionLifecycle, AcpSessionSummary,
        AgentProvider,
    };
    use crate::kernel::identity::{AcpSessionId, ConnectionId};

    const EVENT_COUNT: u64 = 10_000;
    const BATCH_EVENTS: u64 = 64;
    let session_id = AcpSessionId::from(Uuid::from_u128(0xbed0_0000_0000_0000_0000_0000_0000_ac10));
    let connection_id =
        ConnectionId::from(Uuid::from_u128(0xbed0_0000_0000_0000_0000_0000_0000_0001));
    let created_at = chrono::DateTime::from_timestamp(1_767_225_600, 0)
        .ok_or_else(|| AppError::Config("packaged Agent timestamp is invalid".into()))?;
    let summary = AcpSessionSummary {
        id: session_id,
        connection_id,
        provider: AgentProvider::Codex,
        title: "Packaged benchmark".into(),
        lifecycle: AcpSessionLifecycle::Running,
        acp_session_id: Some("packaged-benchmark-session".into()),
        knowledge_grant_id: None,
        project_environment_id: None,
        environment_revision: None,
        graph_revision_ids: Vec::new(),
        environment_connections: Vec::new(),
        error: None,
        created_at,
        updated_at: created_at + chrono::Duration::minutes(10),
    };
    let scope = store.active_resource_scope().await?;
    let started = Instant::now();
    let mut first_batch_ms = None;
    let mut transaction_count = 0_u64;
    for first_sequence in (1..=EVENT_COUNT).step_by(BATCH_EVENTS as usize) {
        let last_sequence = (first_sequence + BATCH_EVENTS - 1).min(EVENT_COUNT);
        let events = (first_sequence..=last_sequence)
            .map(|sequence| AcpSessionEvent {
                session_id,
                sequence,
                created_at: created_at + chrono::Duration::milliseconds(sequence as i64 * 60),
                payload: AcpSessionEventPayload::SessionUpdate {
                    update: serde_json::json!({
                        "sessionUpdate": "agent_message_chunk",
                        "messageId": "packaged-benchmark-message",
                        "content": { "type": "text", "text": sequence % 10 },
                    }),
                },
            })
            .collect::<Vec<_>>();
        store
            .persist_agent_acp_events(&scope, &summary, &events)
            .await?;
        transaction_count = transaction_count.saturating_add(1);
        first_batch_ms.get_or_insert_with(|| benchmark_elapsed_ms(started));
    }
    let retained_bytes: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(length(CAST(payload AS BLOB))), 0) \
         FROM agent_acp_events WHERE session_id = ?1",
    )
    .bind(session_id.to_string())
    .fetch_one(store.pool())
    .await?;
    let elapsed = benchmark_elapsed_ms(started);
    Ok(PackagedBackendReceipt {
        action,
        backend_request_to_first_row_ms: first_batch_ms,
        backend_first_row_to_ipc_batch_ms: first_batch_ms.map(|first| (elapsed - first).max(0.0)),
        ipc_payload_bytes: 0,
        sqlite_transaction_count: transaction_count,
        retained_bytes: u64::try_from(retained_bytes).map_err(|_| {
            AppError::Config("packaged Agent retained byte count is invalid".into())
        })?,
        row_count: EVENT_COUNT,
        columns: Vec::new(),
        rows: Vec::new(),
    })
}

#[cfg(feature = "packaged-benchmark")]
fn benchmark_elapsed_ms(started: Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1_000.0
}

#[cfg(feature = "packaged-benchmark")]
async fn packaged_read_receipt(
    store: &crate::store::Store,
    action: String,
) -> AppResult<PackagedBackendReceipt> {
    let (statement, expected_rows, page_limit) = match action.as_str() {
        "query-first-batch" => (
            "WITH RECURSIVE counter(value) AS ( \
                 SELECT 0 UNION ALL SELECT value + 1 FROM counter WHERE value < 255 \
             ) SELECT value, value % 1000, value % 17 FROM counter",
            256_u64,
            256_usize,
        ),
        "table-first-page" => (
            "SELECT rowid, COALESCE(duration_ms, 0), COALESCE(row_count, 0) \
             FROM query_history ORDER BY executed_at DESC, rowid DESC LIMIT 100",
            100_u64,
            100_usize,
        ),
        "history-10k" => (
            "SELECT rowid, COALESCE(duration_ms, 0), COALESCE(row_count, 0) \
             FROM query_history ORDER BY executed_at DESC, rowid DESC LIMIT 101",
            10_000,
            101,
        ),
        "audit-100k" => (
            "SELECT rowid, COALESCE(affected_estimate, 0), length(sql) \
             FROM audit_log ORDER BY rowid DESC LIMIT 51",
            100_000,
            51,
        ),
        "local-history-50" => (
            "SELECT local_revision, length(content), 0 \
             FROM sql_document_revisions ORDER BY local_revision DESC LIMIT 21",
            50,
            21,
        ),
        "dashboard-multi-tile" => (
            "SELECT revision, length(sql), length(visualization_json) \
             FROM dashboards WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 8",
            8,
            8,
        ),
        _ => {
            return Err(AppError::Config(
                "unsupported packaged SQLite action".into(),
            ))
        }
    };
    let started = Instant::now();
    let mut stream = sqlx::query(statement).fetch(store.pool());
    let first = stream
        .try_next()
        .await?
        .ok_or_else(|| AppError::Config("packaged SQLite fixture is empty".into()))?;
    let first_row_ms = started.elapsed().as_secs_f64() * 1_000.0;
    let mut rows = vec![numeric_row(&first)?];
    while rows.len() < page_limit {
        let Some(row) = stream.try_next().await? else {
            break;
        };
        rows.push(numeric_row(&row)?);
    }
    drop(stream);
    let encoded = serde_json::to_vec(&rows)?;
    let elapsed = started.elapsed().as_secs_f64() * 1_000.0;
    Ok(PackagedBackendReceipt {
        action,
        backend_request_to_first_row_ms: Some(first_row_ms),
        backend_first_row_to_ipc_batch_ms: Some((elapsed - first_row_ms).max(0.0)),
        ipc_payload_bytes: encoded.len() as u64,
        sqlite_transaction_count: 1,
        retained_bytes: encoded.len() as u64,
        row_count: expected_rows,
        columns: vec!["metric_a".into(), "metric_b".into(), "metric_c".into()],
        rows,
    })
}

#[cfg(feature = "packaged-benchmark")]
fn numeric_row(row: &sqlx::sqlite::SqliteRow) -> AppResult<Vec<i64>> {
    Ok(vec![row.try_get(0)?, row.try_get(1)?, row.try_get(2)?])
}

#[cfg(feature = "packaged-benchmark")]
const WORKLOAD_SCENARIOS: [&str; 9] = [
    "sql-editor",
    "explorer-search",
    "query-result",
    "table-first-row",
    "agent-transcript",
    "agent-tools",
    "long-lived-data",
    "interaction-surfaces",
    "idle-runtime",
];

#[cfg(feature = "packaged-benchmark")]
const ACTION_NAMES: [&str; 35] = [
    "sql-editor-10k-type",
    "sql-editor-10k-cursor",
    "sql-editor-10k-format",
    "sql-editor-10k-run",
    "sql-editor-100k-type",
    "sql-editor-100k-cursor",
    "sql-editor-100k-format",
    "sql-editor-100k-run",
    "sql-editor-1m-type",
    "sql-editor-1m-cursor",
    "sql-editor-1m-format",
    "sql-editor-1m-run",
    "explorer-first-expand",
    "explorer-secondary-expand",
    "search-everywhere",
    "query-first-batch",
    "query-grid-scroll-50k",
    "query-page-store-1m",
    "query-cancel",
    "query-export",
    "table-first-page",
    "agent-stream-10k",
    "agent-manual-scroll",
    "agent-permission",
    "agent-reconnect",
    "agent-skill-install-all",
    "agent-skill-reload",
    "agent-skill-remove-all",
    "history-10k",
    "audit-100k",
    "local-history-50",
    "dashboard-multi-tile",
    "erd-drag-1k",
    "grid-and-pane-resize",
    "workbench-scroll-continuity",
];

#[cfg(feature = "packaged-benchmark")]
fn valid_action_metrics(measurement: &ActionMetrics) -> bool {
    let durations_valid = measurement.samples_ms.len() <= 128
        && measurement
            .samples_ms
            .iter()
            .all(|value| value.is_finite() && *value >= 0.0 && *value <= 600_000.0)
        && [
            measurement.react_commit_duration_ms,
            measurement.max_frame_gap_ms,
            measurement.ipc_duration_ms,
        ]
        .iter()
        .all(|value| value.is_finite() && *value >= 0.0 && *value <= 600_000.0)
        && [
            measurement.backend_request_to_first_row_ms,
            measurement.backend_first_row_to_ipc_batch_ms,
            measurement.ipc_batch_to_react_commit_ms,
        ]
        .iter()
        .flatten()
        .all(|value| value.is_finite() && *value >= 0.0 && *value <= 600_000.0);
    let counts_valid = [
        measurement.react_commit_count,
        measurement.frame_sample_count,
        measurement.dropped_frame_count,
        measurement.ipc_call_count,
        measurement.sqlite_transaction_count,
    ]
    .iter()
    .all(|value| *value <= 100_000_000)
        && measurement.ipc_payload_bytes <= 16 * 1024 * 1024 * 1024
        && measurement.retained_bytes <= 64 * 1024 * 1024 * 1024;
    ACTION_NAMES.contains(&measurement.name.as_str()) && durations_valid && counts_valid
}

#[cfg(feature = "packaged-benchmark")]
fn safe_version(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

#[cfg(feature = "packaged-benchmark")]
fn benchmark_progress(action: &str, status: &str) -> AppResult<()> {
    let payload = serde_json::to_string(&serde_json::json!({
        "action": action,
        "status": status,
    }))?;
    println!("DOPEDB_PACKAGED_BENCHMARK_PROGRESS:{payload}");
    use std::io::Write;
    std::io::stdout().flush()?;
    Ok(())
}

#[cfg(feature = "packaged-benchmark")]
async fn focus_benchmark_window(app: &tauri::AppHandle) -> AppResult<()> {
    #[cfg(target_os = "macos")]
    {
        let (activation_sent, activation_received) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let activated = if let Some(main_thread) = objc2::MainThreadMarker::new() {
                let application = objc2_app_kit::NSApplication::sharedApplication(main_thread);
                // Directly launching the bundle executable repeatedly can leave the
                // next process visible but inactive after its predecessor exits.
                // WKWebView then suspends requestAnimationFrame and produces a false
                // paint timeout.
                #[allow(deprecated)]
                application.activateIgnoringOtherApps(true);
                true
            } else {
                false
            };
            let _ = activation_sent.send(activated);
        })
        .map_err(|_| AppError::Config("packaged benchmark app could not be activated".into()))?;
        let activated = tokio::time::timeout(Duration::from_secs(5), activation_received)
            .await
            .map_err(|_| AppError::Config("packaged benchmark activation timed out".into()))?
            .map_err(|_| AppError::Config("packaged benchmark activation stopped".into()))?;
        if !activated {
            return Err(AppError::Config(
                "packaged benchmark activation left the main thread".into(),
            ));
        }
    }
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| AppError::Config("packaged benchmark window is unavailable".into()))?;
    window
        .show()
        .map_err(|_| AppError::Config("packaged benchmark window could not be shown".into()))?;
    window
        .set_focus()
        .map_err(|_| AppError::Config("packaged benchmark window could not be focused".into()))?;
    Ok(())
}
