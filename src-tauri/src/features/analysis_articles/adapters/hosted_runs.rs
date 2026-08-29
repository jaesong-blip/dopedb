//! Hosted run, result-delivery, and lease operations.

use super::*;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteAnalysisRun {
    pub(crate) id: Uuid,
    pub(crate) article_id: Uuid,
    pub(crate) article_revision: i64,
    pub(crate) runner_id: Uuid,
    #[serde(default)]
    pub(crate) runner_capability_generation: Option<u64>,
    pub(crate) lease_id: Option<Uuid>,
    pub(crate) trigger: AnalysisRunTrigger,
    pub(crate) state: AnalysisRunState,
    pub(crate) parameter_values: BTreeMap<String, serde_json::Value>,
    pub(crate) parameter_hash: String,
    pub(crate) definition_hash: String,
    pub(crate) schema_fingerprints: BTreeMap<String, String>,
    pub(crate) row_count: u64,
    pub(crate) byte_count: u64,
    pub(crate) result_hash: Option<String>,
    pub(crate) error_kind: Option<String>,
    pub(crate) error_message: Option<String>,
    pub(crate) cancel_requested_at: Option<DateTime<Utc>>,
    pub(crate) cancel_requested_by_member_id: Option<String>,
    pub(crate) started_at: Option<DateTime<Utc>>,
    pub(crate) finished_at: Option<DateTime<Utc>>,
    pub(crate) created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteAnalysisRunControl {
    pub(crate) state: AnalysisRunState,
    pub(crate) cancel_requested_at: Option<DateTime<Utc>>,
    pub(crate) authorized: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RunControlResponse {
    control: RemoteAnalysisRunControl,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RunResponse {
    pub(super) run: RemoteAnalysisRun,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct StartedRunResponse {
    run: RemoteAnalysisRun,
    article: AnalysisArticleRecord,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunCollectionResponse {
    runs: Vec<RemoteAnalysisRun>,
    next_cursor: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartRunRequest<'a> {
    id: Uuid,
    article_revision: i64,
    runner_id: Uuid,
    trigger: AnalysisRunTrigger,
    parameter_values: &'a BTreeMap<String, serde_json::Value>,
}

#[expect(
    clippy::too_many_arguments,
    reason = "the hosted exact-run request keeps every revision, trigger, and lease pin explicit"
)]
pub(crate) async fn start_analysis_run(
    user_id: &str,
    workspace_id: Uuid,
    article_id: Uuid,
    article_revision: i64,
    runner_id: Uuid,
    run_id: Uuid,
    trigger: AnalysisRunTrigger,
    parameter_values: &BTreeMap<String, serde_json::Value>,
    runner_capability: &str,
    runner_capability_generation: u64,
    lease: Option<&RemoteAnalysisLease>,
) -> AppResult<(RemoteAnalysisRun, AnalysisArticleRecord)> {
    let token = token(user_id).await?;
    let mut request = client()?
        .post(format!(
            "{}/api/v1/workspaces/{workspace_id}/analyses/{article_id}/runs",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .header(ANALYSIS_RUNNER_CAPABILITY_HEADER, runner_capability)
        .json(&StartRunRequest {
            id: run_id,
            article_revision,
            runner_id,
            trigger,
            parameter_values,
        });
    if let Some(lease) = lease {
        if lease.article_id != article_id
            || lease.article_revision != article_revision
            || lease.runner_id != runner_id
            || lease.runner_capability_generation != runner_capability_generation
        {
            return Err(AppError::Config(
                "Analysis refresh lease changed run authority".into(),
            ));
        }
        request = request
            .header("x-dopedb-analysis-lease", lease.id.to_string())
            .header("x-dopedb-analysis-capability", lease.capability.as_str());
    }
    let raw = request
        .send()
        .await
        .map_err(|error| request_error("starting an Analysis run", error))?;
    let body: StartedRunResponse = response(
        raw,
        user_id,
        "started Analysis run",
        MAX_DEFINITION_RESPONSE_BYTES,
    )
    .await?;
    validate_run(&body.run, article_id, Some(run_id))?;
    validate_article(&body.article, Some(article_id))?;
    if body.run.runner_id != runner_id
        || body.run.runner_capability_generation != Some(runner_capability_generation)
        || body.run.article_revision != article_revision
        || body.run.state != AnalysisRunState::Running
        || body.article.revision != article_revision
    {
        return Err(AppError::Network(
            "started Analysis run changed exact revision authority".into(),
        ));
    }
    Ok((body.run, body.article))
}

pub(crate) async fn get_analysis_run(
    user_id: &str,
    workspace_id: Uuid,
    article_id: Uuid,
    run_id: Uuid,
) -> AppResult<RemoteAnalysisRun> {
    let token = token(user_id).await?;
    let raw = client()?
        .get(format!(
            "{}/api/v1/workspaces/{workspace_id}/analyses/{article_id}/runs/{run_id}",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .send()
        .await
        .map_err(|error| request_error("checking an Analysis run", error))?;
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct StatusResponse {
        run: RemoteAnalysisRun,
        receipts: Vec<serde_json::Value>,
    }
    let body: StatusResponse = response(
        raw,
        user_id,
        "Analysis run status",
        MAX_DEFINITION_RESPONSE_BYTES,
    )
    .await?;
    let _receipt_count = body.receipts.len();
    validate_run(&body.run, article_id, Some(run_id))?;
    Ok(body.run)
}

pub(crate) async fn get_analysis_run_control(
    user_id: &str,
    workspace_id: Uuid,
    article_id: Uuid,
    run_id: Uuid,
    runner_capability: &str,
    lease_capability: Option<&str>,
) -> AppResult<RemoteAnalysisRunControl> {
    let token = token(user_id).await?;
    let mut request = client()?
        .get(format!(
            "{}/api/v1/workspaces/{workspace_id}/analyses/{article_id}/runs/{run_id}/control",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .header(ANALYSIS_RUNNER_CAPABILITY_HEADER, runner_capability);
    if let Some(capability) = lease_capability {
        request = request.header("x-dopedb-analysis-capability", capability);
    }
    let raw = request
        .send()
        .await
        .map_err(|error| request_error("checking Analysis run control", error))?;
    let body: RunControlResponse = response(
        raw,
        user_id,
        "Analysis run control",
        MAX_DEFINITION_RESPONSE_BYTES,
    )
    .await?;
    Ok(body.control)
}

pub(crate) async fn list_analysis_runs(
    user_id: &str,
    workspace_id: Uuid,
    article_id: Uuid,
    before: Option<DateTime<Utc>>,
) -> AppResult<(Vec<RemoteAnalysisRun>, Option<String>)> {
    let token = token(user_id).await?;
    let mut url = Url::parse(&format!(
        "{}/api/v1/workspaces/{workspace_id}/analyses/{article_id}/runs",
        origin()?
    ))
    .map_err(|_| AppError::Config("Analysis run endpoint is invalid".into()))?;
    if let Some(before) = before {
        url.query_pairs_mut()
            .append_pair("before", &before.to_rfc3339());
    }
    let raw = client()?
        .get(url)
        .bearer_auth(token.as_str())
        .send()
        .await
        .map_err(|error| request_error("loading Analysis runs", error))?;
    let body: RunCollectionResponse = response(
        raw,
        user_id,
        "Analysis run collection",
        MAX_DEFINITION_RESPONSE_BYTES,
    )
    .await?;
    if body.runs.len() > 100 {
        return Err(AppError::Network(
            "Analysis run collection exceeded its page bound".into(),
        ));
    }
    for run in &body.runs {
        validate_run(run, article_id, None)?;
    }
    Ok((body.runs, body.next_cursor))
}

pub(crate) async fn cancel_analysis_run(
    user_id: &str,
    workspace_id: Uuid,
    article_id: Uuid,
    run_id: Uuid,
) -> AppResult<RemoteAnalysisRun> {
    let token = token(user_id).await?;
    let raw = client()?
        .post(format!(
            "{}/api/v1/workspaces/{workspace_id}/analyses/{article_id}/runs/{run_id}/cancel",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .send()
        .await
        .map_err(|error| request_error("cancelling an Analysis run", error))?;
    let body: RunResponse = response(
        raw,
        user_id,
        "Analysis run cancellation",
        MAX_DEFINITION_RESPONSE_BYTES,
    )
    .await?;
    validate_run(&body.run, article_id, Some(run_id))?;
    if body.run.cancel_requested_at.is_none() {
        return Err(AppError::Network(
            "Analysis run cancellation did not record intent".into(),
        ));
    }
    Ok(body.run)
}

pub(crate) async fn get_analysis_result(
    user_id: &str,
    workspace_id: Uuid,
    article_id: Uuid,
    run_id: Uuid,
) -> AppResult<RemoteAnalysisResult> {
    let token = token(user_id).await?;
    let raw = client()?
        .get(format!(
            "{}/api/v1/workspaces/{workspace_id}/analyses/{article_id}/runs/{run_id}/results",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .map_err(|error| request_error("loading an Analysis result", error))?;
    let body: RemoteAnalysisResult =
        response(raw, user_id, "Analysis result", MAX_RESULT_RESPONSE_BYTES).await?;
    if body.run.id != run_id
        || body.run.article_id != article_id
        || body.run.state != AnalysisRunState::Succeeded
        || body.fragments.len() > 256
    {
        return Err(AppError::Network(
            "Analysis result changed run identity".into(),
        ));
    }
    Ok(body)
}

pub(crate) async fn claim_analysis_refresh_lease(
    user_id: &str,
    workspace_id: Uuid,
    runner_id: Uuid,
    device_id: &str,
    background: bool,
    runner_capability: &str,
    runner_capability_generation: u64,
) -> AppResult<Option<RemoteAnalysisLease>> {
    let token = token(user_id).await?;
    let raw = client()?
        .post(format!(
            "{}/api/v1/workspaces/{workspace_id}/analyses/leases",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .header(ANALYSIS_RUNNER_CAPABILITY_HEADER, runner_capability)
        .json(&LeaseClaimRequest {
            runner_id,
            device_id,
            background,
        })
        .send()
        .await
        .map_err(|error| request_error("claiming Analysis refresh work", error))?;
    let body: LeaseResponse = response(
        raw,
        user_id,
        "Analysis refresh lease",
        MAX_DEFINITION_RESPONSE_BYTES,
    )
    .await?;
    let Some(lease) = body.lease else {
        return Ok(None);
    };
    let now = Utc::now();
    if lease.runner_id != runner_id
        || lease.runner_capability_generation != runner_capability_generation
        || lease.runner_capability_generation == 0
        || lease.article_revision < 1
        || lease.article.id != lease.article_id
        || lease.article.deleted
        || lease.capability.len() != 64
        || !lease
            .capability
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || lease.expires_at <= now
        || lease.expires_at > now + chrono::Duration::minutes(3)
        || lease.scheduled_at > now + chrono::Duration::seconds(30)
    {
        return Err(AppError::Network(
            "Analysis refresh lease returned invalid identity or authority".into(),
        ));
    }
    Ok(Some(RemoteAnalysisLease {
        id: lease.id,
        article_id: lease.article_id,
        article_revision: lease.article_revision,
        runner_id: lease.runner_id,
        runner_capability_generation: lease.runner_capability_generation,
        scheduled_at: lease.scheduled_at,
        expires_at: lease.expires_at,
        capability: lease.capability,
        runner_capability: Zeroizing::new(runner_capability.to_owned()),
        parameter_values: lease.parameter_values,
        article: lease.article,
    }))
}

pub(crate) async fn release_analysis_refresh_lease(
    user_id: &str,
    workspace_id: Uuid,
    lease: &RemoteAnalysisLease,
) -> AppResult<bool> {
    let token = token(user_id).await?;
    let raw = client()?
        .delete(format!(
            "{}/api/v1/workspaces/{workspace_id}/analyses/leases/{}",
            origin()?,
            lease.id
        ))
        .bearer_auth(token.as_str())
        .header(
            ANALYSIS_RUNNER_CAPABILITY_HEADER,
            lease.runner_capability.as_str(),
        )
        .header("x-dopedb-analysis-capability", lease.capability.as_str())
        .send()
        .await
        .map_err(|error| request_error("releasing an Analysis refresh lease", error))?;
    let body: LeaseReleaseResponse = response(
        raw,
        user_id,
        "Analysis refresh lease release",
        MAX_DEFINITION_RESPONSE_BYTES,
    )
    .await?;
    Ok(body.revoked)
}
