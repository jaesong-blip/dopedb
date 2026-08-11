//! Authenticated Analysis Article control-plane exchanges. Bearer sessions and
//! scheduled-run capabilities stay in Rust; the renderer receives only typed,
//! credential-free definitions, receipts, and privacy-minimized result fragments.

use std::collections::{BTreeMap, HashSet};

use chrono::{DateTime, Utc};
use dopedb_protocol::{
    AnalysisArticleRecord, AnalysisArticleVersionPayload, AnalysisBlockKind, AnalysisQueryReceipt,
    AnalysisResultFragment, AnalysisRunError, AnalysisRunState, AnalysisRunTrigger,
    SharedAnalysisArticleCreate,
};
use serde::de::DeserializeOwned;
use zeroize::Zeroizing;

use super::*;

const MAX_DEFINITION_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_RESULT_RESPONSE_BYTES: usize = 18 * 1024 * 1024;

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
    pub(crate) background_allowed: bool,
    pub(crate) last_seen_at: DateTime<Utc>,
    pub(crate) online: bool,
    #[serde(default)]
    pub(crate) scheduled_article_count: u64,
    #[serde(default)]
    pub(crate) is_current: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RunnerResponse {
    runner: RemoteAnalysisRunner,
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
    fragments: &'a [AnalysisResultFragment],
    error: &'a Option<AnalysisRunError>,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteAnalysisLeaseResponse {
    id: Uuid,
    article_id: Uuid,
    article_revision: i64,
    runner_id: Uuid,
    scheduled_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    capability: String,
    parameter_values: BTreeMap<String, serde_json::Value>,
    article: AnalysisArticleVersionPayload,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LeaseResponse {
    lease: Option<RemoteAnalysisLeaseResponse>,
}

#[derive(Debug)]
pub(crate) struct RemoteAnalysisLease {
    pub(crate) id: Uuid,
    pub(crate) article_id: Uuid,
    pub(crate) article_revision: i64,
    pub(crate) runner_id: Uuid,
    pub(crate) scheduled_at: DateTime<Utc>,
    pub(crate) expires_at: DateTime<Utc>,
    pub(crate) capability: Zeroizing<String>,
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
    pub(crate) owner_member_id: String,
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

#[derive(Debug)]
pub(crate) enum AnalysisArticleMutation {
    Update(SharedAnalysisArticleCreate),
    SubmitReview,
    ReturnDraft,
    PublishLive,
    Archive,
    Transfer { owner_member_id: String },
    Restore { revision: i64 },
}

fn token(user_id: &str) -> AppResult<Zeroizing<String>> {
    fetch_workspace_session(user_id)?
        .map(Zeroizing::new)
        .ok_or_else(|| AppError::Config("Analysis Articles require sign-in".into()))
}

async fn bounded_json<T: DeserializeOwned>(
    response: Response,
    action: &str,
    maximum: usize,
) -> AppResult<T> {
    let bytes = response
        .bytes()
        .await
        .map_err(|error| request_error(action, error))?;
    if bytes.len() > maximum {
        return Err(AppError::Network(format!(
            "{action} returned an oversized response"
        )));
    }
    serde_json::from_slice(&bytes)
        .map_err(|error| AppError::Network(format!("{action} returned invalid JSON: {error}")))
}

async fn response<T: DeserializeOwned>(
    response: Response,
    user_id: &str,
    action: &str,
    maximum: usize,
) -> AppResult<T> {
    if response.status() == StatusCode::UNAUTHORIZED {
        delete_workspace_session(user_id)?;
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

fn validate_run(run: &RemoteAnalysisRun, article_id: Uuid, run_id: Option<Uuid>) -> AppResult<()> {
    if run.article_id != article_id
        || run_id.is_some_and(|id| run.id != id)
        || run.article_revision < 1
        || run.parameter_hash.len() != 64
        || run.definition_hash.len() != 64
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
        || signal.owner_member_id.trim().is_empty()
        || signal.owner_member_id.len() > 256
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
    let token = token(user_id)?;
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
    let token = token(user_id)?;
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
    let token = token(user_id)?;
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
            if article.id != article_id {
                return Err(AppError::Config(
                    "Analysis Article update changed identity".into(),
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
    let token = token(user_id)?;
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
    let token = token(user_id)?;
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
    let token = token(user_id)?;
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
) -> AppResult<RemoteAnalysisRunner> {
    let token = token(user_id)?;
    let display_name = format!("DopeDB on {}", std::env::consts::OS);
    let raw = client()?
        .post(format!(
            "{}/api/v1/workspaces/{workspace_id}/analyses/runners",
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
        .map_err(|error| request_error("registering an Analysis runner", error))?;
    let body: RunnerResponse = response(
        raw,
        user_id,
        "Analysis runner registration",
        MAX_DEFINITION_RESPONSE_BYTES,
    )
    .await?;
    if body.runner.device_id != device_id
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
    Ok(body.runner)
}

pub(crate) async fn list_analysis_runners(
    user_id: &str,
    workspace_id: Uuid,
) -> AppResult<Vec<RemoteAnalysisRunner>> {
    let token = token(user_id)?;
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
    let token = token(user_id)?;
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
    let token = token(user_id)?;
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
    let token = token(user_id)?;
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
    let token = token(user_id)?;
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
    let token = token(user_id)?;
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
    let token = token(user_id)?;
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
    let token = token(user_id)?;
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
    let token = token(user_id)?;
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
    let token = token(user_id)?;
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
    let token = token(user_id)?;
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
    let token = token(user_id)?;
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
    let token = token(user_id)?;
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
    let token = token(user_id)?;
    let raw = client()?
        .post(format!(
            "{}/api/v1/workspaces/{workspace_id}/analyses/{article_id}/signals/{signal_id}/receipts",
            origin()?
        ))
        .bearer_auth(token.as_str())
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
    let token = token(user_id)?;
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
    let token = token(user_id)?;
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

pub(crate) async fn start_analysis_run(
    user_id: &str,
    workspace_id: Uuid,
    article_id: Uuid,
    article_revision: i64,
    runner_id: Uuid,
    run_id: Uuid,
    trigger: AnalysisRunTrigger,
    parameter_values: &BTreeMap<String, serde_json::Value>,
    lease: Option<&RemoteAnalysisLease>,
) -> AppResult<(RemoteAnalysisRun, AnalysisArticleRecord)> {
    let token = token(user_id)?;
    let mut request = client()?
        .post(format!(
            "{}/api/v1/workspaces/{workspace_id}/analyses/{article_id}/runs",
            origin()?
        ))
        .bearer_auth(token.as_str())
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

pub(crate) async fn complete_analysis_run(
    user_id: &str,
    workspace_id: Uuid,
    article_id: Uuid,
    run_id: Uuid,
    state: AnalysisRunState,
    query_receipts: &[AnalysisQueryReceipt],
    fragments: &[AnalysisResultFragment],
    error: &Option<AnalysisRunError>,
) -> AppResult<RemoteAnalysisRun> {
    let token = token(user_id)?;
    let raw = client()?
        .patch(format!(
            "{}/api/v1/workspaces/{workspace_id}/analyses/{article_id}/runs/{run_id}",
            origin()?
        ))
        .bearer_auth(token.as_str())
        .timeout(Duration::from_secs(60))
        .json(&CompleteRunRequest {
            state,
            query_receipts,
            fragments,
            error,
        })
        .send()
        .await
        .map_err(|error| request_error("completing an Analysis run", error))?;
    let body: RunResponse = response(
        raw,
        user_id,
        "completed Analysis run",
        MAX_DEFINITION_RESPONSE_BYTES,
    )
    .await?;
    validate_run(&body.run, article_id, Some(run_id))?;
    if body.run.state != state || body.run.finished_at.is_none() {
        return Err(AppError::Network(
            "Analysis run completion changed terminal state".into(),
        ));
    }
    Ok(body.run)
}

pub(crate) async fn get_analysis_run(
    user_id: &str,
    workspace_id: Uuid,
    article_id: Uuid,
    run_id: Uuid,
) -> AppResult<RemoteAnalysisRun> {
    let token = token(user_id)?;
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
    let token = token(user_id)?;
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
    let token = token(user_id)?;
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
    let token = token(user_id)?;
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
) -> AppResult<Option<RemoteAnalysisLease>> {
    let token = token(user_id)?;
    let raw = client()?
        .post(format!(
            "{}/api/v1/workspaces/{workspace_id}/analyses/leases",
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
        || lease.article_revision < 1
        || lease.article.id != lease.article_id
        || lease.article.deleted
        || lease.capability.len() != 64
        || !lease
            .capability
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
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
        scheduled_at: lease.scheduled_at,
        expires_at: lease.expires_at,
        capability: Zeroizing::new(lease.capability),
        parameter_values: lease.parameter_values,
        article: lease.article,
    }))
}

pub(crate) async fn release_analysis_refresh_lease(
    user_id: &str,
    workspace_id: Uuid,
    lease: &RemoteAnalysisLease,
) -> AppResult<bool> {
    let token = token(user_id)?;
    let raw = client()?
        .delete(format!(
            "{}/api/v1/workspaces/{workspace_id}/analyses/leases/{}",
            origin()?,
            lease.id
        ))
        .bearer_auth(token.as_str())
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
    let token = token(user_id)?;
    let raw = client()?
        .get(format!(
            "{}/api/v1/workspaces/{workspace_id}/analyses/leases/{}",
            origin()?,
            lease.id
        ))
        .bearer_auth(token.as_str())
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
