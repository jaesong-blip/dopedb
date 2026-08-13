//! Typed ERD persistence use cases.

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::kernel::identity::{ConnectionId, ErdLayoutId};

use super::domain::{
    ErdCanvasLayout, ErdLayout, ErdLayoutMode, ErdLayoutPayload, ErdVirtualRelation,
};
use super::ports::{
    ErdAuthorityGuard, ErdAuthorityPort, ErdGeneratorPort, ErdRepositoryPort, SaveErdLayoutCommand,
    SaveErdRepositoryOutcome,
};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SaveErdLayoutRequest {
    pub(crate) id: Option<ErdLayoutId>,
    pub(crate) connection_id: ConnectionId,
    pub(crate) name: String,
    pub(crate) mode: ErdLayoutMode,
    pub(crate) catalog_fingerprint: String,
    pub(crate) layout: ErdCanvasLayout,
    #[serde(default)]
    pub(crate) virtual_relations: Vec<ErdVirtualRelation>,
    pub(crate) expected_revision: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveErdLayoutOutcome {
    pub(crate) saved: bool,
    pub(crate) layout: ErdLayout,
}

#[derive(Clone)]
pub(crate) struct ErdUseCases<R, A, G> {
    repository: R,
    authority: A,
    generator: G,
}

impl<R, A, G> ErdUseCases<R, A, G>
where
    R: ErdRepositoryPort,
    A: ErdAuthorityPort,
    G: ErdGeneratorPort,
{
    pub(crate) fn new(repository: R, authority: A, generator: G) -> Self {
        Self {
            repository,
            authority,
            generator,
        }
    }

    pub(crate) async fn list(&self, connection_id: ConnectionId) -> AppResult<Vec<ErdLayout>> {
        let guard = self.authority.authorize(connection_id).await?;
        self.repository.list(guard.authority()).await
    }

    pub(crate) async fn save(
        &self,
        request: SaveErdLayoutRequest,
    ) -> AppResult<SaveErdLayoutOutcome> {
        let payload = ErdLayoutPayload::validated(
            request.name,
            request.mode,
            request.catalog_fingerprint,
            request.layout,
            request.virtual_relations,
        )?;
        let command = match request.id {
            Some(id) => {
                let expected_revision = request.expected_revision.ok_or_else(|| {
                    AppError::Config("existing ERD layouts require an expected revision".into())
                })?;
                validate_revision(expected_revision)?;
                SaveErdLayoutCommand::Update {
                    id,
                    payload,
                    expected_revision,
                    updated_at: self.generator.now(),
                }
            }
            None => {
                if request.expected_revision.is_some() {
                    return Err(AppError::Config(
                        "new ERD layouts must not include an expected revision".into(),
                    ));
                }
                SaveErdLayoutCommand::Create {
                    id: self.generator.next_id(),
                    payload,
                    now: self.generator.now(),
                }
            }
        };
        let guard = self.authority.authorize(request.connection_id).await?;
        let outcome = self.repository.save(guard.authority(), command).await?;
        let (saved, layout) = match outcome {
            SaveErdRepositoryOutcome::Saved(layout) => (true, layout),
            SaveErdRepositoryOutcome::Conflict(layout) => (false, layout),
        };
        Ok(SaveErdLayoutOutcome { saved, layout })
    }
}

fn validate_revision(revision: i64) -> AppResult<()> {
    if revision < 1 {
        return Err(AppError::Config(
            "ERD layout expected revision must be positive".into(),
        ));
    }
    Ok(())
}
