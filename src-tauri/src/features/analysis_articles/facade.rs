//! Analysis Article application facade. It depends only on feature-owned ports;
//! SQLite, connection runtimes, and hosted HTTP remain in concrete adapters.

use std::time::Duration;

use crate::error::AppResult;

use super::domain::{AnalysisDefinitionRunReceipt, AnalysisDefinitionRunRequest};
use super::ports::{
    AnalysisArticleMutation, AnalysisHostedAuthorityPort, AnalysisLocalRepositoryPort,
    AnalysisReadExecutionPort, AnalysisSignalSampleWrite, LocalAnalysisSignalMetricSample,
    LocalAnalysisSignalState,
};
use super::runner::AnalysisArticleRunner;
use super::validation::validate_shared_create;

const LOCAL_RESULT_SAVE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone)]
pub(crate) struct AnalysisArticlesFeature<L, E, H> {
    runner: AnalysisArticleRunner<E>,
    local: L,
    hosted: H,
}

impl<L, E, H> AnalysisArticlesFeature<L, E, H>
where
    L: AnalysisLocalRepositoryPort,
    E: AnalysisReadExecutionPort,
    H: AnalysisHostedAuthorityPort,
{
    pub(crate) fn new(local: L, execution: E, hosted: H) -> Self {
        Self {
            runner: AnalysisArticleRunner::new(execution),
            local,
            hosted,
        }
    }

    pub(crate) async fn load_local_result(
        &self,
        article_id: uuid::Uuid,
        run_id: Option<uuid::Uuid>,
    ) -> AppResult<Option<AnalysisDefinitionRunReceipt>> {
        self.local.load_result(article_id, run_id).await
    }

    pub(crate) async fn delete_local_results(&self, article_id: uuid::Uuid) -> AppResult<()> {
        self.local.delete_results(article_id).await
    }

    pub(crate) async fn background_allowed(&self) -> AppResult<bool> {
        self.local.background_allowed().await
    }

    pub(crate) async fn set_background_allowed(&self, allowed: bool) -> AppResult<()> {
        self.local.set_background_allowed(allowed).await
    }

    pub(crate) async fn runner_device_id(
        &self,
        account_user_id: &str,
        workspace_id: uuid::Uuid,
    ) -> AppResult<uuid::Uuid> {
        self.local
            .runner_device_id(account_user_id, workspace_id)
            .await
    }

    pub(crate) async fn replace_runner_device_id(
        &self,
        account_user_id: &str,
        workspace_id: uuid::Uuid,
    ) -> AppResult<uuid::Uuid> {
        self.local
            .replace_runner_device_id(account_user_id, workspace_id)
            .await
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn record_signal_sample(
        &self,
        workspace_id: uuid::Uuid,
        account_id: &str,
        signal_id: uuid::Uuid,
        signal_revision: u64,
        scheduled_at: chrono::DateTime<chrono::Utc>,
        evaluated_at: chrono::DateTime<chrono::Utc>,
        metric_value: Option<f64>,
        sample_count: u64,
        state: LocalAnalysisSignalState,
        schema_fingerprint: &str,
    ) -> AppResult<()> {
        self.local
            .record_signal_sample(AnalysisSignalSampleWrite {
                workspace_id,
                account_id: account_id.to_owned(),
                signal_id,
                signal_revision,
                scheduled_at,
                evaluated_at,
                metric_value,
                sample_count,
                state,
                schema_fingerprint: schema_fingerprint.to_owned(),
            })
            .await
    }

    pub(crate) async fn recent_signal_samples(
        &self,
        workspace_id: uuid::Uuid,
        account_id: &str,
        signal_id: uuid::Uuid,
        signal_revision: u64,
        limit: usize,
    ) -> AppResult<Vec<LocalAnalysisSignalMetricSample>> {
        self.local
            .recent_signal_samples(workspace_id, account_id, signal_id, signal_revision, limit)
            .await
    }

    pub(crate) async fn list_remote(
        &self,
        account_id: &str,
        workspace_id: uuid::Uuid,
        environment_id: Option<uuid::Uuid>,
    ) -> AppResult<Vec<dopedb_protocol::AnalysisArticleRecord>> {
        self.hosted
            .list_articles(account_id, workspace_id, environment_id)
            .await
    }

    pub(crate) async fn get_remote(
        &self,
        account_id: &str,
        workspace_id: uuid::Uuid,
        article_id: uuid::Uuid,
    ) -> AppResult<dopedb_protocol::AnalysisArticleRecord> {
        self.hosted
            .get_article(account_id, workspace_id, article_id)
            .await
    }

    pub(crate) async fn create_remote(
        &self,
        account_id: &str,
        workspace_id: uuid::Uuid,
        article: &dopedb_protocol::SharedAnalysisArticleCreate,
    ) -> AppResult<dopedb_protocol::AnalysisArticleRecord> {
        validate_shared_create(article)?;
        self.hosted
            .create_article(account_id, workspace_id, article)
            .await
    }

    pub(crate) async fn mutate_remote(
        &self,
        account_id: &str,
        workspace_id: uuid::Uuid,
        article_id: uuid::Uuid,
        expected_revision: i64,
        mutation: AnalysisArticleMutation,
    ) -> AppResult<dopedb_protocol::AnalysisArticleRecord> {
        if let AnalysisArticleMutation::Update(article) = &mutation {
            validate_shared_create(article)?;
        }
        self.hosted
            .mutate_article(
                account_id,
                workspace_id,
                article_id,
                expected_revision,
                mutation,
            )
            .await
    }

    pub(crate) async fn run_definition(
        &self,
        request: AnalysisDefinitionRunRequest,
    ) -> AppResult<AnalysisDefinitionRunReceipt> {
        let workspace_id = request.workspace_id;
        let retention_days = request.definition.refresh.result_retention_days;
        let persist_local_result = request.persist_local_result;
        let receipt = self.runner.run_definition(request).await?;
        if persist_local_result {
            if let Some(workspace_id) = workspace_id {
                // Local recovery is an optional device cache. Never hold the
                // immutable hosted completion receipt behind a locked keychain,
                // slow disk, or repairable cache-schema error.
                let local = self.local.clone();
                let cached_receipt = receipt.clone();
                tokio::spawn(async move {
                    match tokio::time::timeout(
                        LOCAL_RESULT_SAVE_TIMEOUT,
                        local.save_result(workspace_id, &cached_receipt, retention_days),
                    )
                    .await
                    {
                        Ok(Ok(())) => {}
                        Ok(Err(error)) => tracing::warn!(
                            error_kind = error.kind(),
                            article_id = %cached_receipt.article_id,
                            run_id = %cached_receipt.run_id,
                            "Analysis Article local recovery save deferred"
                        ),
                        Err(_) => tracing::warn!(
                            article_id = %cached_receipt.article_id,
                            run_id = %cached_receipt.run_id,
                            "Analysis Article local recovery save exceeded its deadline"
                        ),
                    }
                });
            }
        }
        Ok(receipt)
    }
}
