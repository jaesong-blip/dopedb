//! Adapter from the schema use case to the existing immutable Script operation path.

use crate::error::AppResult;
use crate::features::scripts::{
    DesktopScriptProposalRequest, DesktopScriptRunError, DesktopScriptRunReceipt,
    SchemaScriptContext, ScriptFeature,
};
use crate::kernel::identity::OperationId;

use super::super::domain::{SchemaScriptProposal, SchemaScriptProposalCommand};
use super::super::ports::SchemaScriptPort;

#[derive(Clone)]
pub(in crate::features::schema_editor) struct ScriptSchemaGateway {
    script: ScriptFeature,
}

impl ScriptSchemaGateway {
    pub(in crate::features::schema_editor) fn new(script: ScriptFeature) -> Self {
        Self { script }
    }
}

impl SchemaScriptPort for ScriptSchemaGateway {
    type RunReceipt = DesktopScriptRunReceipt;

    async fn propose(
        &self,
        command: SchemaScriptProposalCommand,
    ) -> AppResult<SchemaScriptProposal> {
        let proposal = self
            .script
            .propose_desktop(DesktopScriptProposalRequest {
                connection_id: command.connection_id.into(),
                sql: command.plan.sql(),
                origin: Some("schema_editor".into()),
                schema_change: Some(SchemaScriptContext {
                    request: command.request,
                    plan: command.plan,
                }),
                table_change: None,
            })
            .await
            .map_err(DesktopScriptRunError::into_error)?;
        Ok(SchemaScriptProposal {
            operation_id: OperationId::from(proposal.operation_id),
            payload_hash: proposal.payload_hash,
            state: proposal.state,
            confirmation_phrase: proposal.confirmation_phrase,
            statement_count: proposal.statement_count,
            expires_at: proposal.expires_at,
        })
    }

    async fn run(&self, operation_id: OperationId) -> AppResult<Self::RunReceipt> {
        self.script
            .run_desktop(operation_id.into())
            .await
            .map_err(DesktopScriptRunError::into_error)
    }
}
