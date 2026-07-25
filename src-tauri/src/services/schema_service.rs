//! Structured schema-change preview and exact proposal orchestration.

use chrono::{DateTime, Utc};
use dopedb_protocol::{DdlPlan, OperationState, SchemaChangeRequest};
use serde::Serialize;
use uuid::Uuid;

use crate::error::AppResult;
use crate::features::catalog::{CatalogFeature, CatalogReadPolicy};

use super::{
    DesktopScriptProposalRequest, DesktopScriptRunError, DesktopScriptRunReceipt,
    SchemaScriptContext, ScriptService,
};

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct SchemaChangePreviewRequest {
    pub(crate) connection_id: Uuid,
    pub(crate) request: SchemaChangeRequest,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SchemaChangeProposalReceipt {
    pub(crate) operation_id: Uuid,
    pub(crate) payload_hash: String,
    pub(crate) state: OperationState,
    pub(crate) confirmation_phrase: Option<String>,
    pub(crate) statement_count: usize,
    pub(crate) expires_at: DateTime<Utc>,
    pub(crate) plan: DdlPlan,
}

#[derive(Clone)]
pub(crate) struct SchemaService {
    catalog: CatalogFeature,
    script: ScriptService,
}

impl SchemaService {
    pub(super) fn new(catalog: CatalogFeature, script: ScriptService) -> Self {
        Self { catalog, script }
    }

    pub(crate) async fn preview(&self, request: SchemaChangePreviewRequest) -> AppResult<DdlPlan> {
        let snapshot = self
            .catalog
            .load_snapshot(request.connection_id.into(), CatalogReadPolicy::Refresh)
            .await?;
        crate::ddl::render(&snapshot, &request.request)
    }

    pub(crate) async fn propose(
        &self,
        request: SchemaChangePreviewRequest,
    ) -> Result<SchemaChangeProposalReceipt, DesktopScriptRunError> {
        let plan = self
            .preview(request.clone())
            .await
            .map_err(DesktopScriptRunError::Application)?;
        let proposal = self
            .script
            .propose_desktop(DesktopScriptProposalRequest {
                connection_id: request.connection_id,
                sql: plan.sql(),
                origin: Some("schema_editor".into()),
                schema_change: Some(SchemaScriptContext {
                    request: request.request,
                    plan: plan.clone(),
                }),
                table_change: None,
            })
            .await?;
        Ok(SchemaChangeProposalReceipt {
            operation_id: proposal.operation_id,
            payload_hash: proposal.payload_hash,
            state: proposal.state,
            confirmation_phrase: proposal.confirmation_phrase,
            statement_count: proposal.statement_count,
            expires_at: proposal.expires_at,
            plan,
        })
    }

    pub(crate) async fn run(
        &self,
        operation_id: Uuid,
    ) -> Result<DesktopScriptRunReceipt, DesktopScriptRunError> {
        self.script.run_desktop(operation_id).await
    }
}
