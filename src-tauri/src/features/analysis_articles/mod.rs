//! Analysis Article vertical slice.

mod config;
mod domain;
mod runner;
pub(crate) mod runtime;
mod signals;
mod transforms;
pub(crate) mod transport;
mod validation;

use crate::connection::ConnectionManager;
use crate::error::AppResult;
use crate::store::Store;

pub(crate) use domain::{AnalysisDefinitionRunReceipt, AnalysisDefinitionRunRequest};
use runner::AnalysisArticleRunner;

#[derive(Clone)]
pub(crate) struct AnalysisArticlesFeature {
    runner: AnalysisArticleRunner,
    store: Store,
}

impl AnalysisArticlesFeature {
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
                if let Err(error) = self
                    .store
                    .save_analysis_article_local_result(workspace_id, &receipt, retention_days)
                    .await
                {
                    tracing::warn!(
                        error_kind = error.kind(),
                        article_id = %receipt.article_id,
                        run_id = %receipt.run_id,
                        "Analysis Article local recovery save deferred"
                    );
                }
            }
        }
        Ok(receipt)
    }
}

pub(crate) fn compose(store: Store, connections: ConnectionManager) -> AnalysisArticlesFeature {
    AnalysisArticlesFeature {
        runner: AnalysisArticleRunner::new(store.clone(), connections),
        store,
    }
}
