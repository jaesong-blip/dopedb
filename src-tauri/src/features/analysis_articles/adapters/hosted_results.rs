//! Hosted Analysis result staging and completion delivery.

use super::*;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompleteRunRequest<'a> {
    state: AnalysisRunState,
    query_receipts: &'a [AnalysisQueryReceipt],
    fragment_manifest: &'a [AnalysisResultFragmentReference],
    error: &'a Option<AnalysisRunError>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InlineCompleteRunRequest<'a> {
    state: AnalysisRunState,
    query_receipts: &'a [AnalysisQueryReceipt],
    fragments: &'a [AnalysisResultFragment],
    error: &'a Option<AnalysisRunError>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AnalysisResultFragmentReference {
    block_id: String,
    ordinal: u16,
    payload_hash: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StageFragmentRequest<'a> {
    fragment: &'a AnalysisResultFragment,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StagedFragmentResponse {
    block_id: String,
    ordinal: u16,
    payload_hash: String,
}

enum StageFragmentOutcome {
    Staged(AnalysisResultFragmentReference),
    InlineCompatibility,
}

async fn stage_analysis_result_fragment(
    user_id: &str,
    workspace_id: Uuid,
    article_id: Uuid,
    run_id: Uuid,
    token: &str,
    runner_capability: &str,
    fragment: &AnalysisResultFragment,
) -> AppResult<StageFragmentOutcome> {
    let expected_hash = canonical_hash(&serde_json::to_value(fragment)?)?;
    let mut last_error = None;
    for attempt in 0..RESULT_UPLOAD_ATTEMPTS {
        let sent = client()?
            .post(format!(
                "{}/api/v1/workspaces/{workspace_id}/analyses/{article_id}/runs/{run_id}/fragments",
                origin()?
            ))
            .bearer_auth(token)
            .header(ANALYSIS_RUNNER_CAPABILITY_HEADER, runner_capability)
            .timeout(Duration::from_secs(30))
            .json(&StageFragmentRequest { fragment })
            .send()
            .await;
        let (retryable, result) = match sent {
            Ok(raw)
                if matches!(
                    raw.status(),
                    StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED
                ) =>
            {
                return Ok(StageFragmentOutcome::InlineCompatibility)
            }
            Ok(raw) => {
                let status = raw.status();
                let retryable = status.is_server_error()
                    || matches!(
                        status,
                        StatusCode::REQUEST_TIMEOUT | StatusCode::TOO_MANY_REQUESTS
                    )
                    || status.is_success();
                let parsed: AppResult<StagedFragmentResponse> = response(
                    raw,
                    user_id,
                    "staged Analysis result fragment",
                    MAX_DEFINITION_RESPONSE_BYTES,
                )
                .await;
                (retryable, parsed)
            }
            Err(error) => (
                true,
                Err(request_error("staging an Analysis result fragment", error)),
            ),
        };
        match result {
            Ok(staged)
                if staged.block_id == fragment.block_id
                    && staged.ordinal == fragment.ordinal
                    && staged.payload_hash == expected_hash =>
            {
                return Ok(StageFragmentOutcome::Staged(
                    AnalysisResultFragmentReference {
                        block_id: staged.block_id,
                        ordinal: staged.ordinal,
                        payload_hash: staged.payload_hash,
                    },
                ));
            }
            Ok(_) => {
                last_error = Some(AppError::Network(
                    "staged Analysis result changed fragment identity or hash".into(),
                ));
            }
            Err(error) if !retryable => return Err(error),
            Err(error) => last_error = Some(error),
        }
        if attempt + 1 < RESULT_UPLOAD_ATTEMPTS {
            tokio::time::sleep(Duration::from_millis(150 * (attempt as u64 + 1))).await;
        }
    }
    Err(last_error
        .unwrap_or_else(|| AppError::Network("staging an Analysis result fragment failed".into())))
}

enum CompletionOutcome {
    Completed(Box<RemoteAnalysisRun>),
    InlineCompatibility,
}

pub(super) fn should_use_inline_completion_fallback(
    status: StatusCode,
    protocol: Option<&str>,
) -> bool {
    status == StatusCode::BAD_REQUEST && protocol != Some(STAGED_ANALYSIS_RESULT_PROTOCOL)
}

