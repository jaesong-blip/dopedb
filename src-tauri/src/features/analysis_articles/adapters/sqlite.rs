//! SQLite-backed local recovery, runner settings, and signal-sample adapter.

use uuid::Uuid;

use crate::error::AppResult;
use crate::store::{
    LocalAnalysisSignalMetricSample as StoredSignalSample,
    LocalAnalysisSignalState as StoredSignalState, Store,
};

use super::super::domain::AnalysisDefinitionRunReceipt;
use super::super::ports::{
    AnalysisLocalRepositoryPort, AnalysisSignalSampleWrite, LocalAnalysisSignalMetricSample,
    LocalAnalysisSignalState,
};

#[derive(Clone)]
pub(crate) struct SqliteAnalysisLocalRepository {
    store: Store,
}

impl SqliteAnalysisLocalRepository {
    pub(crate) fn new(store: Store) -> Self {
        Self { store }
    }
}

impl AnalysisLocalRepositoryPort for SqliteAnalysisLocalRepository {
    async fn load_result(
        &self,
        article_id: Uuid,
        run_id: Option<Uuid>,
    ) -> AppResult<Option<AnalysisDefinitionRunReceipt>> {
        self.store
            .load_analysis_article_local_result(article_id, run_id)
            .await
    }

    async fn delete_results(&self, article_id: Uuid) -> AppResult<()> {
        self.store
            .delete_analysis_article_local_results(article_id)
            .await
    }

    async fn save_result(
        &self,
        workspace_id: Uuid,
        receipt: &AnalysisDefinitionRunReceipt,
        retention_days: u16,
    ) -> AppResult<()> {
        self.store
            .save_analysis_article_local_result(workspace_id, receipt, retention_days)
            .await
    }

    async fn background_allowed(&self) -> AppResult<bool> {
        self.store.automation_runner_background_allowed().await
    }

    async fn set_background_allowed(&self, allowed: bool) -> AppResult<()> {
        self.store
            .set_automation_runner_background_allowed(allowed)
            .await
    }

    async fn runner_device_id(&self, account_user_id: &str, workspace_id: Uuid) -> AppResult<Uuid> {
        self.store
            .automation_runner_device_id(account_user_id, workspace_id)
            .await
    }

    async fn replace_runner_device_id(
        &self,
        account_user_id: &str,
        workspace_id: Uuid,
    ) -> AppResult<Uuid> {
        self.store
            .replace_automation_runner_device_id(account_user_id, workspace_id)
            .await
    }

    async fn record_signal_sample(&self, sample: AnalysisSignalSampleWrite) -> AppResult<()> {
        self.store
            .record_analysis_signal_metric_sample(
                sample.workspace_id,
                &sample.account_id,
                sample.signal_id,
                sample.signal_revision,
                sample.scheduled_at,
                sample.evaluated_at,
                sample.metric_value,
                sample.sample_count,
                into_stored_state(sample.state),
                &sample.schema_fingerprint,
            )
            .await
    }

    async fn recent_signal_samples(
        &self,
        workspace_id: Uuid,
        account_id: &str,
        signal_id: Uuid,
        signal_revision: u64,
        limit: usize,
    ) -> AppResult<Vec<LocalAnalysisSignalMetricSample>> {
        self.store
            .recent_analysis_signal_metric_samples(
                workspace_id,
                account_id,
                signal_id,
                signal_revision,
                limit,
            )
            .await
            .map(|samples| samples.into_iter().map(from_stored_sample).collect())
    }
}

fn into_stored_state(state: LocalAnalysisSignalState) -> StoredSignalState {
    match state {
        LocalAnalysisSignalState::Normal => StoredSignalState::Normal,
        LocalAnalysisSignalState::Firing => StoredSignalState::Firing,
        LocalAnalysisSignalState::NoData => StoredSignalState::NoData,
        LocalAnalysisSignalState::Error => StoredSignalState::Error,
        LocalAnalysisSignalState::Stale => StoredSignalState::Stale,
    }
}

fn from_stored_state(state: StoredSignalState) -> LocalAnalysisSignalState {
    match state {
        StoredSignalState::Normal => LocalAnalysisSignalState::Normal,
        StoredSignalState::Firing => LocalAnalysisSignalState::Firing,
        StoredSignalState::NoData => LocalAnalysisSignalState::NoData,
        StoredSignalState::Error => LocalAnalysisSignalState::Error,
        StoredSignalState::Stale => LocalAnalysisSignalState::Stale,
    }
}

fn from_stored_sample(sample: StoredSignalSample) -> LocalAnalysisSignalMetricSample {
    LocalAnalysisSignalMetricSample {
        metric_value: sample.metric_value,
        sample_count: sample.sample_count,
        evaluated_at: sample.evaluated_at,
        observed_state: from_stored_state(sample.observed_state),
    }
}
