//! Hosted signal and notification operations.

use super::*;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AnalysisSignalSeverity {
    Info,
    Warning,
    Critical,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AnalysisSignalChannel {
    Desktop,
    WorkspaceWeb,
    Email,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum AnalysisSignalCondition {
    ThresholdAbove { value: f64 },
    ThresholdBelow { value: f64 },
    AbsoluteChange { value: f64 },
    PercentageChange { percentage: f64 },
    MissingData { count: u16 },
    ConsecutiveFailure { count: u16 },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AnalysisSignalDefinition {
    pub(crate) condition: AnalysisSignalCondition,
    pub(crate) baseline_window_seconds: Option<u64>,
    pub(crate) minimum_sample_count: u64,
    pub(crate) cooldown_seconds: u64,
    pub(crate) rearm_after_normal_count: u16,
    pub(crate) severity: AnalysisSignalSeverity,
    pub(crate) recipient_member_ids: Vec<Uuid>,
    pub(crate) channels: Vec<AnalysisSignalChannel>,
    pub(crate) production_confirmed: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AnalysisSignalCreateRequest {
    pub(crate) id: Uuid,
    pub(crate) article_revision: i64,
    pub(crate) block_id: String,
    pub(crate) definition: AnalysisSignalDefinition,
    pub(crate) enabled: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteAnalysisSignal {
    pub(crate) id: Uuid,
    pub(crate) article_id: Uuid,
    pub(crate) article_revision: i64,
    pub(crate) block_id: String,
    pub(crate) definition: AnalysisSignalDefinition,
    pub(crate) owner_member_id: Option<String>,
    pub(crate) enabled: bool,
    pub(crate) revision: i64,
    pub(crate) last_evaluated_run_id: Option<Uuid>,
    pub(crate) last_observed_state: String,
    pub(crate) created_at: DateTime<Utc>,
    pub(crate) updated_at: DateTime<Utc>,
    pub(crate) deleted_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SignalResponse {
    signal: RemoteAnalysisSignal,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SignalCollectionResponse {
    signals: Vec<RemoteAnalysisSignal>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeletedSignalResponse {
    deleted: bool,
    revision: i64,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AnalysisSignalObservedState {
    Normal,
    Firing,
    NoData,
    Error,
    Stale,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AnalysisSignalReceiptRequest {
    pub(crate) id: Uuid,
    pub(crate) signal_revision: i64,
    pub(crate) run_id: Uuid,
    pub(crate) observed_state: AnalysisSignalObservedState,
    pub(crate) result_hash: Option<String>,
    pub(crate) schema_fingerprint: String,
    pub(crate) dedupe_key: String,
    pub(crate) error_kind: Option<String>,
    pub(crate) evaluated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteAnalysisSignalReceipt {
    pub(crate) id: Uuid,
    pub(crate) signal_id: Uuid,
    pub(crate) signal_revision: i64,
    pub(crate) run_id: Uuid,
    pub(crate) runner_id: Uuid,
    pub(crate) observed_state: AnalysisSignalObservedState,
    pub(crate) state: String,
    pub(crate) result_hash: Option<String>,
    pub(crate) schema_fingerprint: String,
    pub(crate) transition_sequence: i64,
    pub(crate) error_kind: Option<String>,
    pub(crate) evaluated_at: DateTime<Utc>,
    pub(crate) created_at: DateTime<Utc>,
    pub(crate) notification_count: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SignalReceiptResponse {
    receipt: RemoteAnalysisSignalReceipt,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteAnalysisSignalHistoryReceipt {
    pub(crate) id: Uuid,
    pub(crate) signal_revision: i64,
    pub(crate) run_id: Uuid,
    pub(crate) observed_state: AnalysisSignalObservedState,
    pub(crate) state: String,
    pub(crate) result_hash: Option<String>,
    pub(crate) schema_fingerprint: String,
    pub(crate) transition_sequence: i64,
    pub(crate) error_kind: Option<String>,
    pub(crate) evaluated_at: DateTime<Utc>,
    pub(crate) created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SignalReceiptCollectionResponse {
    receipts: Vec<RemoteAnalysisSignalHistoryReceipt>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AnalysisCollaborator {
    pub(crate) id: Uuid,
    pub(crate) name: String,
    pub(crate) role: String,
    pub(crate) can_own_analysis: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AnalysisCollaboratorDirectory {
    pub(crate) workspace_id: Uuid,
    pub(crate) current_member_id: Uuid,
    pub(crate) current_role: String,
    pub(crate) members: Vec<AnalysisCollaborator>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteAnalysisNotification {
    pub(crate) id: Uuid,
    pub(crate) article_id: Uuid,
    pub(crate) article_title: String,
    pub(crate) signal_id: Uuid,
    pub(crate) block_id: String,
    pub(crate) signal_revision: i64,
    pub(crate) state: String,
    pub(crate) observed_state: AnalysisSignalObservedState,
    pub(crate) severity: AnalysisSignalSeverity,
    pub(crate) delivery_state: String,
    pub(crate) evaluated_at: DateTime<Utc>,
    pub(crate) created_at: DateTime<Utc>,
    pub(crate) read_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct NotificationCollectionResponse {
    notifications: Vec<RemoteAnalysisNotification>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadNotificationResponse {
    read: Vec<Uuid>,
}

pub(crate) async fn list_analysis_signals(
    user_id: &str,
    workspace_id: Uuid,
    article_id: Uuid,
) -> AppResult<Vec<RemoteAnalysisSignal>> {
    let token = token(user_id).await?;
    let raw = client()?
        .get(format!(
            "{}/api/v1/workspaces/{workspace_id}/analyses/{article_id}/signals",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .send()
        .await
        .map_err(|error| request_error("loading Analysis signals", error))?;
    let body: SignalCollectionResponse = response(
        raw,
        user_id,
        "Analysis signal collection",
        MAX_DEFINITION_RESPONSE_BYTES,
    )
    .await?;
    if body.signals.len() > 500 {
        return Err(AppError::Network(
            "Analysis signal collection is oversized".into(),
        ));
    }
    for signal in &body.signals {
        validate_signal(signal, article_id, None)?;
    }
    Ok(body.signals)
}

pub(crate) async fn create_analysis_signal(
    user_id: &str,
    workspace_id: Uuid,
    article_id: Uuid,
    request: &AnalysisSignalCreateRequest,
) -> AppResult<RemoteAnalysisSignal> {
    validate_signal_request(request, article_id)?;
    let token = token(user_id).await?;
    let raw = client()?
        .post(format!(
            "{}/api/v1/workspaces/{workspace_id}/analyses/{article_id}/signals",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .json(request)
        .send()
        .await
        .map_err(|error| request_error("creating an Analysis signal", error))?;
    let body: SignalResponse = response(
        raw,
        user_id,
        "created Analysis signal",
        MAX_DEFINITION_RESPONSE_BYTES,
    )
    .await?;
    validate_signal(&body.signal, article_id, Some(request.id))?;
    Ok(body.signal)
}

pub(crate) async fn update_analysis_signal(
    user_id: &str,
    workspace_id: Uuid,
    article_id: Uuid,
    signal_id: Uuid,
    expected_revision: i64,
    request: &AnalysisSignalCreateRequest,
) -> AppResult<RemoteAnalysisSignal> {
    validate_signal_request(request, article_id)?;
    if request.id != signal_id || expected_revision < 1 {
        return Err(AppError::Config(
            "Analysis signal update changed identity or revision".into(),
        ));
    }
    let token = token(user_id).await?;
    let raw = client()?
        .patch(format!(
            "{}/api/v1/workspaces/{workspace_id}/analyses/{article_id}/signals/{signal_id}",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .header(EXPECTED_REVISION_HEADER, expected_revision)
        .json(&json!({
            "action": "update",
            "articleRevision": request.article_revision,
            "blockId": request.block_id,
            "definition": request.definition,
        }))
        .send()
        .await
        .map_err(|error| request_error("updating an Analysis signal", error))?;
    let body: SignalResponse = response(
        raw,
        user_id,
        "updated Analysis signal",
        MAX_DEFINITION_RESPONSE_BYTES,
    )
    .await?;
    validate_signal(&body.signal, article_id, Some(signal_id))?;
    if body.signal.revision != expected_revision + 1 {
        return Err(AppError::Network(
            "Analysis signal revision did not advance exactly once".into(),
        ));
    }
    Ok(body.signal)
}

pub(crate) async fn set_analysis_signal_enabled(
    user_id: &str,
    workspace_id: Uuid,
    article_id: Uuid,
    signal_id: Uuid,
    expected_revision: i64,
    enabled: bool,
) -> AppResult<RemoteAnalysisSignal> {
    if expected_revision < 1 {
        return Err(AppError::Config(
            "Analysis signal expected revision must be positive".into(),
        ));
    }
    let token = token(user_id).await?;
    let raw = client()?
        .patch(format!(
            "{}/api/v1/workspaces/{workspace_id}/analyses/{article_id}/signals/{signal_id}",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .header(EXPECTED_REVISION_HEADER, expected_revision)
        .json(&json!({ "action": if enabled { "enable" } else { "disable" } }))
        .send()
        .await
        .map_err(|error| request_error("changing an Analysis signal", error))?;
    let body: SignalResponse = response(
        raw,
        user_id,
        "changed Analysis signal",
        MAX_DEFINITION_RESPONSE_BYTES,
    )
    .await?;
    validate_signal(&body.signal, article_id, Some(signal_id))?;
    if body.signal.enabled != enabled || body.signal.revision != expected_revision + 1 {
        return Err(AppError::Network(
            "Analysis signal state changed without exact revision evidence".into(),
        ));
    }
    Ok(body.signal)
}

pub(crate) async fn delete_analysis_signal(
    user_id: &str,
    workspace_id: Uuid,
    article_id: Uuid,
    signal_id: Uuid,
    expected_revision: i64,
) -> AppResult<i64> {
    let token = token(user_id).await?;
    let raw = client()?
        .delete(format!(
            "{}/api/v1/workspaces/{workspace_id}/analyses/{article_id}/signals/{signal_id}",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .header(EXPECTED_REVISION_HEADER, expected_revision)
        .send()
        .await
        .map_err(|error| request_error("deleting an Analysis signal", error))?;
    let body: DeletedSignalResponse = response(
        raw,
        user_id,
        "deleted Analysis signal",
        MAX_DEFINITION_RESPONSE_BYTES,
    )
    .await?;
    if !body.deleted || body.revision != expected_revision + 1 {
        return Err(AppError::Network(
            "Analysis signal deletion returned invalid revision evidence".into(),
        ));
    }
    Ok(body.revision)
}

pub(crate) async fn list_analysis_signal_receipts(
    user_id: &str,
    workspace_id: Uuid,
    article_id: Uuid,
    signal_id: Uuid,
) -> AppResult<Vec<RemoteAnalysisSignalHistoryReceipt>> {
    let token = token(user_id).await?;
    let raw = client()?
        .get(format!(
            "{}/api/v1/workspaces/{workspace_id}/analyses/{article_id}/signals/{signal_id}/receipts",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .send()
        .await
        .map_err(|error| request_error("loading Analysis signal history", error))?;
    let body: SignalReceiptCollectionResponse = response(
        raw,
        user_id,
        "Analysis signal receipt history",
        MAX_DEFINITION_RESPONSE_BYTES,
    )
    .await?;
    if body.receipts.len() > 200
        || body.receipts.iter().any(|receipt| {
            receipt.signal_revision < 1
                || receipt.transition_sequence < 1
                || receipt.schema_fingerprint.len() != 64
                || receipt
                    .result_hash
                    .as_ref()
                    .is_some_and(|hash| hash.len() != 64)
        })
    {
        return Err(AppError::Network(
            "Analysis signal history returned invalid evidence".into(),
        ));
    }
    Ok(body.receipts)
}

pub(crate) async fn submit_analysis_signal_receipt(
    user_id: &str,
    workspace_id: Uuid,
    article_id: Uuid,
    signal_id: Uuid,
    runner_id: Uuid,
    runner_capability: &str,
    receipt: &AnalysisSignalReceiptRequest,
) -> AppResult<RemoteAnalysisSignalReceipt> {
    let expected_dedupe = format!(
        "analysis-signal:{signal_id}:{}:{}",
        receipt.signal_revision, receipt.run_id
    );
    let positive = matches!(
        receipt.observed_state,
        AnalysisSignalObservedState::Normal
            | AnalysisSignalObservedState::Firing
            | AnalysisSignalObservedState::NoData
    );
    if receipt.signal_revision < 1
        || receipt.dedupe_key != expected_dedupe
        || receipt.schema_fingerprint.len() != 64
        || receipt
            .schema_fingerprint
            .bytes()
            .any(|byte| !byte.is_ascii_hexdigit())
        || (positive != receipt.result_hash.is_some())
        || (matches!(receipt.observed_state, AnalysisSignalObservedState::Error)
            != receipt.error_kind.is_some())
    {
        return Err(AppError::Config(
            "invalid Analysis signal evaluation evidence".into(),
        ));
    }
    let token = token(user_id).await?;
    let raw = client()?
        .post(format!(
            "{}/api/v1/workspaces/{workspace_id}/analyses/{article_id}/signals/{signal_id}/receipts",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .header(ANALYSIS_RUNNER_CAPABILITY_HEADER, runner_capability)
        .json(&json!({ "runnerId": runner_id, "receipt": receipt }))
        .send()
        .await
        .map_err(|error| request_error("submitting Analysis signal evidence", error))?;
    let body: SignalReceiptResponse = response(
        raw,
        user_id,
        "Analysis signal evidence",
        MAX_DEFINITION_RESPONSE_BYTES,
    )
    .await?;
    if body.receipt.id != receipt.id
        || body.receipt.signal_id != signal_id
        || body.receipt.run_id != receipt.run_id
        || body.receipt.runner_id != runner_id
        || body.receipt.signal_revision != receipt.signal_revision
        || body.receipt.result_hash != receipt.result_hash
        || body.receipt.schema_fingerprint != receipt.schema_fingerprint
        || body.receipt.transition_sequence < 1
    {
        return Err(AppError::Network(
            "Analysis signal evidence changed identity or exact run binding".into(),
        ));
    }
    Ok(body.receipt)
}

pub(crate) async fn list_analysis_notifications(
    user_id: &str,
    workspace_id: Uuid,
    channel: AnalysisSignalChannel,
) -> AppResult<Vec<RemoteAnalysisNotification>> {
    if channel == AnalysisSignalChannel::Email {
        return Err(AppError::Config(
            "email Analysis notifications are delivered outside Desktop".into(),
        ));
    }
    let channel = match channel {
        AnalysisSignalChannel::Desktop => "desktop",
        AnalysisSignalChannel::WorkspaceWeb => "workspace_web",
        AnalysisSignalChannel::Email => unreachable!(),
    };
    let token = token(user_id).await?;
    let raw = client()?
        .get(format!(
            "{}/api/v1/workspaces/{workspace_id}/analyses/notifications?channel={channel}",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .send()
        .await
        .map_err(|error| request_error("loading Analysis notifications", error))?;
    let body: NotificationCollectionResponse = response(
        raw,
        user_id,
        "Analysis notification inbox",
        MAX_DEFINITION_RESPONSE_BYTES,
    )
    .await?;
    if body.notifications.len() > 200
        || body.notifications.iter().any(|notification| {
            notification.article_title.trim().is_empty()
                || notification.article_title.chars().count() > 160
                || !safe_analysis_id(&notification.block_id)
                || notification.signal_revision < 1
                || !matches!(
                    notification.state.as_str(),
                    "normal" | "firing" | "recovered" | "no_data" | "error" | "stale"
                )
        })
    {
        return Err(AppError::Network(
            "Analysis notification inbox returned invalid evidence".into(),
        ));
    }
    Ok(body.notifications)
}

pub(crate) async fn mark_analysis_notifications_read(
    user_id: &str,
    workspace_id: Uuid,
    channel: AnalysisSignalChannel,
    notification_ids: &[Uuid],
) -> AppResult<Vec<Uuid>> {
    if notification_ids.is_empty() || notification_ids.len() > 100 {
        return Err(AppError::Config(
            "select 1 to 100 Analysis notifications".into(),
        ));
    }
    let channel = match channel {
        AnalysisSignalChannel::Desktop => "desktop",
        AnalysisSignalChannel::WorkspaceWeb => "workspace_web",
        AnalysisSignalChannel::Email => {
            return Err(AppError::Config(
                "email Analysis notifications cannot be marked from Desktop".into(),
            ))
        }
    };
    let token = token(user_id).await?;
    let raw = client()?
        .patch(format!(
            "{}/api/v1/workspaces/{workspace_id}/analyses/notifications?channel={channel}",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .json(&json!({ "notificationIds": notification_ids }))
        .send()
        .await
        .map_err(|error| request_error("reading Analysis notifications", error))?;
    let body: ReadNotificationResponse = response(
        raw,
        user_id,
        "read Analysis notifications",
        MAX_DEFINITION_RESPONSE_BYTES,
    )
    .await?;
    let requested = notification_ids.iter().copied().collect::<HashSet<_>>();
    if body.read.iter().any(|id| !requested.contains(id)) {
        return Err(AppError::Network(
            "Analysis notification acknowledgement changed selection".into(),
        ));
    }
    Ok(body.read)
}