#[expect(
    clippy::too_many_arguments,
    reason = "completion replay validation keeps every exact run identity explicit"
)]
async fn patch_analysis_completion(
    user_id: &str,
    workspace_id: Uuid,
    article_id: Uuid,
    run_id: Uuid,
    state: AnalysisRunState,
    token: &str,
    runner_capability: &str,
    payload: &[u8],
    allow_inline_fallback: bool,
) -> AppResult<CompletionOutcome> {
    let mut last_error = None;
    for attempt in 0..RESULT_UPLOAD_ATTEMPTS {
        let sent = client()?
            .patch(format!(
                "{}/api/v1/workspaces/{workspace_id}/analyses/{article_id}/runs/{run_id}",
                origin()?
            ))
            .bearer_auth(token)
            .header(ANALYSIS_RUNNER_CAPABILITY_HEADER, runner_capability)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .timeout(Duration::from_secs(60))
            .body(payload.to_vec())
            .send()
            .await;
        let (retryable, result) = match sent {
            Ok(raw)
                if allow_inline_fallback
                    && should_use_inline_completion_fallback(
                        raw.status(),
                        raw.headers()
                            .get(ANALYSIS_RESULT_PROTOCOL_HEADER)
                            .and_then(|value| value.to_str().ok()),
                    ) =>
            {
                return Ok(CompletionOutcome::InlineCompatibility);
            }
            Ok(raw) => {
                let status = raw.status();
                let retryable = status.is_server_error()
                    || matches!(
                        status,
                        StatusCode::REQUEST_TIMEOUT | StatusCode::TOO_MANY_REQUESTS
                    )
                    || status.is_success();
                let parsed: AppResult<RunResponse> = response(
                    raw,
                    user_id,
                    "completed Analysis run",
                    MAX_DEFINITION_RESPONSE_BYTES,
                )
                .await;
                (retryable, parsed.map(|body| body.run))
            }
            Err(error) => (
                true,
                Err(request_error("completing an Analysis run", error)),
            ),
        };
        match result {
            Ok(run) => {
                validate_run(&run, article_id, Some(run_id))?;
                if run.state == state && run.finished_at.is_some() {
                    return Ok(CompletionOutcome::Completed(Box::new(run)));
                }
                last_error = Some(AppError::Network(
                    "Analysis run completion changed terminal state".into(),
                ));
            }
            Err(error) if !retryable => return Err(error),
            Err(error) => last_error = Some(error),
        }
        if attempt + 1 < RESULT_UPLOAD_ATTEMPTS {
            tokio::time::sleep(Duration::from_millis(200 * (attempt as u64 + 1))).await;
        }
    }
    Err(last_error.unwrap_or_else(|| AppError::Network("completing an Analysis run failed".into())))
}

async fn fail_analysis_result_delivery(
    user_id: &str,
    workspace_id: Uuid,
    article_id: Uuid,
    run_id: Uuid,
    token: &str,
    runner_capability: &str,
    inline_compatibility: bool,
) {
    let error = Some(AnalysisRunError {
        kind: "result_upload_failed".into(),
        message: "Analysis result delivery failed after bounded retries".into(),
    });
    let payload = if inline_compatibility {
        serde_json::to_vec(&InlineCompleteRunRequest {
            state: AnalysisRunState::Failed,
            query_receipts: &[],
            fragments: &[],
            error: &error,
        })
    } else {
        serde_json::to_vec(&CompleteRunRequest {
            state: AnalysisRunState::Failed,
            query_receipts: &[],
            fragment_manifest: &[],
            error: &error,
        })
    };
    if let Ok(payload) = payload {
        if let Err(failure) = patch_analysis_completion(
            user_id,
            workspace_id,
            article_id,
            run_id,
            AnalysisRunState::Failed,
            token,
            runner_capability,
            &payload,
            false,
        )
        .await
        {
            tracing::warn!(
                run_id = %run_id,
                error_kind = failure.kind(),
                "Analysis run could not be recovered after result delivery failure"
            );
        }
    }
}

