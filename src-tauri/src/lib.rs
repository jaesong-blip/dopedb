//! dopedb — Rust core entrypoint. Wires modules, state, the Tauri command surface,
//! and the owner-local CLI broker used by connection-pinned Terminal sessions.

mod app_paths;
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
mod packaged_benchmark;
mod safety;
mod services;
mod skills;
mod sql_script;
mod startup;
mod state;
mod store;

pub use error::{AppError, AppResult};

use std::time::Duration;

use tauri::{Emitter, Manager};

pub fn run() {
    #[cfg(feature = "packaged-benchmark")]
    if packaged_benchmark::prepare_fixture_if_requested()
        .expect("failed to prepare packaged benchmark fixture")
    {
        return;
    }
    let startup_trace = startup::StartupTrace::new();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let state = tauri::async_runtime::block_on(state::AppState::new(startup_trace))
        .expect("failed to initialize app state");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(state)
        .setup(|app| {
            let state = app.state::<state::AppState>();
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
            let mut manual_transaction_events =
                state.services.queries.manual_transactions().subscribe();
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    match manual_transaction_events.recv().await {
                        Ok(event) => {
                            let _ = handle.emit("manual-transaction:changed", event);
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            let _ = handle.emit("manual-transaction:resync", ());
                            continue;
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            });
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // A broken renderer must not leave Agent/Job commands waiting forever.
                // The normal path starts immediately after the renderer's second frame.
                tokio::time::sleep(Duration::from_secs(5)).await;
                handle
                    .state::<state::AppState>()
                    .start_post_paint_recovery(handle.clone());
            });
            #[cfg(target_os = "macos")]
            refresh_macos_icon_cache();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            features::agents::transport::start_agent_acp_session,
            features::agents::transport::list_agent_knowledge_environments,
            features::agents::transport::resume_agent_acp_session,
            features::agents::transport::list_agent_acp_sessions,
            features::agents::transport::focus_agent_acp_session,
            features::agents::transport::prompt_agent_acp_session,
            features::agents::transport::cancel_agent_acp_session,
            features::agents::transport::respond_agent_acp_permission,
            features::agents::transport::close_agent_acp_session,
            features::agents::transport::set_agent_acp_config_option,
            features::agents::transport::detect_agent_clis,
            features::agents::transport::list_agent_acp_plugins,
            features::agents::transport::install_agent_acp_plugin,
            features::agents::transport::remove_agent_acp_plugin,
            features::agents::transport::set_agent_acp_plugin_enabled,
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
            startup::record_startup_mark,
            startup::runtime_startup_summary,
            packaged_benchmark::packaged_benchmark_config,
            packaged_benchmark::run_packaged_benchmark_backend,
            packaged_benchmark::complete_packaged_benchmark,
            packaged_benchmark::fail_packaged_benchmark,
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
            features::knowledge::transport::list_knowledge_projects_command,
            features::knowledge::transport::create_knowledge_project_command,
            features::knowledge::transport::begin_knowledge_github_install_command,
            features::knowledge::transport::list_knowledge_github_repositories_command,
            features::knowledge::transport::connect_knowledge_github_source,
            features::knowledge::transport::connect_knowledge_local_folder,
            features::knowledge::transport::list_knowledge_sources,
            features::knowledge::transport::revoke_knowledge_source,
            features::knowledge::transport::sync_knowledge_source,
            features::knowledge::transport::search_knowledge_graph,
            features::knowledge::transport::find_knowledge_graph_path,
            features::knowledge::transport::list_knowledge_mappings,
            features::knowledge::transport::decide_knowledge_mapping,
            features::knowledge::transport::list_knowledge_environment_connections,
            features::knowledge::transport::bind_knowledge_environment_connection,
            features::knowledge::transport::revoke_knowledge_environment_connection,
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
            features::queries::transport::list_manual_transactions,
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
            features::queries::transport::run_sql_read_page_stream,
            features::queries::transport::pull_sql_stream_batch,
            features::queries::transport::read_sql_result_page,
            features::queries::transport::export_sql_result,
            features::queries::transport::cancel_sql_result_export,
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
            features::sql_documents::transport::list_sql_document_revision_page,
            features::sql_documents::transport::get_sql_document_revision,
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
            commands::list_audit_page,
            commands::get_audit_entry,
            commands::list_history_page,
            commands::get_history_entry,
            commands::pick_file,
            executor::cancel::cancel_query,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Ready = event {
                app_handle
                    .state::<state::AppState>()
                    .startup_trace
                    .mark_once("window_shown", "critical", true);
                #[cfg(feature = "packaged-benchmark")]
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
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

/// macOS는 앱 번들을 제자리에서 교체해도 LaunchServices 아이콘 캐시를 버리지 않아
/// 업데이트한 뒤에도 옛 앱 아이콘이 남는다. 번들 mtime을 올려 캐시 키를 무효화하고
/// 다시 등록해, 사용자가 `lsregister`나 `killall Dock`을 직접 치지 않게 한다.
#[cfg(target_os = "macos")]
fn refresh_macos_icon_cache() {
    const LSREGISTER: &str = "/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister";

    let Ok(executable) = std::env::current_exe() else {
        return;
    };
    // <bundle>.app/Contents/MacOS/<binary>
    let Some(bundle) = executable.ancestors().nth(3) else {
        return;
    };
    if bundle.extension().and_then(|extension| extension.to_str()) != Some("app") {
        return;
    }

    let bundle = bundle.to_path_buf();
    // ponytail: 마지막 실행 버전을 추적하지 않고 시작마다 재등록한다. 두 호출 모두
    // idempotent하고 수십 ms라, 상태를 하나 더 늘리는 값이 더 비싸다.
    std::thread::spawn(move || {
        let _ = std::process::Command::new("/usr/bin/touch")
            .arg(&bundle)
            .status();
        let _ = std::process::Command::new(LSREGISTER)
            .arg("-f")
            .arg(&bundle)
            .status();
    });
}
