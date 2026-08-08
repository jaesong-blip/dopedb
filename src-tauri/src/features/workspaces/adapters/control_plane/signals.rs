//! Secret-free local Signal runner exchanges. The Bearer session and one-use
//! lease capability remain in Rust and never cross the webview boundary.

use super::*;
use chrono::{DateTime, Utc};
use dopedb_protocol::{SignalEvaluationReceiptV1, SignalRuleDefinitionV1};

const MAX_SIGNAL_RESPONSE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunnerRegistrationRequest<'a> {
    device_id: &'a str,
    display_name: &'a str,
    background_allowed: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunnerRegistrationResponse {
    runner: RemoteSignalRunner,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteSignalRunner {
    pub(crate) id: Uuid,
    pub(crate) device_id: String,
    pub(crate) display_name: String,
    pub(crate) background_allowed: bool,
    pub(crate) last_seen_at: DateTime<Utc>,
    pub(crate) online: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LeaseClaimRequest<'a> {
    runner_id: Uuid,
    device_id: &'a str,
    background: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LeaseClaimResponse {
    lease: Option<RemoteSignalLeaseResponse>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteSignalLeaseResponse {
    id: Uuid,
    capability: String,
    expires_at: DateTime<Utc>,
    scheduled_at: DateTime<Utc>,
    rule_id: Uuid,
    rule_revision: u64,
    project_environment_id: Uuid,
    environment_revision: u64,
    rule_definition: SignalRuleDefinitionV1,
    analysis_definition: serde_json::Value,
    connection_ids: Vec<Uuid>,
    next_transition_sequence: u64,
}

#[derive(Debug)]
pub(crate) struct RemoteSignalLease {
    pub(crate) workspace_id: Uuid,
    pub(crate) id: Uuid,
    pub(crate) capability: Zeroizing<String>,
    pub(crate) expires_at: DateTime<Utc>,
    pub(crate) scheduled_at: DateTime<Utc>,
    pub(crate) rule: SignalRuleDefinitionV1,
    pub(crate) analysis_definition: serde_json::Value,
    pub(crate) next_transition_sequence: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReceiptResponse {
    receipt: RemoteSignalReceipt,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteSignalReceipt {
    pub(crate) id: Uuid,
    pub(crate) state: String,
    pub(crate) notification_state: String,
    pub(crate) transition_sequence: u64,
}

async fn bounded_json<T: for<'de> Deserialize<'de>>(
    response: Response,
    action: &str,
) -> AppResult<T> {
    let bytes = response
        .bytes()
        .await
        .map_err(|error| request_error(action, error))?;
    if bytes.len() > MAX_SIGNAL_RESPONSE_BYTES {
        return Err(AppError::Network(format!(
            "{action} returned an oversized response"
        )));
    }
    serde_json::from_slice(&bytes)
        .map_err(|error| AppError::Network(format!("{action} returned invalid JSON: {error}")))
}

fn signal_token(user_id: &str) -> AppResult<Zeroizing<String>> {
    fetch_workspace_session(user_id)?
        .map(Zeroizing::new)
        .ok_or_else(|| AppError::Config("Signal monitoring requires sign-in".into()))
}

pub(crate) async fn register_signal_runner(
    user_id: &str,
    workspace_id: Uuid,
    device_id: &str,
    background_allowed: bool,
) -> AppResult<RemoteSignalRunner> {
    let token = signal_token(user_id)?;
    let display_name = format!("DopeDB on {}", std::env::consts::OS);
    let response = client()?
        .post(format!(
            "{}/api/v1/workspaces/{workspace_id}/signals/runners",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .json(&RunnerRegistrationRequest {
            device_id,
            display_name: &display_name,
            background_allowed,
        })
        .send()
        .await
        .map_err(|error| request_error("registering Signal runner", error))?;
    if response.status() == StatusCode::UNAUTHORIZED {
        delete_workspace_session(user_id)?;
    }
    if !response.status().is_success() {
        return Err(oauth_error(response).await);
    }
    let body: RunnerRegistrationResponse =
        bounded_json(response, "Signal runner registration").await?;
    if body.runner.device_id != device_id
        || body.runner.display_name != display_name
        || body.runner.background_allowed != background_allowed
        || !body.runner.online
        || body.runner.last_seen_at < Utc::now() - chrono::Duration::minutes(2)
        || body.runner.last_seen_at > Utc::now() + chrono::Duration::seconds(30)
    {
        return Err(AppError::Network(
            "Signal runner registration changed local identity".into(),
        ));
    }
    Ok(body.runner)
}

pub(crate) async fn claim_signal_lease(
    user_id: &str,
    workspace_id: Uuid,
    runner_id: Uuid,
    device_id: &str,
    background: bool,
) -> AppResult<Option<RemoteSignalLease>> {
    let token = signal_token(user_id)?;
    let response = client()?
        .post(format!(
            "{}/api/v1/workspaces/{workspace_id}/signals/leases",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .json(&LeaseClaimRequest {
            runner_id,
            device_id,
            background,
        })
        .send()
        .await
        .map_err(|error| request_error("claiming Signal work", error))?;
    if response.status() == StatusCode::UNAUTHORIZED {
        delete_workspace_session(user_id)?;
    }
    if !response.status().is_success() {
        return Err(oauth_error(response).await);
    }
    let body: LeaseClaimResponse = bounded_json(response, "Signal lease claim").await?;
    let Some(lease) = body.lease else {
        return Ok(None);
    };
    let now = Utc::now();
    let mut expected_connections = lease.rule_definition.connection_ids.clone();
    let mut actual_connections = lease.connection_ids;
    expected_connections.sort_unstable();
    actual_connections.sort_unstable();
    if !lease.rule_definition.validate()
        || lease.rule_definition.rule_id != lease.rule_id
        || lease.rule_definition.revision != lease.rule_revision
        || lease.rule_definition.project_environment_id != lease.project_environment_id
        || lease.rule_definition.environment_revision != lease.environment_revision
        || expected_connections != actual_connections
        || lease.capability.len() != 43
        || !lease
            .capability
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        || lease.expires_at <= now
        || lease.expires_at > now + chrono::Duration::minutes(5)
        || lease.scheduled_at > now + chrono::Duration::seconds(30)
        || !lease.analysis_definition.is_object()
    {
        return Err(AppError::Network(
            "Signal lease returned invalid identity or authority".into(),
        ));
    }
    Ok(Some(RemoteSignalLease {
        workspace_id,
        id: lease.id,
        capability: Zeroizing::new(lease.capability),
        expires_at: lease.expires_at,
        scheduled_at: lease.scheduled_at,
        rule: lease.rule_definition,
        analysis_definition: lease.analysis_definition,
        next_transition_sequence: lease.next_transition_sequence,
    }))
}

pub(crate) async fn submit_signal_receipt(
    user_id: &str,
    workspace_id: Uuid,
    lease: &RemoteSignalLease,
    receipt: &SignalEvaluationReceiptV1,
) -> AppResult<RemoteSignalReceipt> {
    if !receipt.validate()
        || receipt.rule_id != lease.rule.rule_id
        || receipt.rule_revision != lease.rule.revision
        || receipt.project_environment_id != lease.rule.project_environment_id
        || receipt.environment_revision != lease.rule.environment_revision
        || receipt.scheduled_at != lease.scheduled_at
    {
        return Err(AppError::Blocked {
            reason: "Signal receipt changed leased authority".into(),
        });
    }
    let token = signal_token(user_id)?;
    let response = client()?
        .post(format!(
            "{}/api/v1/workspaces/{workspace_id}/signals/leases/{}/receipt",
            origin()?,
            lease.id
        ))
        .bearer_auth(token.as_str())
        .header("x-dopedb-signal-lease", lease.capability.as_str())
        .json(receipt)
        .send()
        .await
        .map_err(|error| request_error("submitting Signal receipt", error))?;
    if response.status() == StatusCode::UNAUTHORIZED {
        delete_workspace_session(user_id)?;
    }
    if !response.status().is_success() {
        return Err(oauth_error(response).await);
    }
    let body: ReceiptResponse = bounded_json(response, "Signal receipt submission").await?;
    if body.receipt.id != receipt.receipt_id
        || body.receipt.transition_sequence != receipt.transition_sequence
        || !matches!(
            body.receipt.notification_state.as_str(),
            "none" | "pending" | "suppressed"
        )
        || !matches!(
            body.receipt.state.as_str(),
            "normal" | "firing" | "recovered" | "no_data" | "error" | "stale"
        )
    {
        return Err(AppError::Network(
            "Signal receipt response changed transition identity".into(),
        ));
    }
    Ok(body.receipt)
}
