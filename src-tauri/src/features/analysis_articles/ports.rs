//! Adapter-neutral contracts owned by the Analysis Article feature.

use std::collections::BTreeMap;
use std::future::Future;

use chrono::{DateTime, Utc};
use dopedb_protocol::{
    AnalysisArticleConnection, AnalysisArticleRecord, AnalysisParameter, AnalysisQueryNode,
    AnalysisQueryReceipt, SharedAnalysisArticleCreate,
};
use serde_json::Value;
use uuid::Uuid;

use crate::error::AppResult;

use super::domain::{AnalysisDataSet, AnalysisDefinitionRunReceipt};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LocalAnalysisSignalState {
    Normal,
    Firing,
    NoData,
    Error,
    Stale,
}

#[derive(Debug, Clone)]
pub(crate) struct LocalAnalysisSignalMetricSample {
    pub(crate) metric_value: Option<f64>,
    pub(crate) sample_count: u64,
    pub(crate) evaluated_at: DateTime<Utc>,
    pub(crate) observed_state: LocalAnalysisSignalState,
}

#[derive(Debug, Clone)]
pub(crate) struct AnalysisSignalSampleWrite {
    pub(crate) workspace_id: Uuid,
    pub(crate) account_id: String,
    pub(crate) signal_id: Uuid,
    pub(crate) signal_revision: u64,
    pub(crate) scheduled_at: DateTime<Utc>,
    pub(crate) evaluated_at: DateTime<Utc>,
    pub(crate) metric_value: Option<f64>,
    pub(crate) sample_count: u64,
    pub(crate) state: LocalAnalysisSignalState,
    pub(crate) schema_fingerprint: String,
}

pub(crate) trait AnalysisLocalRepositoryPort: Clone + Send + Sync + 'static {
    fn load_result(
        &self,
        article_id: Uuid,
        run_id: Option<Uuid>,
    ) -> impl Future<Output = AppResult<Option<AnalysisDefinitionRunReceipt>>> + Send;

    fn delete_results(&self, article_id: Uuid) -> impl Future<Output = AppResult<()>> + Send;

    fn save_result(
        &self,
        workspace_id: Uuid,
        receipt: &AnalysisDefinitionRunReceipt,
        retention_days: u16,
    ) -> impl Future<Output = AppResult<()>> + Send;

    fn background_allowed(&self) -> impl Future<Output = AppResult<bool>> + Send;

    fn set_background_allowed(&self, allowed: bool) -> impl Future<Output = AppResult<()>> + Send;

    fn runner_device_id(
        &self,
        account_user_id: &str,
        workspace_id: Uuid,
    ) -> impl Future<Output = AppResult<Uuid>> + Send;

    fn replace_runner_device_id(
        &self,
        account_user_id: &str,
        workspace_id: Uuid,
    ) -> impl Future<Output = AppResult<Uuid>> + Send;

    fn record_signal_sample(
        &self,
        sample: AnalysisSignalSampleWrite,
    ) -> impl Future<Output = AppResult<()>> + Send;

    fn recent_signal_samples(
        &self,
        workspace_id: Uuid,
        account_id: &str,
        signal_id: Uuid,
        signal_revision: u64,
        limit: usize,
    ) -> impl Future<Output = AppResult<Vec<LocalAnalysisSignalMetricSample>>> + Send;
}

pub(crate) struct AnalysisReadExecutionRequest<'a> {
    pub(crate) workspace_id: Option<Uuid>,
    pub(crate) project_environment_id: Option<Uuid>,
    pub(crate) authority: &'a AnalysisArticleConnection,
    pub(crate) query: &'a AnalysisQueryNode,
    pub(crate) parameter_definitions: &'a [AnalysisParameter],
    pub(crate) parameters: &'a BTreeMap<String, Value>,
    pub(crate) run_id: Uuid,
    pub(crate) cancellation_id: Uuid,
}

pub(crate) struct AnalysisReadExecutionOutcome {
    pub(crate) receipt: AnalysisQueryReceipt,
    pub(crate) data: AnalysisDataSet,
}

pub(crate) trait AnalysisReadExecutionPort: Clone + Send + Sync + 'static {
    fn verify_join_mappings(
        &self,
        mapping_ids: &[Uuid],
    ) -> impl Future<Output = AppResult<()>> + Send;

    fn execute_read<'a>(
        &'a self,
        request: AnalysisReadExecutionRequest<'a>,
    ) -> impl Future<Output = AppResult<AnalysisReadExecutionOutcome>> + Send + 'a;
}

#[derive(Debug, Clone)]
pub(crate) enum AnalysisArticleMutation {
    Update(Box<SharedAnalysisArticleCreate>),
    SubmitReview,
    ReturnDraft,
    PublishLive,
    Archive,
    Transfer { owner_member_id: String },
    Restore { revision: i64 },
}

pub(crate) trait AnalysisHostedAuthorityPort: Clone + Send + Sync + 'static {
    fn list_articles(
        &self,
        account_id: &str,
        workspace_id: Uuid,
        environment_id: Option<Uuid>,
    ) -> impl Future<Output = AppResult<Vec<AnalysisArticleRecord>>> + Send;

    fn get_article(
        &self,
        account_id: &str,
        workspace_id: Uuid,
        article_id: Uuid,
    ) -> impl Future<Output = AppResult<AnalysisArticleRecord>> + Send;

    fn create_article(
        &self,
        account_id: &str,
        workspace_id: Uuid,
        article: &SharedAnalysisArticleCreate,
    ) -> impl Future<Output = AppResult<AnalysisArticleRecord>> + Send;

    fn mutate_article(
        &self,
        account_id: &str,
        workspace_id: Uuid,
        article_id: Uuid,
        expected_revision: i64,
        mutation: AnalysisArticleMutation,
    ) -> impl Future<Output = AppResult<AnalysisArticleRecord>> + Send;
}
