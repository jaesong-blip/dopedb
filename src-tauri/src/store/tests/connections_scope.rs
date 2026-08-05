//! Store migration, shared connection binding, and catalog scope-isolation tests.

use super::fixtures::*;

async fn assert_legacy_sql_document_database_scope_migrates() {
    let legacy_pool = memory_pool().await;
    sqlx::raw_sql(
        "CREATE TABLE connections (
             id TEXT PRIMARY KEY,
             db_name TEXT NOT NULL
         );
         CREATE TABLE sql_documents (
             id TEXT PRIMARY KEY,
             connection_id TEXT NOT NULL REFERENCES connections(id)
         );
         INSERT INTO connections (id, db_name) VALUES ('connection-1', 'analytics');
         INSERT INTO sql_documents (id, connection_id)
         VALUES ('document-1', 'connection-1');",
    )
    .execute(&legacy_pool)
    .await
    .unwrap();
    super::super::bootstrap::add_sql_document_database_scope(&legacy_pool)
        .await
        .unwrap();
    let selected_database: String =
        sqlx::query_scalar("SELECT selected_database FROM sql_documents WHERE id = 'document-1'")
            .fetch_one(&legacy_pool)
            .await
            .unwrap();
    assert_eq!(selected_database, "analytics");
}

async fn assert_legacy_agent_acp_provider_migrates() {
    let legacy_pool = memory_pool().await;
    sqlx::raw_sql(
        "CREATE TABLE agent_acp_sessions (
             id TEXT PRIMARY KEY,
             connection_id TEXT NOT NULL,
             workspace_id TEXT NOT NULL,
             account_scope TEXT NOT NULL,
             provider TEXT NOT NULL CHECK(provider IN ('codex')),
             title TEXT NOT NULL,
             lifecycle TEXT NOT NULL,
             acp_session_id TEXT,
             error TEXT,
             created_at TEXT NOT NULL,
             updated_at TEXT NOT NULL
         );
         CREATE TABLE agent_acp_events (
             session_id TEXT NOT NULL REFERENCES agent_acp_sessions(id) ON DELETE CASCADE,
             sequence INTEGER NOT NULL CHECK(sequence > 0),
             created_at TEXT NOT NULL,
             payload TEXT NOT NULL,
             PRIMARY KEY(session_id, sequence)
         );
         CREATE INDEX idx_agent_acp_sessions_scope
             ON agent_acp_sessions(workspace_id, account_scope, updated_at DESC);
         CREATE INDEX idx_agent_acp_events_session
             ON agent_acp_events(session_id, sequence);
         INSERT INTO agent_acp_sessions
             (id, connection_id, workspace_id, account_scope, provider, title,
              lifecycle, created_at, updated_at)
         VALUES
             ('codex-session', 'connection-1', 'workspace-1', 'personal',
              'codex', 'Existing session', 'ready', '2026-07-30', '2026-07-30');
         INSERT INTO agent_acp_events
             (session_id, sequence, created_at, payload)
         VALUES ('codex-session', 1, '2026-07-30', '{}');",
    )
    .execute(&legacy_pool)
    .await
    .unwrap();

    super::super::bootstrap::migrate_agent_acp_providers(&legacy_pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO agent_acp_sessions
             (id, connection_id, workspace_id, account_scope, provider, title,
              lifecycle, created_at, updated_at)
         VALUES
             ('claude-session', 'connection-1', 'workspace-1', 'personal',
              'claude', 'Claude session', 'starting', '2026-07-30', '2026-07-30')",
    )
    .execute(&legacy_pool)
    .await
    .unwrap();

    let preserved_events: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM agent_acp_events WHERE session_id = 'codex-session'",
    )
    .fetch_one(&legacy_pool)
    .await
    .unwrap();
    assert_eq!(preserved_events, 1);
    let event_parent: String =
        sqlx::query_scalar("SELECT \"table\" FROM pragma_foreign_key_list('agent_acp_events')")
            .fetch_one(&legacy_pool)
            .await
            .unwrap();
    assert_eq!(event_parent, "agent_acp_sessions");
}

async fn assert_current_store_migration_is_write_free() {
    let pool = memory_pool().await;
    assert!(super::super::bootstrap::migrate_local_store(&pool)
        .await
        .unwrap());
    let version: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(version, super::super::bootstrap::LOCAL_SCHEMA_VERSION);

    sqlx::query("PRAGMA query_only = ON")
        .execute(&pool)
        .await
        .unwrap();
    assert!(!super::super::bootstrap::migrate_local_store(&pool)
        .await
        .unwrap());
    sqlx::query("PRAGMA query_only = OFF")
        .execute(&pool)
        .await
        .unwrap();

    let v1_pool = memory_pool().await;
    sqlx::raw_sql(migrations::SCHEMA)
        .execute(&v1_pool)
        .await
        .unwrap();
    sqlx::query("PRAGMA user_version = 1")
        .execute(&v1_pool)
        .await
        .unwrap();
    assert!(super::super::bootstrap::migrate_local_store(&v1_pool)
        .await
        .unwrap());
    let paging_indexes: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master
         WHERE type = 'index'
           AND name IN ('idx_history_scope_recent', 'idx_audit_connection_row')",
    )
    .fetch_one(&v1_pool)
    .await
    .unwrap();
    assert_eq!(paging_indexes, 2);

    let gate = crate::startup::PostPaintRecoveryGate::new();
    assert!(gate.claim_start());
    assert!(!gate.claim_start());
    let waiting_gate = gate.clone();
    let waiter = tokio::spawn(async move { waiting_gate.wait().await });
    tokio::task::yield_now().await;
    assert!(!waiter.is_finished());
    gate.finish(true);
    waiter.await.unwrap().unwrap();
}

