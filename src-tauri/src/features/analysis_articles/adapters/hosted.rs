//! Authenticated Analysis Article control-plane adapter. Bearer sessions and
//! scheduled-run capabilities stay in Rust; the renderer receives only typed,
//! credential-free definitions, receipts, and privacy-minimized result fragments.

use std::collections::{BTreeMap, HashSet};
use std::time::Duration;

use chrono::{DateTime, Utc};
use dopedb_protocol::{
    AnalysisArticleRecord, AnalysisArticleVersionPayload, AnalysisBlockKind, AnalysisQueryReceipt,
    AnalysisResultFragment, AnalysisRunError, AnalysisRunState, AnalysisRunTrigger,
    SharedAnalysisArticleCreate,
};
use reqwest::{Response, StatusCode, Url};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::connection::keychain::{
    delete_analysis_runner_capability, delete_workspace_session, fetch_analysis_runner_capability,
    fetch_workspace_session, store_analysis_runner_capability,
};
use crate::error::{AppError, AppResult};
use crate::hosted_control_plane::{
    bounded_json_response, client, origin, request_error, response_error as oauth_error,
};
use crate::operations::canonical_hash;

use super::super::ports::{AnalysisArticleMutation, AnalysisHostedAuthorityPort};

const MAX_DEFINITION_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_RESULT_RESPONSE_BYTES: usize = 18 * 1024 * 1024;
const MAX_INLINE_COMPLETION_REQUEST_BYTES: usize = 4 * 1024 * 1024;
const RESULT_UPLOAD_ATTEMPTS: usize = 3;
const ANALYSIS_RUNNER_CAPABILITY_HEADER: &str = "x-dopedb-analysis-runner-capability";
const ANALYSIS_RUNNER_CAPABILITY_VERSION_HEADER: &str =
    "x-dopedb-analysis-runner-capability-version";
const ANALYSIS_RUNNER_CAPABILITY_VERSION: &str = "1";
const ANALYSIS_RUNNER_CAPABILITY_MISSING: &str =
    "Analysis runner possession is missing from this device";

static ANALYSIS_RUNNER_REGISTRATION_LOCK: tokio::sync::Mutex<()> =
    tokio::sync::Mutex::const_new(());

