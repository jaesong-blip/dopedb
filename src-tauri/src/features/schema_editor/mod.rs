//! Structured schema-editor vertical slice.

mod adapters;
mod application;
mod domain;
mod ports;
pub(crate) mod transport;

use crate::error::AppResult;
use crate::features::catalog::CatalogFeature;
use crate::features::scripts::{DesktopScriptRunReceipt, ScriptFeature};
use crate::kernel::identity::OperationId;

use adapters::{DdlSchemaPlanner, SchemaCatalogAdapter, ScriptSchemaGateway};
use application::SchemaEditorUseCases;
pub(crate) use domain::{SchemaChangeCommand, SchemaChangeProposal};

type ComposedSchemaEditor =
    SchemaEditorUseCases<SchemaCatalogAdapter, DdlSchemaPlanner, ScriptSchemaGateway>;

#[derive(Clone)]
pub(crate) struct SchemaEditorFeature {
    application: ComposedSchemaEditor,
}

impl SchemaEditorFeature {
    pub(crate) async fn preview(
        &self,
        command: SchemaChangeCommand,
    ) -> AppResult<dopedb_protocol::DdlPlan> {
        self.application.preview(command).await
    }

    pub(crate) async fn propose(
        &self,
        command: SchemaChangeCommand,
    ) -> AppResult<SchemaChangeProposal> {
        self.application.propose(command).await
    }

    pub(crate) async fn run(
        &self,
        operation_id: OperationId,
    ) -> AppResult<DesktopScriptRunReceipt> {
        self.application.run(operation_id).await
    }
}

pub(crate) fn compose(catalog: CatalogFeature, script: ScriptFeature) -> SchemaEditorFeature {
    SchemaEditorFeature {
        application: SchemaEditorUseCases::new(
            SchemaCatalogAdapter::new(catalog),
            DdlSchemaPlanner,
            ScriptSchemaGateway::new(script),
        ),
    }
}