async fn assert_agent_acp_batch_replay_is_bounded(store: &Store, connection_id: Uuid) {
    use crate::features::agents::domain::{
        AcpSessionEvent, AcpSessionEventPayload, AcpSessionLifecycle, AcpSessionSummary,
        AgentProvider,
    };
    use crate::kernel::identity::{AcpSessionId, ConnectionId};

    let scope = store.active_resource_scope().await.unwrap();
    let now = Utc::now();
    let session_id = AcpSessionId::from(Uuid::new_v4());
    let summary = AcpSessionSummary {
        id: session_id,
        connection_id: ConnectionId::from(connection_id),
        provider: AgentProvider::Codex,
        title: "Bounded replay".into(),
        lifecycle: AcpSessionLifecycle::Ready,
        acp_session_id: Some("official-adapter-session".into()),
        error: None,
        created_at: now,
        updated_at: now,
    };
    let small_events = (1..=513)
        .map(|sequence| AcpSessionEvent {
            session_id,
            sequence,
            created_at: now,
            payload: AcpSessionEventPayload::SessionUpdate {
                update: serde_json::json!({
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "text", "text": "x" }
                }),
            },
        })
        .collect::<Vec<_>>();
    store
        .persist_agent_acp_events(&scope, &summary, &small_events)
        .await
        .unwrap();
    store
        .persist_agent_acp_events(&scope, &summary, &small_events)
        .await
        .unwrap();
    let event_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM agent_acp_events WHERE session_id = ?1")
            .bind(session_id.to_string())
            .fetch_one(store.pool())
            .await
            .unwrap();
    assert_eq!(event_count, 512);

    let large_text = "z".repeat(480_000);
    let mut boundary_events = (600..609)
        .map(|sequence| AcpSessionEvent {
            session_id,
            sequence,
            created_at: now,
            payload: AcpSessionEventPayload::SessionUpdate {
                update: serde_json::json!({
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "text", "text": large_text.as_str() }
                }),
            },
        })
        .collect::<Vec<_>>();
    boundary_events.push(AcpSessionEvent {
        session_id,
        sequence: 609,
        created_at: now,
        payload: AcpSessionEventPayload::TurnEnd {
            stop_reason: "end_turn".into(),
        },
    });
    store
        .persist_agent_acp_events(&scope, &summary, &boundary_events)
        .await
        .unwrap();
    let persisted_bytes: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(length(CAST(payload AS BLOB))), 0)
         FROM agent_acp_events WHERE session_id = ?1",
    )
    .bind(session_id.to_string())
    .fetch_one(store.pool())
    .await
    .unwrap();
    assert!(persisted_bytes <= 4 * 1024 * 1024);

    let focus = store
        .focus_agent_acp_session(session_id, Some(0))
        .await
        .unwrap();
    assert!(focus.replay_truncated);
    assert!(focus
        .events
        .windows(2)
        .all(|events| events[0].sequence < events[1].sequence));
    assert_eq!(focus.events.last().map(|event| event.sequence), Some(609));
}

