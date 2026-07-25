//! dopedb — Rust core entrypoint. Wires modules, state, the Tauri command surface,
//! and the owner-local CLI broker used by connection-pinned Terminal sessions.

mod agent_cli;
mod audit;
mod broker;
mod cli_environment;
mod cli_install;
mod commands;
mod connection;
mod dashboard;
mod ddl;
mod driver;
mod error;
mod executor;
pub mod features;
mod introspect;
mod legacy_chat;
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
mod terminal;
mod workspace_auth;

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
            let enabled_features = app.state::<state::AppState>().features.enabled_names();
            if !enabled_features.is_empty() {
                tracing::info!(?enabled_features, "experimental platform features enabled");
            }
            if app
                .state::<state::AppState>()
                .features
                .is_enabled(features::FeatureFlag::LocalBrokerV1)
            {
                let state = app.state::<state::AppState>();
                let skills = state
                    .features
                    .is_enabled(features::FeatureFlag::SkillManagerV1)
                    .then(|| state.skills.clone());
                broker::start(
                    state.broker.clone(),
                    state.services.clone(),
                    skills,
                    app.handle().clone(),
                );
            }
            if app
                .state::<state::AppState>()
                .features
                .is_enabled(features::FeatureFlag::JobsV1)
            {
                let mut events = app.state::<state::AppState>().services.job.subscribe();
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
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::workspace_feature_state,
            commands::platform_feature_flags,
            commands::cli_installation_status,
            commands::install_cli,
            commands::skill_status,
            commands::install_skill,
            commands::repair_skill,
            commands::remove_skill,
            commands::skill_self_test,
            legacy_mcp_cleanup::legacy_mcp_cleanup_status,
            legacy_mcp_cleanup::legacy_mcp_cleanup_apply,
            terminal::terminal_create,
            terminal::terminal_list,
            terminal::terminal_focus,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_kill,
            terminal::terminal_restart,
            terminal::terminal_rename,
            terminal::terminal_shutdown_all,
            commands::workspace_auth_state,
            commands::refresh_workspace_auth_state,
            commands::workspace_sign_out,
            commands::workspace_sign_out_all,
            commands::begin_workspace_login,
            commands::poll_workspace_login,
            commands::workspace_console_url,
            commands::list_workspaces,
            commands::refresh_workspace_memberships,
            commands::get_active_workspace,
            commands::set_active_workspace,
            commands::set_active_workspace_account,
            commands::copy_connection_to_workspace,
            commands::bind_workspace_connection_credentials,
            commands::list_connections,
            commands::list_drivers,
            commands::install_driver,
            commands::upsert_connection,
            commands::set_connections_schema_group,
            commands::delete_connection,
            commands::test_connection,
            commands::test_connection_profile,
            commands::list_dashboards,
            commands::delete_dashboard,
            commands::run_dashboard,
            commands::get_schema,
            commands::refresh_schema,
            commands::get_catalog_snapshot,
            commands::get_table_ddl,
            commands::classify_sql,
            commands::preview_sql,
            commands::propose_sql,
            commands::approve_operation,
            commands::reject_operation,
            commands::run_sql,
            commands::propose_document_query,
            commands::run_document_query,
            commands::propose_script,
            commands::propose_table_changes,
            commands::run_script,
            commands::preview_schema_change,
            commands::propose_schema_change,
            commands::run_schema_change,
            commands::list_sql_documents,
            commands::create_sql_document,
            commands::save_sql_document,
            commands::delete_sql_document,
            commands::list_erd_layouts,
            commands::save_erd_layout,
            commands::delete_erd_layout,
            commands::pick_job_input,
            commands::pick_job_output,
            commands::inspect_job_input,
            commands::create_job,
            commands::list_jobs,
            commands::get_job,
            commands::start_job,
            commands::pause_job,
            commands::cancel_job,
            commands::reveal_job_artifact,
            commands::get_safety,
            commands::set_safety,
            commands::get_monitoring_status,
            commands::propose_postgres_monitoring,
            commands::set_postgres_monitoring,
            commands::audit_verify,
            commands::audit_snapshot,
            commands::list_history,
            commands::pick_file,
            commands::detect_agent_clis,
            commands::list_chat_threads,
            commands::get_chat_messages,
            executor::cancel::cancel_query,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Terminal PTYs and the local broker own process/socket resources outside
            // ordinary command futures. Close them within a bounded window before the
            // app process exits so child trees and runtime endpoints are not orphaned.
            if let tauri::RunEvent::Exit = event {
                let terminals = app_handle.state::<state::AppState>().terminals.clone();
                terminals.shutdown_all(app_handle, Duration::from_secs(2));
                let broker = app_handle.state::<state::AppState>().broker.clone();
                tauri::async_runtime::block_on(broker.shutdown_and_wait(Duration::from_secs(2)));
            }
        });
}
