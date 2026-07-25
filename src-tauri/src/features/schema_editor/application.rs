//! Catalog-pinned structured schema change use cases.

use dopedb_protocol::DdlPlan;

use crate::error::AppResult;
use crate::kernel::identity::OperationId;

use super::domain::{SchemaChangeCommand, SchemaChangeProposal, SchemaScriptProposalCommand};
use super::ports::{SchemaCatalogPort, SchemaPlannerPort, SchemaScriptPort};

#[derive(Clone)]
pub(crate) struct SchemaEditorUseCases<C, P, S> {
    catalog: C,
    planner: P,
    script: S,
}

impl<C, P, S> SchemaEditorUseCases<C, P, S>
where
    C: SchemaCatalogPort,
    P: SchemaPlannerPort,
    S: SchemaScriptPort,
{
    pub(crate) fn new(catalog: C, planner: P, script: S) -> Self {
        Self {
            catalog,
            planner,
            script,
        }
    }

    pub(crate) async fn preview(&self, command: SchemaChangeCommand) -> AppResult<DdlPlan> {
        let snapshot = self.catalog.refresh(command.connection_id).await?;
        self.planner.render(&snapshot, &command.request)
    }

    pub(crate) async fn propose(
        &self,
        command: SchemaChangeCommand,
    ) -> AppResult<SchemaChangeProposal> {
        let plan = self.preview(command.clone()).await?;
        let proposal = self
            .script
            .propose(SchemaScriptProposalCommand {
                connection_id: command.connection_id,
                request: command.request,
                plan: plan.clone(),
            })
            .await?;
        Ok(SchemaChangeProposal {
            operation_id: proposal.operation_id,
            payload_hash: proposal.payload_hash,
            state: proposal.state,
            confirmation_phrase: proposal.confirmation_phrase,
            statement_count: proposal.statement_count,
            expires_at: proposal.expires_at,
            plan,
        })
    }

    pub(crate) async fn run(&self, operation_id: OperationId) -> AppResult<S::RunReceipt> {
        self.script.run(operation_id).await
    }
}