#[tokio::test]
async fn remote_template_sync_preserves_member_local_credential_binding() {
    assert_legacy_sql_document_database_scope_migrates().await;
    assert_legacy_agent_acp_provider_migrates().await;
    assert_current_store_migration_is_write_free().await;
    let pool = memory_pool().await;
    sqlx::raw_sql(migrations::SCHEMA)
        .execute(&pool)
        .await
        .unwrap();
    let store = Store::from_pool_for_test(pool);
    let workspace_id = Uuid::new_v4();
    let user = workspace_user("10000000-0000-0000-0000-000000000001", "Owner");
    store
        .sync_account_workspaces(
            &user,
            &[(workspace_id, "Team".into(), WorkspaceRole::Owner)],
        )
        .await
        .unwrap();

    let cursor_page = crate::features::workspaces::WorkspacePullPage {
        next_cursor: 4,
        has_more: false,
        reset: false,
        refresh_connections: true,
        refresh_dashboards: true,
        refresh_reports: true,
        connection_tombstone: false,
        dashboard_tombstone: false,
        report_tombstone: false,
    };
    assert_eq!(
        store
            .workspace_pull_cursor(workspace_id, &user.id)
            .await
            .unwrap(),
        None
    );
    store
        .commit_workspace_pull_cursor(workspace_id, &user.id, None, cursor_page)
        .await
        .unwrap();
    assert_eq!(
        store
            .workspace_pull_cursor(workspace_id, &user.id)
            .await
            .unwrap(),
        Some(4)
    );
    let stale_cursor = store
        .commit_workspace_pull_cursor(
            workspace_id,
            &user.id,
            Some(3),
            crate::features::workspaces::WorkspacePullPage {
                next_cursor: 5,
                ..cursor_page
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(stale_cursor, AppError::Blocked { .. }));
    store
        .commit_workspace_pull_cursor(
            workspace_id,
            &user.id,
            Some(4),
            crate::features::workspaces::WorkspacePullPage {
                next_cursor: 2,
                reset: true,
                ..cursor_page
            },
        )
        .await
        .unwrap();
    assert_eq!(
        store
            .workspace_pull_cursor(workspace_id, &user.id)
            .await
            .unwrap(),
        Some(2)
    );
    store
        .commit_workspace_pull_cursor(
            workspace_id,
            &user.id,
            Some(2),
            crate::features::workspaces::WorkspacePullPage {
                next_cursor: 10_000,
                reset: true,
                ..cursor_page
            },
        )
        .await
        .unwrap();
    assert_eq!(
        store
            .workspace_pull_cursor(workspace_id, &user.id)
            .await
            .unwrap(),
        Some(10_000)
    );
    let other_user = workspace_user("20000000-0000-0000-0000-000000000002", "Editor");
    store
        .sync_account_workspaces(
            &other_user,
            &[(workspace_id, "Team".into(), WorkspaceRole::Editor)],
        )
        .await
        .unwrap();
    assert_eq!(
        store
            .workspace_pull_cursor(workspace_id, &other_user.id)
            .await
            .unwrap(),
        None
    );

    let id = Uuid::new_v4();
    let mut local_binding = sqlite_profile(id, "shared");
    local_binding.workspace_access = crate::model::WorkspaceConnectionAccess::Write;
    local_binding.credential_mode = crate::model::WorkspaceCredentialMode::MemberLocal;
    store
        .sync_remote_connections(workspace_id, &user.id, &[(local_binding, 1)])
        .await
        .unwrap();
    let mut member_options = HashMap::new();
    member_options.insert("member-local-option".into(), "on".into());
    let binding_ref = id.to_string();
    store
        .bind_connection_credentials(
            id,
            &user.id,
            "member-account",
            &member_options,
            Some(&binding_ref),
        )
        .await
        .unwrap();

    let mut remote_update = sqlite_profile(id, "renamed");
    remote_update.username.clear();
    remote_update.extra_params.clear();
    remote_update.secret_ref = None;
    remote_update.allow_writes = false;
    remote_update.workspace_access = crate::model::WorkspaceConnectionAccess::Read;
    remote_update.credential_mode = crate::model::WorkspaceCredentialMode::MemberLocal;
    store
        .sync_remote_connections(workspace_id, &user.id, &[(remote_update, 2)])
        .await
        .unwrap();
    store
        .activate_workspace(workspace_id, Some(&user.id))
        .await
        .unwrap();

    let loaded = store.get_connection(id).await.unwrap();
    assert_eq!(loaded.name, "renamed");
    assert_eq!(loaded.username, "member-account");
    assert_eq!(
        loaded
            .extra_params
            .get("member-local-option")
            .map(String::as_str),
        Some("on")
    );
    let expected_secret_ref = id.to_string();
    assert_eq!(
        loaded.secret_ref.as_deref(),
        Some(expected_secret_ref.as_str())
    );
    assert_eq!(
        loaded.workspace_access,
        crate::model::WorkspaceConnectionAccess::Read
    );
    assert!(!loaded.allow_writes);

    let dashboard_pin = store.pin_connection_for_dashboard(id).await.unwrap();
    let saved_dashboard = store
        .save_dashboard_if_current(
            &dashboard_pin,
            &crate::features::dashboards::DashboardDraft {
                connection_id: id.into(),
                title: "Current users".into(),
                description: "Shared definition, local result".into(),
                sql: "SELECT count(*) AS users FROM users".into(),
                visualization: crate::features::dashboards::DashboardVisualization {
                    version: 1,
                    kind: crate::features::dashboards::DashboardKind::Metric,
                    x_column: None,
                    y_columns: vec!["users".into()],
                },
            },
        )
        .await
        .unwrap();
    assert_eq!(
        saved_dashboard.sync_status,
        crate::features::dashboards::DashboardSyncStatus::Dirty
    );
    let outbox_projection: (Option<String>, String, i64) = sqlx::query_as(
        "SELECT payload_json, operation, revision FROM sync_outbox
         WHERE workspace_id = ?1 AND resource_type = 'dashboard' AND resource_id = ?2",
    )
    .bind(workspace_id.to_string())
    .bind(saved_dashboard.id.to_string())
    .fetch_one(store.pool())
    .await
    .unwrap();
    assert_eq!(outbox_projection, (None, "upsert".into(), 1));
    let pending = store
        .pending_dashboard_mutations(workspace_id, user.id.as_str())
        .await
        .unwrap();
    assert_eq!(pending.len(), 1);
    assert!(store
        .pending_dashboard_mutations(workspace_id, other_user.id.as_str())
        .await
        .unwrap()
        .is_empty());
    let now = Utc::now();
    let mut remote_dashboard = crate::features::workspaces::RemoteDashboard {
        id: saved_dashboard.id.into(),
        connection_id: id,
        title: saved_dashboard.title.clone(),
        description: saved_dashboard.description.clone(),
        sql: saved_dashboard.sql.clone(),
        visualization_json: serde_json::to_string(&saved_dashboard.visualization).unwrap(),
        state: crate::features::workspaces::WorkspaceDashboardState::Published,
        owner_member_id: "31313131-3131-4131-8131-313131313131".into(),
        updated_by_member_id: "31313131-3131-4131-8131-313131313131".into(),
        revision: 1,
        created_at: now,
        updated_at: now,
    };
    store
        .acknowledge_dashboard_mutation(workspace_id, &pending[0], Some(&remote_dashboard))
        .await
        .unwrap();
    let shared = store
        .list_dashboards_if_current(&dashboard_pin)
        .await
        .unwrap();
    assert_eq!(shared.len(), 1);
    assert_eq!(
        shared[0].state,
        crate::features::dashboards::DashboardState::Published
    );
    assert_eq!(
        shared[0].sync_status,
        crate::features::dashboards::DashboardSyncStatus::Synced
    );
    assert_eq!(shared[0].remote_revision, Some(1));

    remote_dashboard.title = "Remote revision".into();
    remote_dashboard.revision = 2;
    remote_dashboard.updated_at = Utc::now();
    store
        .sync_remote_dashboards(workspace_id, user.id.as_str(), &[remote_dashboard.clone()])
        .await
        .unwrap();
    assert_eq!(
        store
            .list_dashboards_if_current(&dashboard_pin)
            .await
            .unwrap()[0]
            .title,
        "Remote revision"
    );
    let dashboard_delete_pin = store
        .pin_dashboard_for_view(saved_dashboard.id)
        .await
        .unwrap();
    store
        .delete_dashboard_if_current(&dashboard_delete_pin)
        .await
        .unwrap();
    let pending_delete = store
        .pending_dashboard_mutations(workspace_id, user.id.as_str())
        .await
        .unwrap();
    assert_eq!(pending_delete.len(), 1);
    assert_eq!(
        pending_delete[0].operation,
        crate::features::workspaces::DashboardOutboxOperation::Delete
    );
    store
        .mark_dashboard_conflict(workspace_id, &pending_delete[0])
        .await
        .unwrap();
    store
        .sync_remote_dashboards(workspace_id, user.id.as_str(), &[remote_dashboard])
        .await
        .unwrap();
    let preserved_conflict: (String, String, i64, Option<String>) = sqlx::query_as(
        "SELECT title, sync_status, revision, pending_account_user_id
             FROM dashboards WHERE id = ?1",
    )
    .bind(saved_dashboard.id.to_string())
    .fetch_one(store.pool())
    .await
    .unwrap();
    assert_eq!(
        preserved_conflict,
        (
            "Remote revision".into(),
            "conflict".into(),
            3,
            Some(user.id.to_string()),
        )
    );
    let dashboard_outbox_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM sync_outbox
         WHERE workspace_id = ?1 AND resource_type = 'dashboard'",
    )
    .bind(workspace_id.to_string())
    .fetch_one(store.pool())
    .await
    .unwrap();
    assert_eq!(dashboard_outbox_count, 0);

    let report_id = Uuid::new_v4();
    let first_run_id = crate::kernel::identity::QueryRunId::from(Uuid::new_v4());
    let first_evidence_id = Uuid::new_v4();
    let first_claim_id = Uuid::new_v4();
    let report_authority = crate::features::reports::StoredReportMutationAuthority {
        account_user_id: user.id.to_string(),
        connection_revision: dashboard_pin.connection_revision,
        binding_revision: dashboard_pin.binding_revision,
        binding_updated_at: dashboard_pin.binding_updated_at.clone(),
    };
    let report_create = crate::features::reports::StoredReportMutation {
        schema_version: crate::features::reports::STORED_REPORT_MUTATION_SCHEMA_VERSION,
        authority: report_authority.clone(),
        mutation: crate::features::reports::StoredReportMutationKind::Propose {
            draft: crate::features::reports::HostedReportDraft {
                id: report_id,
                connection_id: id.into(),
                title: "Current users report".into(),
                question: "How many users are active?".into(),
                conclusion: "One current snapshot is available.".into(),
                preflight_warnings: vec![],
                claims: vec![crate::features::reports::ReportClaimDraft {
                    id: first_claim_id,
                    statement: "The query produced one count.".into(),
                    evidence_ids: vec![first_evidence_id],
                }],
                evidence: vec![crate::features::reports::ReportEvidenceDraft {
                    id: first_evidence_id,
                    query_run_id: first_run_id,
                    sql: "SELECT count(*) AS users FROM users".into(),
                    executed_at: Utc::now(),
                }],
            },
            query_run_ids: vec![first_run_id],
        },
    };
    let create_outbox_id = store
        .enqueue_report_mutation_if_current(&dashboard_pin, &report_create)
        .await
        .unwrap();
    let second_run_id = crate::kernel::identity::QueryRunId::from(Uuid::new_v4());
    let second_evidence_id = Uuid::new_v4();
    let report_append = crate::features::reports::StoredReportMutation {
        schema_version: crate::features::reports::STORED_REPORT_MUTATION_SCHEMA_VERSION,
        authority: report_authority,
        mutation: crate::features::reports::StoredReportMutationKind::AppendEvidence {
            draft: crate::features::reports::HostedReportEvidenceAppend {
                report_id,
                expected_revision: 1,
                connection_id: id.into(),
                claims: vec![crate::features::reports::ReportClaimDraft {
                    id: Uuid::new_v4(),
                    statement: "The rerun confirmed the count.".into(),
                    evidence_ids: vec![second_evidence_id],
                }],
                evidence: vec![crate::features::reports::ReportEvidenceDraft {
                    id: second_evidence_id,
                    query_run_id: second_run_id,
                    sql: "SELECT count(*) AS users FROM users /* rerun */".into(),
                    executed_at: Utc::now(),
                }],
            },
            query_run_ids: vec![second_run_id],
        },
    };
    let append_outbox_id = store
        .enqueue_report_mutation_if_current(&dashboard_pin, &report_append)
        .await
        .unwrap();
    let report_pending = store
        .pending_report_mutations_for_active_scope()
        .await
        .unwrap();
    assert_eq!(
        report_pending
            .iter()
            .map(|item| item.outbox_id)
            .collect::<Vec<_>>(),
        vec![create_outbox_id, append_outbox_id]
    );
    assert!(store
        .is_report_mutation_authority_current(&report_pending[0])
        .await
        .unwrap());
    store
        .record_report_mutation_failure(
            &report_pending[0],
            &AppError::Network("sensitive hosted response must not persist".into()),
        )
        .await
        .unwrap();
    let stored_failure: String =
        sqlx::query_scalar("SELECT last_error FROM sync_outbox WHERE id = ?1")
            .bind(create_outbox_id.to_string())
            .fetch_one(store.pool())
            .await
            .unwrap();
    assert_eq!(stored_failure, "network");
    store
        .acknowledge_report_mutation(&report_pending[0])
        .await
        .unwrap();
    let report_pending = store
        .pending_report_mutations_for_active_scope()
        .await
        .unwrap();
    assert_eq!(report_pending.len(), 1);
    assert_eq!(report_pending[0].outbox_id, append_outbox_id);
    store
        .acknowledge_report_mutation(&report_pending[0])
        .await
        .unwrap();

    assert_agent_acp_batch_replay_is_bounded(&store, id).await;

    let removed_credential_ids = store
        .sync_remote_connections(workspace_id, &user.id, &[])
        .await
        .unwrap();
    assert!(removed_credential_ids.contains(&id));
    assert!(store.list_connections().await.unwrap().is_empty());
    let binding_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM workspace_connection_bindings WHERE connection_id = ?1",
    )
    .bind(id.to_string())
    .fetch_one(store.pool())
    .await
    .unwrap();
    assert_eq!(binding_count, 0);
}