#[expect(
    clippy::too_many_arguments,
    reason = "the hosted completion request keeps the exact run identity and bounded evidence explicit"
)]
pub(crate) async fn complete_analysis_run(
    user_id: &str,
    workspace_id: Uuid,
    article_id: Uuid,
    run_id: Uuid,
    runner_capability: &str,
    state: AnalysisRunState,
    query_receipts: &[AnalysisQueryReceipt],
    fragments: &[AnalysisResultFragment],
    error: &Option<AnalysisRunError>,
) -> AppResult<RemoteAnalysisRun> {
    let token = token(user_id).await?;
    let terminal_receipts = if state == AnalysisRunState::Succeeded {
        query_receipts
    } else {
        &[]
    };
    let mut fragment_manifest = Vec::with_capacity(fragments.len());
    let mut inline_compatibility = false;
    for fragment in fragments {
        match stage_analysis_result_fragment(
            user_id,
            workspace_id,
            article_id,
            run_id,
            token.as_str(),
            runner_capability,
            fragment,
        )
        .await
        {
            Ok(StageFragmentOutcome::Staged(reference)) => fragment_manifest.push(reference),
            Ok(StageFragmentOutcome::InlineCompatibility) => {
                inline_compatibility = true;
                break;
            }
            Err(upload_error) => {
                fail_analysis_result_delivery(
                    user_id,
                    workspace_id,
                    article_id,
                    run_id,
                    token.as_str(),
                    runner_capability,
                    false,
                )
                .await;
                return Err(upload_error);
            }
        }
    }

    let staged_payload = serde_json::to_vec(&CompleteRunRequest {
        state,
        query_receipts: terminal_receipts,
        fragment_manifest: &fragment_manifest,
        error,
    })?;
    let mut outcome = if inline_compatibility {
        CompletionOutcome::InlineCompatibility
    } else {
        match patch_analysis_completion(
            user_id,
            workspace_id,
            article_id,
            run_id,
            state,
            token.as_str(),
            runner_capability,
            &staged_payload,
            fragments.is_empty(),
        )
        .await
        {
            Ok(outcome) => outcome,
            Err(completion_error) => {
                if let Ok(run) = get_analysis_run(user_id, workspace_id, article_id, run_id).await {
                    if run.state == state && run.finished_at.is_some() {
                        return Ok(run);
                    }
                }
                if state != AnalysisRunState::Failed {
                    fail_analysis_result_delivery(
                        user_id,
                        workspace_id,
                        article_id,
                        run_id,
                        token.as_str(),
                        runner_capability,
                        false,
                    )
                    .await;
                }
                return Err(completion_error);
            }
        }
    };
    if matches!(&outcome, CompletionOutcome::InlineCompatibility) {
        let inline_payload = serde_json::to_vec(&InlineCompleteRunRequest {
            state,
            query_receipts: terminal_receipts,
            fragments,
            error,
        })?;
        if inline_payload.len() > MAX_INLINE_COMPLETION_REQUEST_BYTES {
            fail_analysis_result_delivery(
                user_id,
                workspace_id,
                article_id,
                run_id,
                token.as_str(),
                runner_capability,
                true,
            )
            .await;
            return Err(AppError::Network(
                "the workspace service must be updated before it can accept this large Analysis result"
                    .into(),
            ));
        }
        outcome = match patch_analysis_completion(
            user_id,
            workspace_id,
            article_id,
            run_id,
            state,
            token.as_str(),
            runner_capability,
            &inline_payload,
            false,
        )
        .await
        {
            Ok(outcome) => outcome,
            Err(completion_error) => {
                if let Ok(run) = get_analysis_run(user_id, workspace_id, article_id, run_id).await {
                    if run.state == state && run.finished_at.is_some() {
                        return Ok(run);
                    }
                }
                if state != AnalysisRunState::Failed {
                    fail_analysis_result_delivery(
                        user_id,
                        workspace_id,
                        article_id,
                        run_id,
                        token.as_str(),
                        runner_capability,
                        true,
                    )
                    .await;
                }
                return Err(completion_error);
            }
        };
    }
    match outcome {
        CompletionOutcome::Completed(run) => Ok(*run),
        CompletionOutcome::InlineCompatibility => Err(AppError::Network(
            "workspace Analysis result protocol negotiation failed".into(),
        )),
    }
}
