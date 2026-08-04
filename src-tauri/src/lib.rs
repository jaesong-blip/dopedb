//! dopedb — Rust core entrypoint. Wires modules, state, the Tauri command surface,
//! and the owner-local CLI broker used by connection-pinned Terminal sessions.

mod audit;
mod broker;
mod cli_environment;
mod cli_install;
mod commands;
mod connection;
mod ddl;
mod driver;
mod error;
mod executor;
pub mod features;
mod introspect;
mod kernel;
mod legacy_mcp_cleanup;
pub mod model;
mod mongo;
mod monitoring;
pub mod operations;
mod safety;
mod services;
mod skills;
mod sql_script;
mod state;
mod store;

pub use error::{AppError, AppResult};

use std::time::Duration;

use tauri::{Emitter, Manager};

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let state = tauri::async_runtime::block_on(state::AppState::new())
        .expect("failed to initialize app state");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(state)
        .setup(|app| {
            let state = app.state::<state::AppState>();
            broker::start(
                state.broker.clone(),
                state.services.clone(),
                Some(state.skills.clone()),
                app.handle().clone(),
            );
            let mut events = state.services.job.subscribe();
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    match events.recv().await {
                        Ok(event) => {
                            let _ = handle.emit("job:changed", event);
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            features::agents::transport::start_agent_acp_session,
            features::agents::transport::resume_agent_acp_session,
            features::agents::transport::list_agent_acp_sessions,
            features::agents::transport::focus_agent_acp_session,
            features::agents::transport::prompt_agent_acp_session,
            features::agents::transport::cancel_agent_acp_session,
            features::agents::transport::respond_agent_acp_permission,
            features::agents::transport::close_agent_acp_session,
            features::agents::transport::set_agent_acp_config_option,
            features::agents::transport::detect_agent_clis,
            features::agents::transport::list_retired_chat_archive_threads,
            features::agents::transport::get_retired_chat_archive_messages,
            features::workspaces::transport::workspace_feature_state,
            commands::cli_installation_status,
            commands::install_cli,
            commands::skill_status,
            commands::install_skill,
            commands::repair_skill,
            commands::remove_skill,
            commands::skill_self_test,
            legacy_mcp_cleanup::legacy_mcp_cleanup_status,
            legacy_mcp_cleanup::legacy_mcp_cleanup_apply,
            features::terminals::transport::terminal_create,
            features::terminals::transport::terminal_list,
            features::terminals::transport::terminal_focus,
            features::terminals::transport::terminal_write,
            features::terminals::transport::terminal_resize,
            features::terminals::transport::terminal_kill,
            features::terminals::transport::terminal_close,
            features::terminals::transport::terminal_restart,
            features::terminals::transport::terminal_rename,
            features::terminals::transport::terminal_shutdown_all,
            features::workspaces::transport::workspace_auth_state,
            features::workspaces::transport::refresh_workspace_auth_state,
            features::workspaces::transport::workspace_sign_out,
            features::workspaces::transport::workspace_sign_out_all,
            features::workspaces::transport::begin_workspace_login,
            features::workspaces::transport::poll_workspace_login,
            features::workspaces::transport::workspace_console_url,
            features::workspaces::transport::list_workspaces,
            features::workspaces::transport::refresh_workspace_memberships,
            features::workspaces::transport::get_active_workspace,
            features::workspaces::transport::set_active_workspace,
            features::workspaces::transport::set_active_workspace_account,
            features::workspaces::transport::copy_connection_to_workspace,
            features::workspaces::transport::bind_workspace_connection_credentials,
            features::workspaces::transport::update_workspace_connection,
            features::workspaces::transport::delete_workspace_connection,
            features::providers::transport::list_provider_integrations,
            features::providers::transport::list_provider_credential_bindings,
            features::providers::transport::begin_provider_credential_binding,
            features::providers::transport::verify_provider_credential_binding,
            features::providers::transport::revoke_provider_credential_binding,
            features::providers::transport::list_provider_provisioning_statuses,
            features::providers::transport::discover_provider_provisioning_targets,
            features::providers::transport::prepare_provider_provisioning,
            features::providers::transport::get_provider_provisioning_status,
            features::providers::transport::list_provider_provisioning_for_connection,
            features::providers::transport::prepare_provider_provisioning_destroy,
            features::providers::transport::prepare_provider_provisioning_repair,
            features::providers::transport::reconcile_provider_provisioning,
            features::providers::transport::execute_provider_provisioning,
            features::providers::transport::cancel_provider_provisioning,
            features::connections::transport::list_connections,
            features::connections::transport::list_drivers,
            features::connections::transport::install_driver,
            features::connections::transport::create_demo_sqlite,
            features::connections::transport::upsert_connection,
            features::connections::transport::set_connections_schema_group,
            features::connections::transport::delete_connection,
            features::connections::transport::test_connection,
            features::connections::transport::test_connection_profile,
            features::dashboards::transport::list_dashboards,
            features::dashboards::transport::delete_dashboard,
            features::dashboards::transport::run_dashboard,
            features::catalog::transport::get_schema,
            features::catalog::transport::refresh_schema,
            features::catalog::transport::get_catalog_snapshot,
            features::catalog::transport::get_catalog_overview,
            features::catalog::transport::list_connection_databases,
            features::catalog::transport::get_database_schema,
            features::catalog::transport::get_database_catalog_overview,
            features::catalog::transport::get_database_catalog_snapshot,
            features::catalog::transport::get_table_ddl,
            features::catalog::transport::get_database_table_ddl,
            features::queries::transport::inspect_sql,
            features::queries::transport::propose_sql,
            features::queries::transport::get_manual_transaction,
            features::queries::transport::begin_manual_transaction,
            features::queries::transport::commit_manual_transaction,
            features::queries::transport::rollback_manual_transaction,
            features::queries::transport::list_query_service_sessions,
            features::queries::transport::save_query_service_session,
            commands::approve_operation,
            commands::reject_operation,
            features::queries::transport::run_sql,
            features::queries::transport::run_sql_stream,
            features::queries::transport::run_sql_read_stream,
            features::queries::transport::pull_sql_stream_batch,
            features::queries::transport::ack_sql_stream,
            features::queries::transport::cancel_sql_stream,
            commands::propose_document_query,
            commands::run_document_query,
            commands::propose_script,
            commands::propose_table_changes,
            commands::run_script,
            features::schema_editor::transport::preview_schema_change,
            features::schema_editor::transport::propose_schema_change,
            features::schema_editor::transport::run_schema_change,
            features::sql_documents::transport::list_sql_documents,
            features::sql_documents::transport::list_sql_document_revisions,
            features::sql_documents::transport::create_sql_document,
            features::sql_documents::transport::save_sql_document,
            features::sql_documents::transport::delete_sql_document,
            features::erd::transport::list_erd_layouts,
            features::erd::transport::save_erd_layout,
            features::erd::transport::delete_erd_layout,
            features::jobs::transport::pick_job_input,
            features::jobs::transport::pick_job_output,
            features::jobs::transport::inspect_job_input,
            features::jobs::transport::create_job,
            features::jobs::transport::list_jobs,
            features::jobs::transport::get_job,
            features::jobs::transport::start_job,
            features::jobs::transport::pause_job,
            features::jobs::transport::cancel_job,
            features::jobs::transport::reveal_job_artifact,
            commands::get_safety,
            commands::set_safety,
            commands::get_monitoring_status,
            commands::propose_postgres_monitoring,
            commands::set_postgres_monitoring,
            commands::audit_verify,
            commands::audit_snapshot,
            commands::list_history,
            commands::pick_file,
            executor::cancel::cancel_query,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Terminal PTYs and the local broker own process/socket resources outside
            // ordinary command futures. Close them within a bounded window before the
            // app process exits so child trees and runtime endpoints are not orphaned.
            if let tauri::RunEvent::Exit = event {
                let queries = app_handle
                    .state::<state::AppState>()
                    .services
                    .queries
                    .clone();
                tauri::async_runtime::block_on(
                    queries.shutdown_desktop_streams(Duration::from_secs(2)),
                );
                tauri::async_runtime::block_on(queries.shutdown_manual_transactions());
                let terminals = app_handle.state::<state::AppState>().terminals.clone();
                terminals.shutdown_all(app_handle, Duration::from_secs(2));
                let agents = app_handle.state::<state::AppState>().agents_acp.clone();
                agents.shutdown_all();
                tauri::async_runtime::block_on(agents.flush_persistence(Duration::from_secs(2)));
                let broker = app_handle.state::<state::AppState>().broker.clone();
                tauri::async_runtime::block_on(broker.shutdown_and_wait(Duration::from_secs(2)));
            }
        });
}