#[tokio::test]
async fn managed_remote_template_never_reads_or_accepts_a_local_binding() {
    let pool = memory_pool().await;
    sqlx::raw_sql(migrations::SCHEMA)
        .execute(&pool)
        .await
        .unwrap();
    let store = Store::from_pool_for_test(pool);
    let workspace_id = Uuid::new_v4();
    let user = workspace_user("10000000-0000-0000-0000-000000000001", "Owner");
    store
        .sync_account_workspaces(
            &user,
            &[(workspace_id, "Team".into(), WorkspaceRole::Owner)],
        )
        .await
        .unwrap();
    let id = Uuid::new_v4();
    let mut template = sqlite_profile(id, "managed");
    template.workspace_access = crate::model::WorkspaceConnectionAccess::Manage;
    template.credential_mode = crate::model::WorkspaceCredentialMode::MemberLocal;
    store
        .sync_remote_connections(workspace_id, &user.id, &[(template.clone(), 1)])
        .await
        .unwrap();
    let credential_id = Uuid::new_v4();
    store
        .bind_connection_credentials(
            id,
            &user.id,
            "member-account",
            &HashMap::new(),
            Some(&credential_id.to_string()),
        )
        .await
        .unwrap();
    template.credential_mode = crate::model::WorkspaceCredentialMode::Managed;
    template.allow_writes = true;
    let provider_target = crate::model::ConnectionProviderTarget::Neon {
        project_id: "project-main".into(),
        branch_id: "br-development".into(),
        branch_name: Some("development".into()),
        current_state: Some(crate::model::NeonBranchState::Ready),
        pending_state: None,
        default: Some(false),
        protected: Some(false),
    };
    template.provider_target = Some(provider_target.clone());
    let removed_credential_ids = store
        .sync_remote_connections(workspace_id, &user.id, &[(template, 2)])
        .await
        .unwrap();
    assert!(removed_credential_ids.contains(&credential_id));
    store
        .activate_workspace(workspace_id, Some(&user.id))
        .await
        .unwrap();

    let loaded = store.get_connection(id).await.unwrap();
    assert_eq!(
        loaded.credential_mode,
        crate::model::WorkspaceCredentialMode::Managed
    );
    assert!(loaded.username.is_empty());
    assert!(loaded.secret_ref.is_none());
    assert!(loaded.allow_writes);
    assert_eq!(loaded.provider_target, Some(provider_target));
    assert!(store.get_safety(id).await.unwrap().allow_writes);
    let binding_material: (String, String, Option<String>) = sqlx::query_as(
        "SELECT username, extra_params, secret_ref
         FROM workspace_connection_bindings
         WHERE connection_id = ?1 AND account_user_id = ?2",
    )
    .bind(id.to_string())
    .bind(user.id.as_str())
    .fetch_one(store.pool())
    .await
    .unwrap();
    assert_eq!(binding_material, ("".into(), "{}".into(), None));
    assert!(matches!(
        store
            .bind_connection_credentials(
                id,
                &user.id,
                "should-not-persist",
                &HashMap::new(),
                Some(&Uuid::new_v4().to_string()),
            )
            .await,
        Err(AppError::Blocked { .. })
    ));
    let pin = store.pin_connection_for_read(id).await.unwrap();
    assert_eq!(pin.catalog_cache_policy, CatalogCachePolicy::EphemeralOnly);
    let snapshot = catalog_snapshot(id, ":memory:", 'c');
    assert_eq!(
        store.put_catalog_if_current(&pin, &snapshot).await.unwrap(),
        CacheWriteOutcome::NotPersisted
    );
    let v2_rows: i64 = sqlx::query_scalar("SELECT count(*) FROM schema_cache_v2")
        .fetch_one(store.pool())
        .await
        .unwrap();
    assert_eq!(v2_rows, 0);
}