pub(crate) fn analysis_runner_capability_is_missing(error: &AppError) -> bool {
    matches!(error, AppError::Blocked { reason } if reason == ANALYSIS_RUNNER_CAPABILITY_MISSING)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArticleCollectionResponse {
    workspace_id: Uuid,
    articles: Vec<AnalysisArticleRecord>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ArticleResponse {
    article: AnalysisArticleRecord,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteAnalysisRunner {
    pub(crate) id: Uuid,
    pub(crate) device_id: String,
    pub(crate) display_name: String,
    #[serde(default)]
    pub(crate) runner_capability_generation: Option<u64>,
    pub(crate) background_allowed: bool,
    pub(crate) last_seen_at: DateTime<Utc>,
    pub(crate) online: bool,
    #[serde(default)]
    pub(crate) scheduled_article_count: u64,
    #[serde(default)]
    pub(crate) is_current: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RunnerResponse {
    runner: RemoteAnalysisRunner,
    #[serde(
        rename = "runnerCapability",
        default,
        deserialize_with = "deserialize_optional_secret"
    )]
    runner_capability: Option<Zeroizing<String>>,
    #[serde(rename = "runnerCapabilityGeneration", default)]
    runner_capability_generation: Option<u64>,
}

pub(crate) struct RegisteredAnalysisRunner {
    pub(crate) runner: RemoteAnalysisRunner,
    capability: Zeroizing<String>,
}

impl RegisteredAnalysisRunner {
    pub(crate) fn capability(&self) -> &str {
        self.capability.as_str()
    }

    pub(crate) fn generation(&self) -> u64 {
        self.runner
            .runner_capability_generation
            .expect("registered Analysis runners always have a validated generation")
    }
}

pub(crate) async fn analysis_runner_registration_guard() -> tokio::sync::MutexGuard<'static, ()> {
    ANALYSIS_RUNNER_REGISTRATION_LOCK.lock().await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunnerCollectionResponse {
    workspace_id: Uuid,
    runners: Vec<RemoteAnalysisRunner>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AnalysisRunnerRevocation {
    pub(crate) id: Uuid,
    pub(crate) scheduled_article_count: u64,
    pub(crate) active_lease_count: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RunnerRevocationResponse {
    revoked: AnalysisRunnerRevocation,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunnerRegistrationRequest<'a> {
    device_id: &'a str,
    display_name: &'a str,
    background_allowed: bool,
}

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

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RunResponse {
    run: RemoteAnalysisRun,
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

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteAnalysisArticleRevision {
    pub(crate) revision: i64,
    pub(crate) base_revision: Option<i64>,
    pub(crate) operation: String,
    pub(crate) payload: AnalysisArticleVersionPayload,
    pub(crate) payload_hash: String,
    pub(crate) created_by_member_id: String,
    pub(crate) created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RevisionCollectionResponse {
    article_id: Uuid,
    revisions: Vec<RemoteAnalysisArticleRevision>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteAnalysisResultRun {
    pub(crate) id: Uuid,
    pub(crate) article_id: Uuid,
    pub(crate) article_revision: i64,
    pub(crate) state: AnalysisRunState,
    pub(crate) result_hash: Option<String>,
    pub(crate) row_count: u64,
    pub(crate) byte_count: u64,
    pub(crate) finished_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteAnalysisResult {
    pub(crate) run: RemoteAnalysisResultRun,
    pub(crate) fragments: Vec<AnalysisResultFragment>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteAnalysisLeaseResponse {
    id: Uuid,
    article_id: Uuid,
    article_revision: i64,
    runner_id: Uuid,
    runner_capability_generation: u64,
    scheduled_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    #[serde(deserialize_with = "deserialize_secret")]
    capability: Zeroizing<String>,
    parameter_values: BTreeMap<String, serde_json::Value>,
    article: AnalysisArticleVersionPayload,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LeaseResponse {
    lease: Option<RemoteAnalysisLeaseResponse>,
}

pub(crate) struct RemoteAnalysisLease {
    pub(crate) id: Uuid,
    pub(crate) article_id: Uuid,
    pub(crate) article_revision: i64,
    pub(crate) runner_id: Uuid,
    pub(crate) runner_capability_generation: u64,
    pub(crate) scheduled_at: DateTime<Utc>,
    pub(crate) expires_at: DateTime<Utc>,
    pub(crate) capability: Zeroizing<String>,
    pub(crate) runner_capability: Zeroizing<String>,
    pub(crate) parameter_values: BTreeMap<String, serde_json::Value>,
    pub(crate) article: AnalysisArticleVersionPayload,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LeaseClaimRequest<'a> {
    runner_id: Uuid,
    device_id: &'a str,
    background: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LeaseStateResponse {
    active: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LeaseReleaseResponse {
    revoked: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DeletedArticleResponse {
    deleted: bool,
    revision: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AnalysisPublicationRequest {
    pub(crate) id: Uuid,
    pub(crate) run_id: Uuid,
    pub(crate) slug: String,
    pub(crate) replace_publication_id: Option<Uuid>,
    pub(crate) visibility: String,
    pub(crate) title: String,
    pub(crate) description: String,
    pub(crate) block_ids: Vec<String>,
    pub(crate) parameter_ids: Vec<String>,
    pub(crate) search_indexable: bool,
    pub(crate) sensitivity_confirmed: bool,
    pub(crate) production_confirmed: bool,
    pub(crate) preview_hash: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteAnalysisPublicParameter {
    pub(crate) label: String,
    pub(crate) value: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteAnalysisPublicBlock {
    pub(crate) id: String,
    pub(crate) kind: AnalysisBlockKind,
    pub(crate) title: String,
    pub(crate) width: u8,
    pub(crate) config: serde_json::Value,
    pub(crate) fragments: Vec<AnalysisResultFragment>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteAnalysisPublicSnapshot {
    pub(crate) version: u32,
    pub(crate) title: String,
    pub(crate) description: String,
    pub(crate) summary: String,
    pub(crate) timezone: String,
    pub(crate) data_as_of: DateTime<Utc>,
    pub(crate) search_indexable: bool,
    pub(crate) parameters: Vec<RemoteAnalysisPublicParameter>,
    pub(crate) blocks: Vec<RemoteAnalysisPublicBlock>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteAnalysisPublication {
    pub(crate) id: Uuid,
    pub(crate) article_revision: i64,
    pub(crate) source_run_id: Uuid,
    pub(crate) slug: String,
    pub(crate) version: i64,
    pub(crate) replaces_publication_id: Option<Uuid>,
    pub(crate) visibility: String,
    pub(crate) title: String,
    pub(crate) description: String,
    pub(crate) snapshot_hash: String,
    pub(crate) published_at: DateTime<Utc>,
    pub(crate) revoked_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PublicationCollectionResponse {
    publications: Vec<RemoteAnalysisPublication>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PublicationPreviewResponse {
    snapshot: RemoteAnalysisPublicSnapshot,
    snapshot_hash: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PublicationResponse {
    publication: RemoteAnalysisPublication,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PublicationRevocationResponse {
    id: Uuid,
    revoked_at: DateTime<Utc>,
}

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

async fn token(user_id: &str) -> AppResult<Zeroizing<String>> {
    fetch_workspace_session(user_id)
        .await?
        .map(Zeroizing::new)
        .ok_or_else(|| AppError::Config("Analysis Articles require sign-in".into()))
}

async fn bounded_json<T: DeserializeOwned>(
    response: Response,
    action: &str,
    maximum: usize,
) -> AppResult<T> {
    bounded_json_response(response, action, maximum).await
}

async fn response<T: DeserializeOwned>(
    response: Response,
    user_id: &str,
    action: &str,
    maximum: usize,
) -> AppResult<T> {
    if response.status() == StatusCode::UNAUTHORIZED {
        delete_workspace_session(user_id).await?;
    }
    if !response.status().is_success() {
        return Err(oauth_error(response).await);
    }
    bounded_json(response, action, maximum).await
}

fn validate_article(article: &AnalysisArticleRecord, expected_id: Option<Uuid>) -> AppResult<()> {
    if expected_id.is_some_and(|id| id != article.id)
        || article.environment_revision < 1
        || article.revision < 1
        || article
            .live_revision
            .is_some_and(|revision| revision < 1 || revision > article.revision)
        || article.connections.is_empty()
        || article.definition.version != 1
    {
        return Err(AppError::Network(
            "Analysis Article returned invalid identity or authority".into(),
        ));
    }
    Ok(())
}

fn deserialize_secret<'de, D>(deserializer: D) -> Result<Zeroizing<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    String::deserialize(deserializer).map(Zeroizing::new)
}

fn deserialize_optional_secret<'de, D>(
    deserializer: D,
) -> Result<Option<Zeroizing<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(|value| value.map(Zeroizing::new))
}

fn validate_run(run: &RemoteAnalysisRun, article_id: Uuid, run_id: Option<Uuid>) -> AppResult<()> {
    if run.article_id != article_id
        || run_id.is_some_and(|id| run.id != id)
        || run.article_revision < 1
        || run.parameter_hash.len() != 64
        || run.definition_hash.len() != 64
        || matches!(
            run.state,
            AnalysisRunState::Queued | AnalysisRunState::Running
        ) && !matches!(run.runner_capability_generation, Some(generation) if generation > 0)
        || run
            .result_hash
            .as_ref()
            .is_some_and(|hash| hash.len() != 64)
    {
        return Err(AppError::Network(
            "Analysis run returned invalid identity or evidence".into(),
        ));
    }
    Ok(())
}

fn validate_publication(
    publication: &RemoteAnalysisPublication,
    expected_id: Option<Uuid>,
) -> AppResult<()> {
    let slug_valid = publication.slug.len() >= 8
        && publication.slug.len() <= 128
        && publication.slug.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        });
    if expected_id.is_some_and(|id| publication.id != id)
        || publication.article_revision < 1
        || publication.version < 1
        || !slug_valid
        || !matches!(publication.visibility.as_str(), "unlisted" | "public")
        || publication.title.trim().is_empty()
        || publication.title.chars().count() > 160
        || publication.description.chars().count() > 2_000
        || publication.snapshot_hash.len() != 64
    {
        return Err(AppError::Network(
            "Analysis publication returned invalid immutable evidence".into(),
        ));
    }
    Ok(())
}

fn safe_analysis_id(value: &str) -> bool {
    let mut characters = value.chars();
    characters
        .next()
        .is_some_and(|character| character.is_ascii_alphabetic())
        && value.len() <= 64
        && characters
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
}

fn validate_signal_definition(definition: &AnalysisSignalDefinition) -> bool {
    let condition_valid = match definition.condition {
        AnalysisSignalCondition::ThresholdAbove { value }
        | AnalysisSignalCondition::ThresholdBelow { value }
        | AnalysisSignalCondition::AbsoluteChange { value } => value.is_finite(),
        AnalysisSignalCondition::PercentageChange { percentage } => {
            percentage.is_finite() && percentage >= 0.0
        }
        AnalysisSignalCondition::MissingData { count }
        | AnalysisSignalCondition::ConsecutiveFailure { count } => (1..=1_000).contains(&count),
    };
    let needs_baseline = matches!(
        definition.condition,
        AnalysisSignalCondition::AbsoluteChange { .. }
            | AnalysisSignalCondition::PercentageChange { .. }
    );
    condition_valid
        && definition.production_confirmed
        && definition.minimum_sample_count <= 1_000_000_000
        && definition.cooldown_seconds <= 31_622_400
        && (1..=1_000).contains(&definition.rearm_after_normal_count)
        && definition
            .baseline_window_seconds
            .is_some_and(|value| (60..=31_622_400).contains(&value))
            == needs_baseline
        && !definition.recipient_member_ids.is_empty()
        && definition.recipient_member_ids.len() <= 100
        && definition
            .recipient_member_ids
            .iter()
            .copied()
            .collect::<HashSet<_>>()
            .len()
            == definition.recipient_member_ids.len()
        && !definition.channels.is_empty()
        && definition.channels.len() <= 3
        && definition
            .channels
            .iter()
            .copied()
            .collect::<HashSet<_>>()
            .len()
            == definition.channels.len()
}

fn validate_signal(
    signal: &RemoteAnalysisSignal,
    article_id: Uuid,
    expected_id: Option<Uuid>,
) -> AppResult<()> {
    if signal.article_id != article_id
        || expected_id.is_some_and(|id| id != signal.id)
        || signal.article_revision < 1
        || signal.revision < 1
        || !safe_analysis_id(&signal.block_id)
        || !validate_signal_definition(&signal.definition)
        || signal
            .owner_member_id
            .as_deref()
            .is_some_and(|owner| owner.trim().is_empty() || owner.len() > 256)
        || !matches!(
            signal.last_observed_state.as_str(),
            "unknown" | "normal" | "firing" | "recovered" | "no_data" | "error" | "stale"
        )
    {
        return Err(AppError::Network(
            "Analysis signal returned invalid identity or policy".into(),
        ));
    }
    Ok(())
}

fn validate_signal_request(
    request: &AnalysisSignalCreateRequest,
    article_id: Uuid,
) -> AppResult<()> {
    if request.article_revision < 1
        || !safe_analysis_id(&request.block_id)
        || !validate_signal_definition(&request.definition)
        || request.id == article_id
    {
        return Err(AppError::Config(
            "invalid Analysis signal definition".into(),
        ));
    }
    Ok(())
}

pub(crate) async fn list_analysis_articles(
    user_id: &str,
    workspace_id: Uuid,
    environment_id: Option<Uuid>,
) -> AppResult<Vec<AnalysisArticleRecord>> {
    let token = token(user_id).await?;
    let mut url = Url::parse(&format!(
        "{}/api/v1/workspaces/{workspace_id}/analyses",
        origin()?
    ))
    .map_err(|_| AppError::Config("Analysis Article endpoint is invalid".into()))?;
    if let Some(environment_id) = environment_id {
        url.query_pairs_mut()
            .append_pair("environmentId", &environment_id.to_string());
    }
    let raw = client()?
        .get(url)
        .bearer_auth(token.as_str())
        .send()
        .await
        .map_err(|error| request_error("loading Analysis Articles", error))?;
    let body: ArticleCollectionResponse = response(
        raw,
        user_id,
        "Analysis Article collection",
        MAX_DEFINITION_RESPONSE_BYTES,
    )
    .await?;
    if body.workspace_id != workspace_id || body.articles.len() > 1_000 {
        return Err(AppError::Network(
            "Analysis Article collection changed workspace identity".into(),
        ));
    }
    for article in &body.articles {
        validate_article(article, None)?;
    }
    Ok(body.articles)
}

pub(crate) async fn get_analysis_article(
    user_id: &str,
    workspace_id: Uuid,
    article_id: Uuid,
) -> AppResult<AnalysisArticleRecord> {
    let token = token(user_id).await?;
    let raw = client()?
        .get(format!(
            "{}/api/v1/workspaces/{workspace_id}/analyses/{article_id}",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .send()
        .await
        .map_err(|error| request_error("loading an Analysis Article", error))?;
    let body: ArticleResponse = response(
        raw,
        user_id,
        "Analysis Article",
        MAX_DEFINITION_RESPONSE_BYTES,
    )
    .await?;
    validate_article(&body.article, Some(article_id))?;
    Ok(body.article)
}

pub(crate) async fn create_analysis_article(
    user_id: &str,
    workspace_id: Uuid,
    article: &SharedAnalysisArticleCreate,
) -> AppResult<AnalysisArticleRecord> {
    if !article.validate() {
        return Err(AppError::Config(
            "Analysis Article create contract is invalid".into(),
        ));
    }
    let token = token(user_id).await?;
    let raw = client()?
        .post(format!(
            "{}/api/v1/workspaces/{workspace_id}/analyses",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .header("if-match", "\"0\"")
        .json(article)
        .send()
        .await
        .map_err(|error| request_error("creating an Analysis Article", error))?;
    let body: ArticleResponse = response(
        raw,
        user_id,
        "created Analysis Article",
        MAX_DEFINITION_RESPONSE_BYTES,
    )
    .await?;
    validate_article(&body.article, Some(article.id))?;
    Ok(body.article)
}

pub(crate) async fn mutate_analysis_article(
    user_id: &str,
    workspace_id: Uuid,
    article_id: Uuid,
    expected_revision: i64,
    mutation: AnalysisArticleMutation,
) -> AppResult<AnalysisArticleRecord> {
    if expected_revision < 1 {
        return Err(AppError::Config(
            "Analysis Article expected revision must be positive".into(),
        ));
    }
    let body = match mutation {
        AnalysisArticleMutation::Update(article) => {
            if article.id != article_id || !article.validate() {
                return Err(AppError::Config(
                    "Analysis Article update contract is invalid".into(),
                ));
            }
            json!({ "action": "update", "article": article })
        }
        AnalysisArticleMutation::SubmitReview => json!({ "action": "submitReview" }),
        AnalysisArticleMutation::ReturnDraft => json!({ "action": "returnDraft" }),
        AnalysisArticleMutation::PublishLive => json!({ "action": "publishLive" }),
        AnalysisArticleMutation::Archive => json!({ "action": "archive" }),
        AnalysisArticleMutation::Transfer { owner_member_id } => {
            json!({ "action": "transfer", "ownerMemberId": owner_member_id })
        }
        AnalysisArticleMutation::Restore { revision } => {
            json!({ "action": "restore", "revision": revision })
        }
    };
    let token = token(user_id).await?;
    let raw = client()?
        .patch(format!(
            "{}/api/v1/workspaces/{workspace_id}/analyses/{article_id}",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .header("if-match", format!("\"{expected_revision}\""))
        .json(&body)
        .send()
        .await
        .map_err(|error| request_error("updating an Analysis Article", error))?;
    let body: ArticleResponse = response(
        raw,
        user_id,
        "updated Analysis Article",
        MAX_DEFINITION_RESPONSE_BYTES,
    )
    .await?;
    validate_article(&body.article, Some(article_id))?;
    Ok(body.article)
}

pub(crate) async fn delete_analysis_article(
    user_id: &str,
    workspace_id: Uuid,
    article_id: Uuid,
    expected_revision: i64,
) -> AppResult<i64> {
    let token = token(user_id).await?;
    let raw = client()?
        .delete(format!(
            "{}/api/v1/workspaces/{workspace_id}/analyses/{article_id}",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .header("if-match", format!("\"{expected_revision}\""))
        .send()
        .await
        .map_err(|error| request_error("deleting an Analysis Article", error))?;
    let body: DeletedArticleResponse = response(
        raw,
        user_id,
        "deleted Analysis Article",
        MAX_DEFINITION_RESPONSE_BYTES,
    )
    .await?;
    if !body.deleted || body.revision <= expected_revision {
        return Err(AppError::Network(
            "Analysis Article deletion returned invalid revision evidence".into(),
        ));
    }
    Ok(body.revision)
}

pub(crate) async fn list_analysis_article_revisions(
    user_id: &str,
    workspace_id: Uuid,
    article_id: Uuid,
) -> AppResult<Vec<RemoteAnalysisArticleRevision>> {
    let token = token(user_id).await?;
    let raw = client()?
        .get(format!(
            "{}/api/v1/workspaces/{workspace_id}/analyses/{article_id}/revisions",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .send()
        .await
        .map_err(|error| request_error("loading Analysis Article history", error))?;
    let body: RevisionCollectionResponse = response(
        raw,
        user_id,
        "Analysis Article history",
        MAX_DEFINITION_RESPONSE_BYTES,
    )
    .await?;
    if body.article_id != article_id
        || body.revisions.len() > 200
        || body.revisions.iter().any(|revision| {
            revision.revision < 1
                || revision.payload.id != article_id
                || revision.payload_hash.len() != 64
        })
    {
        return Err(AppError::Network(
            "Analysis Article history returned invalid revision evidence".into(),
        ));
    }
    Ok(body.revisions)
}

pub(crate) async fn register_analysis_runner(
    user_id: &str,
    workspace_id: Uuid,
    device_id: &str,
    background_allowed: bool,
) -> AppResult<RegisteredAnalysisRunner> {
    let token = token(user_id).await?;
    let device_id = Uuid::parse_str(device_id)
        .map_err(|_| AppError::Config("Analysis runner device id is invalid".into()))?;
    let device_id_string = device_id.to_string();
    let display_name = format!("DopeDB on {}", std::env::consts::OS);
    let existing = list_analysis_runners(user_id, workspace_id)
        .await?
        .into_iter()
        .find(|runner| runner.device_id == device_id_string);
    let existing_capability = match existing.as_ref() {
        Some(runner) => {
            fetch_analysis_runner_capability(user_id, workspace_id, device_id, runner.id)?
        }
        None => None,
    };
    if let Some(runner) = existing.as_ref().filter(|_| existing_capability.is_none()) {
        revoke_analysis_runner(user_id, workspace_id, runner.id).await?;
        delete_analysis_runner_capability(user_id, workspace_id, device_id, runner.id)?;
        return Err(AppError::Blocked {
            reason: ANALYSIS_RUNNER_CAPABILITY_MISSING.into(),
        });
    }
    let mut request = client()?
        .post(format!(
            "{}/api/v1/workspaces/{workspace_id}/analyses/runners",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .header(
            ANALYSIS_RUNNER_CAPABILITY_VERSION_HEADER,
            ANALYSIS_RUNNER_CAPABILITY_VERSION,
        )
        .json(&RunnerRegistrationRequest {
            device_id: &device_id_string,
            display_name: &display_name,
            background_allowed,
        });
    if let Some(capability) = existing_capability.as_deref() {
        request = request.header(ANALYSIS_RUNNER_CAPABILITY_HEADER, capability);
    }
    let raw = request
        .send()
        .await
        .map_err(|error| request_error("registering an Analysis runner", error))?;
    if raw.status() == StatusCode::PRECONDITION_REQUIRED
        || (raw.status() == StatusCode::FORBIDDEN && existing.is_some())
    {
        if let Some(runner) = existing.as_ref() {
            revoke_analysis_runner(user_id, workspace_id, runner.id).await?;
            delete_analysis_runner_capability(user_id, workspace_id, device_id, runner.id)?;
        }
        return Err(AppError::Blocked {
            reason: ANALYSIS_RUNNER_CAPABILITY_MISSING.into(),
        });
    }
    let body: RunnerResponse = response(
        raw,
        user_id,
        "Analysis runner registration",
        MAX_DEFINITION_RESPONSE_BYTES,
    )
    .await?;
    if body.runner.device_id != device_id_string
        || body.runner.display_name != display_name
        || body.runner.background_allowed != background_allowed
        || !body.runner.online
        || body.runner.last_seen_at < Utc::now() - chrono::Duration::minutes(2)
        || body.runner.last_seen_at > Utc::now() + chrono::Duration::seconds(30)
    {
        return Err(AppError::Network(
            "Analysis runner registration changed local identity".into(),
        ));
    }
    let generation = body
        .runner
        .runner_capability_generation
        .or(body.runner_capability_generation)
        .ok_or_else(|| {
            AppError::Network("Analysis runner registration omitted possession generation".into())
        })?;
    if generation == 0
        || body.runner.runner_capability_generation != Some(generation)
        || body.runner_capability_generation != Some(generation)
    {
        return Err(AppError::Network(
            "Analysis runner registration changed possession generation".into(),
        ));
    }
    let capability = match (body.runner_capability, existing_capability) {
        (Some(capability), None)
            if capability.len() == 64
                && capability
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) =>
        {
            if let Err(error) = store_analysis_runner_capability(
                user_id,
                workspace_id,
                device_id,
                body.runner.id,
                capability.as_str(),
            ) {
                let cleanup = revoke_analysis_runner(user_id, workspace_id, body.runner.id).await;
                if let Err(cleanup_error) = cleanup {
                    tracing::warn!(
                        error_kind = cleanup_error.kind(),
                        "unusable Analysis runner could not be revoked after credential-store failure"
                    );
                }
                return Err(error);
            }
            capability
        }
        (None, Some(capability)) => capability,
        _ => {
            return Err(AppError::Network(
                "Analysis runner registration returned invalid possession authority".into(),
            ));
        }
    };
    Ok(RegisteredAnalysisRunner {
        runner: body.runner,
        capability,
    })
}

pub(crate) async fn list_analysis_runners(
    user_id: &str,
    workspace_id: Uuid,
) -> AppResult<Vec<RemoteAnalysisRunner>> {
    let token = token(user_id).await?;
    let raw = client()?
        .get(format!(
            "{}/api/v1/workspaces/{workspace_id}/analyses/runners",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .send()
        .await
        .map_err(|error| request_error("loading Analysis runners", error))?;
    let body: RunnerCollectionResponse = response(
        raw,
        user_id,
        "Analysis runner inventory",
        MAX_DEFINITION_RESPONSE_BYTES,
    )
    .await?;
    if body.workspace_id != workspace_id
        || body.runners.len() > 128
        || body.runners.iter().any(|runner| {
            runner.device_id.trim().is_empty()
                || runner.device_id.len() > 256
                || runner.display_name.trim().is_empty()
                || runner.display_name.len() > 256
                || runner.last_seen_at > Utc::now() + chrono::Duration::seconds(30)
        })
    {
        return Err(AppError::Network(
            "Analysis runner inventory returned invalid identity".into(),
        ));
    }
    Ok(body.runners)
}

pub(crate) async fn revoke_analysis_runner(
    user_id: &str,
    workspace_id: Uuid,
    runner_id: Uuid,
) -> AppResult<AnalysisRunnerRevocation> {
    let token = token(user_id).await?;
    let raw = client()?
        .delete(format!(
            "{}/api/v1/workspaces/{workspace_id}/analyses/runners/{runner_id}",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .send()
        .await
        .map_err(|error| request_error("revoking an Analysis runner", error))?;
    let body: RunnerRevocationResponse = response(
        raw,
        user_id,
        "Analysis runner revocation",
        MAX_DEFINITION_RESPONSE_BYTES,
    )
    .await?;
    if body.revoked.id != runner_id
        || body.revoked.scheduled_article_count > 10_000
        || body.revoked.active_lease_count > 10_000
    {
        return Err(AppError::Network(
            "Analysis runner revocation returned invalid evidence".into(),
        ));
    }
    Ok(body.revoked)
}

pub(crate) async fn list_analysis_publications(
    user_id: &str,
    workspace_id: Uuid,
    article_id: Uuid,
) -> AppResult<Vec<RemoteAnalysisPublication>> {
    let token = token(user_id).await?;
    let raw = client()?
        .get(format!(
            "{}/api/v1/workspaces/{workspace_id}/analyses/{article_id}/publications",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .send()
        .await
        .map_err(|error| request_error("loading Analysis publications", error))?;
    let body: PublicationCollectionResponse = response(
        raw,
        user_id,
        "Analysis publication collection",
        MAX_DEFINITION_RESPONSE_BYTES,
    )
    .await?;
    if body.publications.len() > 500 {
        return Err(AppError::Network(
            "Analysis publication collection is oversized".into(),
        ));
    }
    for publication in &body.publications {
        validate_publication(publication, None)?;
    }
    Ok(body.publications)
}

pub(crate) async fn preview_analysis_publication(
    user_id: &str,
    workspace_id: Uuid,
    article_id: Uuid,
    request: &AnalysisPublicationRequest,
) -> AppResult<(RemoteAnalysisPublicSnapshot, String)> {
    if request.preview_hash.is_some() {
        return Err(AppError::Config(
            "Analysis publication preview cannot assert a snapshot hash".into(),
        ));
    }
    let token = token(user_id).await?;
    let raw = client()?
        .post(format!(
            "{}/api/v1/workspaces/{workspace_id}/analyses/{article_id}/publications/preview",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .json(request)
        .send()
        .await
        .map_err(|error| request_error("previewing an Analysis publication", error))?;
    let body: PublicationPreviewResponse = response(
        raw,
        user_id,
        "Analysis publication preview",
        MAX_RESULT_RESPONSE_BYTES,
    )
    .await?;
    if body.snapshot.version != 1
        || body.snapshot.blocks.is_empty()
        || body.snapshot.blocks.len() > 128
        || body.snapshot_hash.len() != 64
        || body
            .snapshot
            .blocks
            .iter()
            .any(|block| block.width < 1 || block.width > 12 || block.fragments.len() > 256)
    {
        return Err(AppError::Network(
            "Analysis publication preview returned invalid safe content".into(),
        ));
    }
    Ok((body.snapshot, body.snapshot_hash))
}

pub(crate) async fn create_analysis_publication(
    user_id: &str,
    workspace_id: Uuid,
    article_id: Uuid,
    request: &AnalysisPublicationRequest,
) -> AppResult<RemoteAnalysisPublication> {
    if request
        .preview_hash
        .as_ref()
        .is_none_or(|hash| hash.len() != 64)
    {
        return Err(AppError::Config(
            "Analysis publication requires its exact preview hash".into(),
        ));
    }
    let token = token(user_id).await?;
    let raw = client()?
        .post(format!(
            "{}/api/v1/workspaces/{workspace_id}/analyses/{article_id}/publications",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .json(request)
        .send()
        .await
        .map_err(|error| request_error("publishing an Analysis Article", error))?;
    let body: PublicationResponse = response(
        raw,
        user_id,
        "created Analysis publication",
        MAX_DEFINITION_RESPONSE_BYTES,
    )
    .await?;
    validate_publication(&body.publication, Some(request.id))?;
    if body.publication.slug != request.slug
        || body.publication.source_run_id != request.run_id
        || body.publication.snapshot_hash != request.preview_hash.as_deref().unwrap_or_default()
    {
        return Err(AppError::Network(
            "Analysis publication changed its approved snapshot".into(),
        ));
    }
    Ok(body.publication)
}

pub(crate) async fn revoke_analysis_publication(
    user_id: &str,
    workspace_id: Uuid,
    article_id: Uuid,
    publication_id: Uuid,
) -> AppResult<DateTime<Utc>> {
    let token = token(user_id).await?;
    let raw = client()?
        .delete(format!(
            "{}/api/v1/workspaces/{workspace_id}/analyses/{article_id}/publications/{publication_id}",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .send()
        .await
        .map_err(|error| request_error("revoking an Analysis publication", error))?;
    let body: PublicationRevocationResponse = response(
        raw,
        user_id,
        "revoked Analysis publication",
        MAX_DEFINITION_RESPONSE_BYTES,
    )
    .await?;
    if body.id != publication_id || body.revoked_at > Utc::now() + chrono::Duration::seconds(30) {
        return Err(AppError::Network(
            "Analysis publication revocation changed identity".into(),
        ));
    }
    Ok(body.revoked_at)
}

pub(crate) fn analysis_publication_url(slug: &str) -> AppResult<String> {
    let valid = slug.len() >= 8
        && slug.len() <= 128
        && slug.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        });
    if !valid {
        return Err(AppError::Config("invalid Analysis publication slug".into()));
    }
    Ok(format!("{}/analyses/{slug}", origin()?))
}

pub(crate) async fn list_analysis_collaborators(
    user_id: &str,
    workspace_id: Uuid,
) -> AppResult<AnalysisCollaboratorDirectory> {
    let token = token(user_id).await?;
    let raw = client()?
        .get(format!(
            "{}/api/v1/workspaces/{workspace_id}/analyses/members",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .send()
        .await
        .map_err(|error| request_error("loading Analysis collaborators", error))?;
    let body: AnalysisCollaboratorDirectory = response(
        raw,
        user_id,
        "Analysis collaborator directory",
        MAX_DEFINITION_RESPONSE_BYTES,
    )
    .await?;
    if body.workspace_id != workspace_id
        || body.members.is_empty()
        || body.members.len() > 100
        || !body
            .members
            .iter()
            .any(|member| member.id == body.current_member_id)
        || body.members.iter().any(|member| {
            member.name.trim().is_empty()
                || member.name.chars().count() > 256
                || !matches!(
                    member.role.as_str(),
                    "viewer" | "analyst" | "editor" | "admin" | "owner"
                )
                || member.can_own_analysis
                    != matches!(member.role.as_str(), "editor" | "admin" | "owner")
        })
    {
        return Err(AppError::Network(
            "Analysis collaborator directory returned invalid membership".into(),
        ));
    }
    Ok(body)
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
        .header("if-match", format!("\"{expected_revision}\""))
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
        .header("if-match", format!("\"{expected_revision}\""))
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
        .header("if-match", format!("\"{expected_revision}\""))
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
            Ok(raw) if allow_inline_fallback && raw.status() == StatusCode::BAD_REQUEST => {
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

async fn fail_staged_analysis_upload(
    user_id: &str,
    workspace_id: Uuid,
    article_id: Uuid,
    run_id: Uuid,
    token: &str,
    runner_capability: &str,
) {
    let error = Some(AnalysisRunError {
        kind: "result_upload_failed".into(),
        message: "Analysis result upload failed after bounded retries".into(),
    });
    let payload = serde_json::to_vec(&CompleteRunRequest {
        state: AnalysisRunState::Failed,
        query_receipts: &[],
        fragment_manifest: &[],
        error: &error,
    });
    if let Ok(payload) = payload {
        let _ = patch_analysis_completion(
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
        .await;
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
                fail_staged_analysis_upload(
                    user_id,
                    workspace_id,
                    article_id,
                    run_id,
                    token.as_str(),
                    runner_capability,
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
                if state == AnalysisRunState::Succeeded {
                    fail_staged_analysis_upload(
                        user_id,
                        workspace_id,
                        article_id,
                        run_id,
                        token.as_str(),
                        runner_capability,
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
            fail_staged_analysis_upload(
                user_id,
                workspace_id,
                article_id,
                run_id,
                token.as_str(),
                runner_capability,
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

pub(crate) async fn analysis_refresh_lease_is_active(
    user_id: &str,
    workspace_id: Uuid,
    lease: &RemoteAnalysisLease,
) -> AppResult<bool> {
    let token = token(user_id).await?;
    let raw = client()?
        .get(format!(
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
        .map_err(|error| request_error("checking an Analysis refresh lease", error))?;
    let body: LeaseStateResponse = response(
        raw,
        user_id,
        "Analysis refresh lease status",
        MAX_DEFINITION_RESPONSE_BYTES,
    )
    .await?;
    Ok(body.active)
}

#[derive(Clone, Copy)]
pub(crate) struct HostedAnalysisAuthority;

impl AnalysisHostedAuthorityPort for HostedAnalysisAuthority {
    async fn list_articles(
        &self,
        account_id: &str,
        workspace_id: Uuid,
        environment_id: Option<Uuid>,
    ) -> AppResult<Vec<AnalysisArticleRecord>> {
        list_analysis_articles(account_id, workspace_id, environment_id).await
    }

    async fn get_article(
        &self,
        account_id: &str,
        workspace_id: Uuid,
        article_id: Uuid,
    ) -> AppResult<AnalysisArticleRecord> {
        get_analysis_article(account_id, workspace_id, article_id).await
    }

    async fn create_article(
        &self,
        account_id: &str,
        workspace_id: Uuid,
        article: &SharedAnalysisArticleCreate,
    ) -> AppResult<AnalysisArticleRecord> {
        create_analysis_article(account_id, workspace_id, article).await
    }

    async fn mutate_article(
        &self,
        account_id: &str,
        workspace_id: Uuid,
        article_id: Uuid,
        expected_revision: i64,
        mutation: AnalysisArticleMutation,
    ) -> AppResult<AnalysisArticleRecord> {
        mutate_analysis_article(
            account_id,
            workspace_id,
            article_id,
            expected_revision,
            mutation,
        )
        .await
    }
}
