//! Tauri commands for the complete Analysis Article lifecycle. Team definitions,
//! revisions, runs, and reviewed result fragments are coordinated by the hosted
//! control plane, while all database execution and credentials stay on Desktop.

use std::collections::BTreeMap;

use dopedb_protocol::{
    AnalysisArticleRecord, AnalysisArticleState, AnalysisRunError, AnalysisRunState,
    AnalysisRunTrigger, SharedAnalysisArticleCreate,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use uuid::Uuid;

use super::adapters::hosted::{
    analysis_publication_url, analysis_runner_capability_is_missing,
    analysis_runner_registration_guard, cancel_analysis_run as cancel_remote_analysis_run,
    complete_analysis_run, create_analysis_publication, create_analysis_signal,
    delete_analysis_article, delete_analysis_signal, get_analysis_result, get_analysis_run,
    list_analysis_article_revisions, list_analysis_collaborators, list_analysis_notifications,
    list_analysis_publications, list_analysis_runners, list_analysis_runs,
    list_analysis_signal_receipts, list_analysis_signals, mark_analysis_notifications_read,
    preview_analysis_publication, register_analysis_runner, revoke_analysis_publication,
    revoke_analysis_runner, set_analysis_signal_enabled, start_analysis_run,
    update_analysis_signal, AnalysisCollaboratorDirectory, AnalysisPublicationRequest,
    AnalysisRunnerRevocation, AnalysisSignalChannel, AnalysisSignalCreateRequest,
    RemoteAnalysisArticleRevision, RemoteAnalysisNotification, RemoteAnalysisPublicSnapshot,
    RemoteAnalysisPublication, RemoteAnalysisResult, RemoteAnalysisRun, RemoteAnalysisSignal,
    RemoteAnalysisSignalHistoryReceipt,
};
use crate::error::{AppError, AppResult};
use crate::executor::cancel;
use crate::features::workspaces::WorkspaceKind;
use crate::kernel::identity::AccountId;
use crate::state::AppState;
use crate::store::ActiveResourceScope;

use super::{AnalysisArticleMutation, AnalysisDefinitionRunReceipt, AnalysisDefinitionRunRequest};

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AnalysisArticleLifecycleAction {
    SubmitReview,
    ReturnDraft,
    PublishLive,
    Archive,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AnalysisRunCommandResult {
    run: RemoteAnalysisRun,
    result: AnalysisDefinitionRunReceipt,
    shared_result: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AnalysisRunPage {
    runs: Vec<RemoteAnalysisRun>,
    next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AnalysisPublicationPreview {
    snapshot: RemoteAnalysisPublicSnapshot,
    snapshot_hash: String,
}

fn team_account(scope: &ActiveResourceScope) -> AppResult<AccountId> {
    if scope.workspace_kind != WorkspaceKind::Team {
        return Err(AppError::Config(
            "Shared Analysis Articles require a Team workspace".into(),
        ));
    }
    scope
        .selected_account_id
        .as_ref()
        .and_then(AccountId::new)
        .ok_or_else(|| AppError::Config("Analysis Articles require a selected account".into()))
}

async fn remote_scope(state: &AppState) -> AppResult<(ActiveResourceScope, AccountId)> {
    let scope = state.services.knowledge.active_resource_scope().await?;
    let account = team_account(&scope)?;
    Ok((scope, account))
}

fn lifecycle_mutation(action: AnalysisArticleLifecycleAction) -> AnalysisArticleMutation {
    match action {
        AnalysisArticleLifecycleAction::SubmitReview => AnalysisArticleMutation::SubmitReview,
        AnalysisArticleLifecycleAction::ReturnDraft => AnalysisArticleMutation::ReturnDraft,
        AnalysisArticleLifecycleAction::PublishLive => AnalysisArticleMutation::PublishLive,
        AnalysisArticleLifecycleAction::Archive => AnalysisArticleMutation::Archive,
    }
}

fn bounded_error(error: &AppError) -> AnalysisRunError {
    AnalysisRunError {
        kind: error.kind().chars().take(128).collect(),
        message: error.to_string().chars().take(2_000).collect(),
    }
}

fn cancelled_error(error: &AppError) -> bool {
    matches!(error, AppError::Safety(message) if message.to_ascii_lowercase().contains("cancel"))
}

#[tauri::command]
pub(crate) async fn list_analysis_articles_command(
    state: State<'_, AppState>,
    project_environment_id: Option<Uuid>,
) -> AppResult<Vec<AnalysisArticleRecord>> {
    let (scope, account) = remote_scope(&state).await?;
    state
        .services
        .analysis_article
        .list_remote(account.as_str(), scope.workspace_id, project_environment_id)
        .await
}

#[tauri::command]
pub(crate) async fn update_analysis_article_command(
    state: State<'_, AppState>,
    article_id: Uuid,
    expected_revision: i64,
    article: SharedAnalysisArticleCreate,
) -> AppResult<AnalysisArticleRecord> {
    let (scope, account) = remote_scope(&state).await?;
    state
        .services
        .analysis_article
        .mutate_remote(
            account.as_str(),
            scope.workspace_id,
            article_id,
            expected_revision,
            AnalysisArticleMutation::Update(Box::new(article)),
        )
        .await
}

#[tauri::command]
pub(crate) async fn transition_analysis_article_command(
    state: State<'_, AppState>,
    article_id: Uuid,
    expected_revision: i64,
    action: AnalysisArticleLifecycleAction,
) -> AppResult<AnalysisArticleRecord> {
    let (scope, account) = remote_scope(&state).await?;
    state
        .services
        .analysis_article
        .mutate_remote(
            account.as_str(),
            scope.workspace_id,
            article_id,
            expected_revision,
            lifecycle_mutation(action),
        )
        .await
}

#[tauri::command]
pub(crate) async fn transfer_analysis_article_command(
    state: State<'_, AppState>,
    article_id: Uuid,
    expected_revision: i64,
    owner_member_id: String,
) -> AppResult<AnalysisArticleRecord> {
    let (scope, account) = remote_scope(&state).await?;
    state
        .services
        .analysis_article
        .mutate_remote(
            account.as_str(),
            scope.workspace_id,
            article_id,
            expected_revision,
            AnalysisArticleMutation::Transfer { owner_member_id },
        )
        .await
}

#[tauri::command]
pub(crate) async fn restore_analysis_article_revision_command(
    state: State<'_, AppState>,
    article_id: Uuid,
    expected_revision: i64,
    revision: i64,
) -> AppResult<AnalysisArticleRecord> {
    let (scope, account) = remote_scope(&state).await?;
    state
        .services
        .analysis_article
        .mutate_remote(
            account.as_str(),
            scope.workspace_id,
            article_id,
            expected_revision,
            AnalysisArticleMutation::Restore { revision },
        )
        .await
}

#[tauri::command]
pub(crate) async fn delete_analysis_article_command(
    state: State<'_, AppState>,
    article_id: Uuid,
    expected_revision: i64,
) -> AppResult<i64> {
    let (scope, account) = remote_scope(&state).await?;
    let revision = delete_analysis_article(
        account.as_str(),
        scope.workspace_id,
        article_id,
        expected_revision,
    )
    .await?;
    if let Err(error) = state
        .services
        .analysis_article
        .delete_local_results(article_id)
        .await
    {
        tracing::warn!(
            error_kind = error.kind(),
            %article_id,
            "Analysis Article local recovery cleanup deferred"
        );
    }
    Ok(revision)
}

#[tauri::command]
pub(crate) async fn get_local_analysis_article_result_command(
    state: State<'_, AppState>,
    article_id: Uuid,
    run_id: Option<Uuid>,
) -> AppResult<Option<AnalysisDefinitionRunReceipt>> {
    state
        .services
        .analysis_article
        .load_local_result(article_id, run_id)
        .await
}

#[tauri::command]
pub(crate) async fn list_analysis_article_revisions_command(
    state: State<'_, AppState>,
    article_id: Uuid,
) -> AppResult<Vec<RemoteAnalysisArticleRevision>> {
    let (scope, account) = remote_scope(&state).await?;
    list_analysis_article_revisions(account.as_str(), scope.workspace_id, article_id).await
}

#[tauri::command]
pub(crate) async fn list_analysis_runners_command(
    state: State<'_, AppState>,
) -> AppResult<Vec<super::adapters::hosted::RemoteAnalysisRunner>> {
    let (scope, account) = remote_scope(&state).await?;
    let current_device_id = state
        .services
        .analysis_article
        .runner_device_id(account.as_str(), scope.workspace_id)
        .await?
        .to_string();
    let mut runners = list_analysis_runners(account.as_str(), scope.workspace_id).await?;
    for runner in &mut runners {
        runner.is_current = runner.device_id == current_device_id;
    }
    Ok(runners)
}

#[tauri::command]
pub(crate) async fn revoke_analysis_runner_command(
    state: State<'_, AppState>,
    runner_id: Uuid,
) -> AppResult<AnalysisRunnerRevocation> {
    let (scope, account) = remote_scope(&state).await?;
    let current_device_id = state
        .services
        .analysis_article
        .runner_device_id(account.as_str(), scope.workspace_id)
        .await?
        .to_string();
    let runners = list_analysis_runners(account.as_str(), scope.workspace_id).await?;
    let runner = runners
        .iter()
        .find(|runner| runner.id == runner_id)
        .ok_or_else(|| AppError::NotFound("Analysis runner not found".into()))?;
    if runner.device_id == current_device_id {
        return Err(AppError::Blocked {
            reason: "The current device is managed in Settings and cannot be forgotten here".into(),
        });
    }
    revoke_analysis_runner(account.as_str(), scope.workspace_id, runner_id).await
}

#[tauri::command]
pub(crate) async fn list_analysis_publications_command(
    state: State<'_, AppState>,
    article_id: Uuid,
) -> AppResult<Vec<RemoteAnalysisPublication>> {
    let (scope, account) = remote_scope(&state).await?;
    list_analysis_publications(account.as_str(), scope.workspace_id, article_id).await
}

#[tauri::command]
pub(crate) async fn preview_analysis_publication_command(
    state: State<'_, AppState>,
    article_id: Uuid,
    request: AnalysisPublicationRequest,
) -> AppResult<AnalysisPublicationPreview> {
    let (scope, account) = remote_scope(&state).await?;
    let (snapshot, snapshot_hash) =
        preview_analysis_publication(account.as_str(), scope.workspace_id, article_id, &request)
            .await?;
    Ok(AnalysisPublicationPreview {
        snapshot,
        snapshot_hash,
    })
}

#[tauri::command]
pub(crate) async fn create_analysis_publication_command(
    state: State<'_, AppState>,
    article_id: Uuid,
    request: AnalysisPublicationRequest,
) -> AppResult<RemoteAnalysisPublication> {
    let (scope, account) = remote_scope(&state).await?;
    create_analysis_publication(account.as_str(), scope.workspace_id, article_id, &request).await
}

#[tauri::command]
pub(crate) async fn revoke_analysis_publication_command(
    state: State<'_, AppState>,
    article_id: Uuid,
    publication_id: Uuid,
) -> AppResult<chrono::DateTime<chrono::Utc>> {
    let (scope, account) = remote_scope(&state).await?;
    revoke_analysis_publication(
        account.as_str(),
        scope.workspace_id,
        article_id,
        publication_id,
    )
    .await
}

#[tauri::command]
pub(crate) fn analysis_publication_url_command(slug: String) -> AppResult<String> {
    analysis_publication_url(&slug)
}

#[tauri::command]
pub(crate) async fn list_analysis_collaborators_command(
    state: State<'_, AppState>,
) -> AppResult<AnalysisCollaboratorDirectory> {
    let (scope, account) = remote_scope(&state).await?;
    list_analysis_collaborators(account.as_str(), scope.workspace_id).await
}

#[tauri::command]
pub(crate) async fn list_analysis_signals_command(
    state: State<'_, AppState>,
    article_id: Uuid,
) -> AppResult<Vec<RemoteAnalysisSignal>> {
    let (scope, account) = remote_scope(&state).await?;
    list_analysis_signals(account.as_str(), scope.workspace_id, article_id).await
}

#[tauri::command]
pub(crate) async fn create_analysis_signal_command(
    state: State<'_, AppState>,
    article_id: Uuid,
    signal: AnalysisSignalCreateRequest,
) -> AppResult<RemoteAnalysisSignal> {
    let (scope, account) = remote_scope(&state).await?;
    create_analysis_signal(account.as_str(), scope.workspace_id, article_id, &signal).await
}

#[tauri::command]
pub(crate) async fn update_analysis_signal_command(
    state: State<'_, AppState>,
    article_id: Uuid,
    signal_id: Uuid,
    expected_revision: i64,
    signal: AnalysisSignalCreateRequest,
) -> AppResult<RemoteAnalysisSignal> {
    let (scope, account) = remote_scope(&state).await?;
    update_analysis_signal(
        account.as_str(),
        scope.workspace_id,
        article_id,
        signal_id,
        expected_revision,
        &signal,
    )
    .await
}

#[tauri::command]
pub(crate) async fn set_analysis_signal_enabled_command(
    state: State<'_, AppState>,
    article_id: Uuid,
    signal_id: Uuid,
    expected_revision: i64,
    enabled: bool,
) -> AppResult<RemoteAnalysisSignal> {
    let (scope, account) = remote_scope(&state).await?;
    set_analysis_signal_enabled(
        account.as_str(),
        scope.workspace_id,
        article_id,
        signal_id,
        expected_revision,
        enabled,
    )
    .await
}

#[tauri::command]
pub(crate) async fn delete_analysis_signal_command(
    state: State<'_, AppState>,
    article_id: Uuid,
    signal_id: Uuid,
    expected_revision: i64,
) -> AppResult<i64> {
    let (scope, account) = remote_scope(&state).await?;
    delete_analysis_signal(
        account.as_str(),
        scope.workspace_id,
        article_id,
        signal_id,
        expected_revision,
    )
    .await
}

#[tauri::command]
pub(crate) async fn list_analysis_signal_receipts_command(
    state: State<'_, AppState>,
    article_id: Uuid,
    signal_id: Uuid,
) -> AppResult<Vec<RemoteAnalysisSignalHistoryReceipt>> {
    let (scope, account) = remote_scope(&state).await?;
    list_analysis_signal_receipts(account.as_str(), scope.workspace_id, article_id, signal_id).await
}

#[tauri::command]
pub(crate) async fn list_analysis_notifications_command(
    state: State<'_, AppState>,
) -> AppResult<Vec<RemoteAnalysisNotification>> {
    let (scope, account) = remote_scope(&state).await?;
    list_analysis_notifications(
        account.as_str(),
        scope.workspace_id,
        AnalysisSignalChannel::Desktop,
    )
    .await
}

#[tauri::command]
pub(crate) async fn mark_analysis_notifications_read_command(
    state: State<'_, AppState>,
    notification_ids: Vec<Uuid>,
) -> AppResult<Vec<Uuid>> {
    let (scope, account) = remote_scope(&state).await?;
    mark_analysis_notifications_read(
        account.as_str(),
        scope.workspace_id,
        AnalysisSignalChannel::Desktop,
        &notification_ids,
    )
    .await
}

#[tauri::command]
pub(crate) async fn list_analysis_article_runs_command(
    state: State<'_, AppState>,
    article_id: Uuid,
    before: Option<chrono::DateTime<chrono::Utc>>,
) -> AppResult<AnalysisRunPage> {
    let (scope, account) = remote_scope(&state).await?;
    let (runs, next_cursor) =
        list_analysis_runs(account.as_str(), scope.workspace_id, article_id, before).await?;
    Ok(AnalysisRunPage { runs, next_cursor })
}

#[tauri::command]
pub(crate) async fn get_analysis_article_result_command(
    state: State<'_, AppState>,
    article_id: Uuid,
    run_id: Uuid,
) -> AppResult<RemoteAnalysisResult> {
    let (scope, account) = remote_scope(&state).await?;
    get_analysis_result(account.as_str(), scope.workspace_id, article_id, run_id).await
}

#[tauri::command]
pub(crate) async fn run_analysis_article_command(
    app: AppHandle,
    state: State<'_, AppState>,
    article_id: Uuid,
    article_revision: i64,
    run_id: Option<Uuid>,
    parameter_values: Option<BTreeMap<String, serde_json::Value>>,
) -> AppResult<AnalysisRunCommandResult> {
    let parameter_values = parameter_values.unwrap_or_default();
    let (scope, account) = remote_scope(&state).await?;
    let registration_guard = analysis_runner_registration_guard().await;
    let mut device_id = state
        .services
        .analysis_article
        .runner_device_id(account.as_str(), scope.workspace_id)
        .await?
        .to_string();
    let runner =
        match register_analysis_runner(account.as_str(), scope.workspace_id, &device_id, false)
            .await
        {
            Ok(runner) => runner,
            Err(error) if analysis_runner_capability_is_missing(&error) => {
                device_id = state
                    .services
                    .analysis_article
                    .replace_runner_device_id(account.as_str(), scope.workspace_id)
                    .await?
                    .to_string();
                register_analysis_runner(account.as_str(), scope.workspace_id, &device_id, false)
                    .await?
            }
            Err(error) => return Err(error),
        };
    drop(registration_guard);
    let run_id = run_id.unwrap_or_else(Uuid::new_v4);
    let (_, article) = start_analysis_run(
        account.as_str(),
        scope.workspace_id,
        article_id,
        article_revision,
        runner.runner.id,
        run_id,
        AnalysisRunTrigger::Manual,
        &parameter_values,
        runner.capability(),
        runner.generation(),
        None,
    )
    .await?;
    let request = AnalysisDefinitionRunRequest {
        workspace_id: Some(scope.workspace_id),
        article_id,
        article_revision,
        definition: article.definition.clone(),
        connections: article.connections.clone(),
        parameter_values,
        run_id,
        persist_local_result: true,
    };
    let execution = state.services.analysis_article.run_definition(request);
    tokio::pin!(execution);
    let mut poll = tokio::time::interval(std::time::Duration::from_secs(1));
    poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    poll.tick().await;
    let local = loop {
        tokio::select! {
            result = &mut execution => break result,
            _ = poll.tick() => {
                match get_analysis_run(account.as_str(), scope.workspace_id, article_id, run_id).await {
                    Ok(remote) if remote.cancel_requested_at.is_some()
                        || remote.state != AnalysisRunState::Running => {
                        cancel::cancel(run_id);
                    }
                    Ok(_) => {}
                    Err(error) => {
                        tracing::warn!(
                            run_id = %run_id,
                            error_kind = error.kind(),
                            "Analysis run cancellation poll deferred"
                        );
                    }
                }
            }
        }
    };

    match local {
        Ok(result) => {
            let cancelled =
                get_analysis_run(account.as_str(), scope.workspace_id, article_id, run_id)
                    .await
                    .ok()
                    .is_some_and(|run| run.cancel_requested_at.is_some());
            if cancelled {
                let error = Some(AnalysisRunError {
                    kind: "cancelled".into(),
                    message: "Analysis Article run was cancelled".into(),
                });
                complete_analysis_run(
                    account.as_str(),
                    scope.workspace_id,
                    article_id,
                    run_id,
                    runner.capability(),
                    AnalysisRunState::Cancelled,
                    &result.query_receipts,
                    &[],
                    &error,
                )
                .await?;
                return Err(AppError::Safety("Analysis Article run cancelled".into()));
            }
            let shared_result = (article.state == AnalysisArticleState::Review
                && article.definition.refresh.share_reviewed_results)
                || article.live_revision == Some(article.revision);
            let fragments = if shared_result {
                result.fragments.as_slice()
            } else {
                &[]
            };
            let run = complete_analysis_run(
                account.as_str(),
                scope.workspace_id,
                article_id,
                run_id,
                runner.capability(),
                AnalysisRunState::Succeeded,
                &result.query_receipts,
                fragments,
                &None,
            )
            .await?;
            if let Err(error) = super::signals::evaluate_analysis_signals(
                super::signals::AnalysisSignalEvaluation {
                    app: Some(&app),
                    state: &state,
                    account_id: account.as_str(),
                    workspace_id: scope.workspace_id,
                    article: &article,
                    runner_id: runner.runner.id,
                    runner_capability: runner.capability(),
                    run: &run,
                    fragments: &result.fragments,
                    execution_error: None,
                },
            )
            .await
            {
                tracing::warn!(
                    article_id = %article_id,
                    run_id = %run_id,
                    error_kind = error.kind(),
                    "Analysis signal evaluation deferred after manual run"
                );
            }
            Ok(AnalysisRunCommandResult {
                run,
                result,
                shared_result,
            })
        }
        Err(error) => {
            let terminal_state = if cancelled_error(&error) {
                AnalysisRunState::Cancelled
            } else if matches!(&error, AppError::Blocked { .. } | AppError::NotFound(_)) {
                AnalysisRunState::Stale
            } else {
                AnalysisRunState::Failed
            };
            let completion_error = Some(bounded_error(&error));
            match complete_analysis_run(
                account.as_str(),
                scope.workspace_id,
                article_id,
                run_id,
                runner.capability(),
                terminal_state,
                &[],
                &[],
                &completion_error,
            )
            .await
            {
                Ok(run) if terminal_state != AnalysisRunState::Cancelled => {
                    if let Err(signal_error) = super::signals::evaluate_analysis_signals(
                        super::signals::AnalysisSignalEvaluation {
                            app: Some(&app),
                            state: &state,
                            account_id: account.as_str(),
                            workspace_id: scope.workspace_id,
                            article: &article,
                            runner_id: runner.runner.id,
                            runner_capability: runner.capability(),
                            run: &run,
                            fragments: &[],
                            execution_error: Some(&error),
                        },
                    )
                    .await
                    {
                        tracing::warn!(
                            article_id = %article_id,
                            run_id = %run_id,
                            error_kind = signal_error.kind(),
                            "Analysis failure signal evaluation deferred"
                        );
                    }
                }
                Ok(_) => {}
                Err(completion_failure) => {
                    tracing::error!(
                        run_id = %run_id,
                        error_kind = completion_failure.kind(),
                        "Analysis run failure receipt could not be committed"
                    );
                }
            }
            Err(error)
        }
    }
}

#[tauri::command]
pub(crate) async fn cancel_analysis_article_run(
    state: State<'_, AppState>,
    article_id: Uuid,
    run_id: Uuid,
) -> AppResult<RemoteAnalysisRun> {
    let (scope, account) = remote_scope(&state).await?;
    let remote =
        cancel_remote_analysis_run(account.as_str(), scope.workspace_id, article_id, run_id)
            .await?;
    cancel::cancel(run_id);
    Ok(remote)
}