#[tokio::test]
async fn shared_connection_bindings_are_isolated_per_signed_in_account() {
    let pool = memory_pool().await;
    sqlx::raw_sql(migrations::SCHEMA)
        .execute(&pool)
        .await
        .unwrap();
    let store = Store::from_pool_for_test(pool);
    let workspace_id = Uuid::new_v4();
    let connection_id = Uuid::new_v4();
    let user_a = workspace_user("10000000-0000-0000-0000-000000000001", "Alpha");
    let user_b = workspace_user("20000000-0000-0000-0000-000000000002", "Beta");
    for user in [&user_a, &user_b] {
        store
            .sync_account_workspaces(
                user,
                &[(workspace_id, "Shared".into(), WorkspaceRole::Analyst)],
            )
            .await
            .unwrap();
    }
    let mut template = sqlite_profile(connection_id, "shared");
    template.workspace_access = crate::model::WorkspaceConnectionAccess::Write;
    template.credential_mode = crate::model::WorkspaceCredentialMode::MemberLocal;
    template.allow_writes = true;
    let mut read_only_template = template.clone();
    read_only_template.workspace_access = crate::model::WorkspaceConnectionAccess::Read;
    read_only_template.allow_writes = false;
    let missing_binding = crate::connection::fetch_profile_secret(&read_only_template).unwrap_err();
    assert!(matches!(
        &missing_binding,
        AppError::CredentialBindingRequired
    ));
    assert_eq!(missing_binding.kind(), "credentialBindingRequired");
    store
        .sync_remote_connections(workspace_id, &user_a.id, &[(template, 1)])
        .await
        .unwrap();
    store
        .sync_remote_connections(workspace_id, &user_b.id, &[(read_only_template, 1)])
        .await
        .unwrap();
    let ref_a = Uuid::new_v4().to_string();
    let ref_b = Uuid::new_v4().to_string();
    let empty_options = HashMap::new();
    store
        .bind_connection_credentials(
            connection_id,
            &user_a.id,
            "alpha-db-user",
            &empty_options,
            Some(&ref_a),
        )
        .await
        .unwrap();
    store
        .bind_connection_credentials(
            connection_id,
            &user_b.id,
            "beta-db-user",
            &empty_options,
            Some(&ref_b),
        )
        .await
        .unwrap();

    store
        .activate_workspace(workspace_id, Some(&user_a.id))
        .await
        .unwrap();
    let profile_a = store.get_connection(connection_id).await.unwrap();
    assert_eq!(profile_a.username, "alpha-db-user");
    assert_eq!(profile_a.secret_ref.as_deref(), Some(ref_a.as_str()));
    assert_eq!(
        profile_a.workspace_access,
        crate::model::WorkspaceConnectionAccess::Write
    );
    assert!(profile_a.allow_writes);
    store
        .set_schema_cache(connection_id, r#"{"owner":"alpha"}"#)
        .await
        .unwrap();
    let execution_pin_a = store.pin_connection_for_read(connection_id).await.unwrap();
    let history_id = Uuid::new_v4();
    let history_sql = format!("SELECT '{}'", "x".repeat(700));
    store
        .insert_history_if_current(
            &execution_pin_a,
            &HistoryEntry {
                id: history_id,
                connection_id,
                sql: history_sql.clone(),
                kind: QueryKind::Read,
                status: "ok".into(),
                row_count: Some(1),
                duration_ms: Some(1),
                error: None,
                executed_at: Utc::now(),
                origin: "manual".into(),
            },
        )
        .await
        .unwrap();
    let audit_sql = format!("SELECT '{}'", "audit".repeat(700));
    let first_audit = crate::audit::record(
        &store,
        crate::audit::RecordArgs {
            connection_id,
            engine: Engine::Sqlite,
            agent_prompt: Some("inspect the shared connection".repeat(30)),
            sql: audit_sql.clone(),
            kind: QueryKind::Read,
            action: "execute".into(),
            approved_by: None,
            affected_estimate: Some(1),
            error: None,
        },
    )
    .await
    .unwrap();
    crate::audit::record(
        &store,
        crate::audit::RecordArgs {
            connection_id,
            engine: Engine::Sqlite,
            agent_prompt: None,
            sql: audit_sql.clone(),
            kind: QueryKind::Read,
            action: "dashboard:run".into(),
            approved_by: None,
            affected_estimate: Some(1),
            error: None,
        },
    )
    .await
    .unwrap();
    let services_snapshot =
        crate::features::queries::validate_query_service_session_snapshot(serde_json::json!({
            "schemaVersion": 1,
            "id": "document-alpha:1",
            "documentId": "document-alpha",
            "connectionId": connection_id,
            "connectionName": "Shared",
            "consoleTitle": "Alpha query",
            "database": ":memory:",
            "namespace": "main",
            "sql": "SELECT 'alpha'",
            "startedAt": "2026-01-01T00:00:00Z",
            "startedLabel": "00:00:00",
            "updatedAt": 1,
            "status": "completed",
            "result": {"kind": "materialized"}
        }))
        .unwrap();
    store
        .save_query_service_session(workspace_id, user_a.id.as_str(), services_snapshot.clone())
        .await
        .unwrap();
    seed_legacy_chat_thread(&store, connection_id, "alpha archive").await;

    store
        .activate_workspace(workspace_id, Some(&user_b.id))
        .await
        .unwrap();
    let profile_b = store.get_connection(connection_id).await.unwrap();
    assert_eq!(profile_b.username, "beta-db-user");
    assert_eq!(profile_b.secret_ref.as_deref(), Some(ref_b.as_str()));
    assert_eq!(
        profile_b.workspace_access,
        crate::model::WorkspaceConnectionAccess::Read
    );
    assert!(!profile_b.allow_writes);
    assert!(matches!(
        store
            .insert_history_if_current(
                &execution_pin_a,
                &HistoryEntry {
                    id: Uuid::new_v4(),
                    connection_id,
                    sql: "SELECT 'stale-alpha'".into(),
                    kind: QueryKind::Read,
                    status: "error".into(),
                    row_count: None,
                    duration_ms: None,
                    error: Some("connection failed".into()),
                    executed_at: Utc::now(),
                    origin: "agent".into(),
                },
            )
            .await,
        Err(AppError::Blocked { .. })
    ));
    assert!(store
        .get_schema_cache(connection_id)
        .await
        .unwrap()
        .is_none());
    assert!(store
        .list_history_page(connection_id, None, None, None, None)
        .await
        .unwrap()
        .items
        .is_empty());
    assert!(store
        .list_query_service_sessions(workspace_id, user_b.id.as_str())
        .await
        .unwrap()
        .is_empty());
    assert!(matches!(
        store
            .list_query_service_sessions(workspace_id, user_a.id.as_str())
            .await,
        Err(AppError::Blocked { .. })
    ));
    assert!(matches!(
        store
            .save_query_service_session(workspace_id, user_a.id.as_str(), services_snapshot,)
            .await,
        Err(AppError::Blocked { .. })
    ));
    assert!(store
        .list_retired_chat_archive_threads()
        .await
        .unwrap()
        .is_empty());
    store
        .set_schema_cache(connection_id, r#"{"owner":"beta"}"#)
        .await
        .unwrap();

    store
        .activate_workspace(workspace_id, Some(&user_a.id))
        .await
        .unwrap();
    assert_eq!(
        store
            .get_schema_cache(connection_id)
            .await
            .unwrap()
            .as_deref(),
        Some(r#"{"owner":"alpha"}"#)
    );
    let history_page = store
        .list_history_page(connection_id, None, None, None, None)
        .await
        .unwrap();
    assert_eq!(history_page.items.len(), 1);
    assert!(history_page.items[0].sql_truncated);
    assert_eq!(history_page.items[0].sql_preview.chars().count(), 512);
    assert_eq!(
        store
            .get_history_entry(connection_id, history_id)
            .await
            .unwrap()
            .sql,
        history_sql
    );
    let audit_page = crate::audit::page_after(&store, connection_id, None)
        .await
        .unwrap();
    assert_eq!(audit_page.items.len(), 2);
    assert!(audit_page.items.iter().all(|entry| entry.sql_truncated));
    assert_eq!(
        crate::audit::entry(&store, connection_id, first_audit.id)
            .await
            .unwrap()
            .sql,
        audit_sql
    );
    let verification = crate::audit::verify_chain(&store, connection_id)
        .await
        .unwrap();
    assert!(verification.ok);
    assert_eq!(verification.entry_count, 2);
    assert!(verification.tail_hash.is_some());
    sqlx::query("UPDATE audit_log SET sql = 'tampered' WHERE id = ?1")
        .bind(first_audit.id.to_string())
        .execute(store.pool())
        .await
        .unwrap();
    let verification = crate::audit::verify_chain(&store, connection_id)
        .await
        .unwrap();
    assert!(!verification.ok);
    assert_eq!(verification.first_bad_index, Some(0));
    assert_eq!(verification.first_bad_id, Some(first_audit.id));
    assert_eq!(
        store
            .list_query_service_sessions(workspace_id, user_a.id.as_str())
            .await
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        store
            .list_retired_chat_archive_threads()
            .await
            .unwrap()
            .len(),
        1
    );

    let shared_dashboard = crate::features::workspaces::RemoteDashboard {
        id: Uuid::new_v4(),
        connection_id,
        title: "Account-scoped dashboard".into(),
        description: "Visible only after this account pulls it".into(),
        sql: "SELECT count(*) AS total FROM users".into(),
        visualization_json: serde_json::json!({
            "version": 1,
            "kind": "metric",
            "xColumn": null,
            "yColumns": ["total"]
        })
        .to_string(),
        state: crate::features::workspaces::WorkspaceDashboardState::Published,
        owner_member_id: "31313131-3131-4131-8131-313131313131".into(),
        updated_by_member_id: "31313131-3131-4131-8131-313131313131".into(),
        revision: 1,
        created_at: Utc::now(),
        updated_at: Utc::now(),
    };
    for user in [&user_a, &user_b] {
        store
            .sync_remote_dashboards(workspace_id, user.id.as_str(), &[shared_dashboard.clone()])
            .await
            .unwrap();
    }
    sqlx::query(
        "UPDATE dashboards
         SET title = 'Alpha pending edit', sync_status = 'dirty',
             pending_account_user_id = ?1
         WHERE id = ?2",
    )
    .bind(user_a.id.as_str())
    .bind(shared_dashboard.id.to_string())
    .execute(store.pool())
    .await
    .unwrap();
    let dashboard_pin_a = store
        .pin_connection_for_dashboard(connection_id)
        .await
        .unwrap();
    assert_eq!(
        store
            .list_dashboards_if_current(&dashboard_pin_a)
            .await
            .unwrap()
            .len(),
        1
    );
    store
        .activate_workspace(workspace_id, Some(&user_b.id))
        .await
        .unwrap();
    let dashboard_pin_b = store
        .pin_connection_for_dashboard(connection_id)
        .await
        .unwrap();
    assert!(store
        .list_dashboards_if_current(&dashboard_pin_b)
        .await
        .unwrap()
        .is_empty());
    store
        .sync_remote_dashboards(workspace_id, user_b.id.as_str(), &[])
        .await
        .unwrap();
    let user_b_visibility: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM workspace_dashboard_visibility
         WHERE dashboard_id = ?1 AND account_user_id = ?2",
    )
    .bind(shared_dashboard.id.to_string())
    .bind(user_b.id.as_str())
    .fetch_one(store.pool())
    .await
    .unwrap();
    assert_eq!(user_b_visibility, 0);
    store
        .activate_workspace(workspace_id, Some(&user_a.id))
        .await
        .unwrap();
    let refreshed_dashboard_pin_a = store
        .pin_connection_for_dashboard(connection_id)
        .await
        .unwrap();
    assert_eq!(
        store
            .list_dashboards_if_current(&refreshed_dashboard_pin_a)
            .await
            .unwrap()
            .len(),
        1
    );

    let removed_for_b = store
        .sync_remote_connections(workspace_id, &user_b.id, &[])
        .await
        .unwrap();
    assert_eq!(removed_for_b, vec![Uuid::parse_str(&ref_b).unwrap()]);
    assert_eq!(
        store
            .get_connection(connection_id)
            .await
            .unwrap()
            .secret_ref
            .as_deref(),
        Some(ref_a.as_str())
    );
    store
        .activate_workspace(workspace_id, Some(&user_b.id))
        .await
        .unwrap();
    assert!(store.list_connections().await.unwrap().is_empty());
    assert!(matches!(
        store.get_connection(connection_id).await,
        Err(AppError::NotFound(_))
    ));
    assert!(matches!(
        store
            .bind_connection_credentials(
                connection_id,
                &user_b.id,
                "no-longer-authorized",
                &HashMap::new(),
                None,
            )
            .await,
        Err(AppError::NotFound(_))
    ));
    store
        .activate_workspace(workspace_id, Some(&user_a.id))
        .await
        .unwrap();
    assert_eq!(store.list_connections().await.unwrap().len(), 1);
}

#[tokio::test]
async fn pinned_catalog_cache_rejects_scope_aba_and_keeps_accounts_isolated() {
    let pool = memory_pool().await;
    sqlx::raw_sql(migrations::SCHEMA)
        .execute(&pool)
        .await
        .unwrap();
    let store = Store::from_pool_for_test(pool);
    let workspace_id = Uuid::new_v4();
    let connection_id = Uuid::new_v4();
    let user_a = workspace_user("10000000-0000-0000-0000-000000000001", "Alpha");
    let user_b = workspace_user("20000000-0000-0000-0000-000000000002", "Beta");
    for user in [&user_a, &user_b] {
        store
            .sync_account_workspaces(
                user,
                &[(workspace_id, "Shared".into(), WorkspaceRole::Analyst)],
            )
            .await
            .unwrap();
    }
    let mut template = sqlite_profile(connection_id, "shared");
    template.workspace_access = crate::model::WorkspaceConnectionAccess::Read;
    template.credential_mode = crate::model::WorkspaceCredentialMode::MemberLocal;
    for user in [&user_a, &user_b] {
        store
            .sync_remote_connections(workspace_id, &user.id, &[(template.clone(), 1)])
            .await
            .unwrap();
        store
            .bind_connection_credentials(
                connection_id,
                &user.id,
                &format!("{}-db-user", user.display_name.to_lowercase()),
                &HashMap::new(),
                Some(&Uuid::new_v4().to_string()),
            )
            .await
            .unwrap();
    }

    store
        .activate_workspace(workspace_id, Some(&user_a.id))
        .await
        .unwrap();
    let pin_a = store.pin_connection_for_read(connection_id).await.unwrap();
    assert_eq!(pin_a.scope.workspace_id, workspace_id);
    assert_eq!(pin_a.scope.account_scope.storage_key(), user_a.id.as_str());
    assert_eq!(pin_a.profile.username, "alpha-db-user");
    assert!(pin_a.requires_remote_rbac);
    assert_eq!(pin_a.catalog_cache_policy, CatalogCachePolicy::Persistent);
    assert!(store.is_pin_current(&pin_a).await.unwrap());

    // V1 rows have no revision provenance and must never be promoted/read by V2.
    sqlx::query(
        "INSERT INTO schema_cache
                (connection_id, account_scope, introspected_at, catalog_json)
             VALUES (?1, ?2, '2026-01-01', '{\"legacy\":true}')",
    )
    .bind(connection_id.to_string())
    .bind(user_a.id.as_str())
    .execute(store.pool())
    .await
    .unwrap();
    assert!(store
        .get_catalog_if_current(&pin_a)
        .await
        .unwrap()
        .is_none());

    let snapshot = catalog_snapshot(connection_id, ":memory:", 'a');
    assert_eq!(
        store
            .put_catalog_if_current(&pin_a, &snapshot)
            .await
            .unwrap(),
        CacheWriteOutcome::Stored
    );
    assert_eq!(
        store.get_catalog_if_current(&pin_a).await.unwrap().unwrap(),
        snapshot
    );
    let legacy_rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM schema_cache
             WHERE connection_id = ?1 AND account_scope = ?2",
    )
    .bind(connection_id.to_string())
    .bind(user_a.id.as_str())
    .fetch_one(store.pool())
    .await
    .unwrap();
    assert_eq!(legacy_rows, 0);

    store
        .activate_workspace(workspace_id, Some(&user_b.id))
        .await
        .unwrap();
    assert!(!store.is_pin_current(&pin_a).await.unwrap());
    assert_eq!(
        store
            .put_catalog_if_current(&pin_a, &snapshot)
            .await
            .unwrap(),
        CacheWriteOutcome::Stale
    );
    let pin_b = store.pin_connection_for_read(connection_id).await.unwrap();
    assert_eq!(pin_b.scope.account_scope.storage_key(), user_b.id.as_str());
    assert_eq!(pin_b.profile.username, "beta-db-user");
    assert!(store
        .get_catalog_if_current(&pin_b)
        .await
        .unwrap()
        .is_none());

    // Returning to A does not revive an in-flight A pin: generation defeats ABA.
    store
        .activate_workspace(workspace_id, Some(&user_a.id))
        .await
        .unwrap();
    let repinned_a = store.pin_connection_for_read(connection_id).await.unwrap();
    assert!(repinned_a.scope.generation > pin_a.scope.generation);
    assert!(!store.is_pin_current(&pin_a).await.unwrap());
    assert_eq!(
        store
            .get_catalog_if_current(&repinned_a)
            .await
            .unwrap()
            .unwrap(),
        snapshot,
        "a current pin may reuse the same account/revision cache after re-selection"
    );

    // A rollback binary can only write V1. Its row acts as a freshness marker:
    // after re-upgrade, the new runtime must miss instead of reviving older V2.
    sqlx::query(
        "INSERT INTO schema_cache
                (connection_id, account_scope, introspected_at, catalog_json)
             VALUES (?1, ?2, '2026-07-24T00:01:00Z', '{\"rollback\":true}')
             ON CONFLICT(connection_id, account_scope) DO UPDATE SET
                introspected_at = excluded.introspected_at,
                catalog_json = excluded.catalog_json",
    )
    .bind(connection_id.to_string())
    .bind(user_a.id.as_str())
    .execute(store.pool())
    .await
    .unwrap();
    assert!(store
        .get_catalog_if_current(&repinned_a)
        .await
        .unwrap()
        .is_none());
    let refreshed = catalog_snapshot(connection_id, ":memory:", 'd');
    assert_eq!(
        store
            .put_catalog_if_current(&repinned_a, &refreshed)
            .await
            .unwrap(),
        CacheWriteOutcome::Stored
    );
    assert_eq!(
        store
            .get_catalog_if_current(&repinned_a)
            .await
            .unwrap()
            .unwrap(),
        refreshed
    );

    sqlx::query(
        "UPDATE schema_cache_v2 SET captured_at = 'not-a-time'
             WHERE workspace_id = ?1 AND account_scope = ?2 AND connection_id = ?3",
    )
    .bind(workspace_id.to_string())
    .bind(user_a.id.as_str())
    .bind(connection_id.to_string())
    .execute(store.pool())
    .await
    .unwrap();
    assert!(store
        .get_catalog_if_current(&repinned_a)
        .await
        .unwrap()
        .is_none());
    store
        .put_catalog_if_current(&repinned_a, &refreshed)
        .await
        .unwrap();

    sqlx::query(
        "UPDATE schema_cache_v2 SET catalog_json = '{'
             WHERE workspace_id = ?1 AND account_scope = ?2 AND connection_id = ?3",
    )
    .bind(workspace_id.to_string())
    .bind(user_a.id.as_str())
    .bind(connection_id.to_string())
    .execute(store.pool())
    .await
    .unwrap();
    assert!(store
        .get_catalog_if_current(&repinned_a)
        .await
        .unwrap()
        .is_none());
    store
        .put_catalog_if_current(&repinned_a, &refreshed)
        .await
        .unwrap();

    let mut tampered = serde_json::to_value(&refreshed).unwrap();
    tampered["fingerprint"] = serde_json::Value::String("e".repeat(64));
    sqlx::query(
        "UPDATE schema_cache_v2
             SET fingerprint = ?1, catalog_json = ?2
             WHERE workspace_id = ?3 AND account_scope = ?4 AND connection_id = ?5",
    )
    .bind("e".repeat(64))
    .bind(serde_json::to_string(&tampered).unwrap())
    .bind(workspace_id.to_string())
    .bind(user_a.id.as_str())
    .bind(connection_id.to_string())
    .execute(store.pool())
    .await
    .unwrap();
    assert!(store
        .get_catalog_if_current(&repinned_a)
        .await
        .unwrap()
        .is_none());
    store
        .put_catalog_if_current(&repinned_a, &refreshed)
        .await
        .unwrap();

    sqlx::query(
        "UPDATE schema_cache_v2 SET catalog_schema_version = 1
             WHERE workspace_id = ?1 AND account_scope = ?2 AND connection_id = ?3",
    )
    .bind(workspace_id.to_string())
    .bind(user_a.id.as_str())
    .bind(connection_id.to_string())
    .execute(store.pool())
    .await
    .unwrap();
    assert!(store
        .get_catalog_if_current(&repinned_a)
        .await
        .unwrap()
        .is_none());
}
