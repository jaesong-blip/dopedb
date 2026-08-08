//! Exact-grant local persistence for Environment funnel analysis drafts.

use super::super::*;
use dopedb_protocol::FunnelAnalysisArtifactRecord;
use dopedb_protocol::FunnelAnalysisFreshness;

const MAX_FUNNEL_DEFINITION_JSON_BYTES: usize = 1024 * 1024;

fn funnel_u64_to_i64(value: u64, field: &str) -> AppResult<i64> {
    i64::try_from(value).map_err(|_| AppError::Config(format!("{field} is too large")))
}

impl Store {
    pub(crate) async fn save_funnel_analysis_draft(
        &self,
        workspace_id: Uuid,
        account_user_id: &str,
        artifact: &FunnelAnalysisArtifactRecord,
    ) -> AppResult<()> {
        if account_user_id.is_empty()
            || artifact.state != "draft"
            || artifact.revision != 1
            || artifact.environment_revision == 0
            || artifact.graph_revision_ids.is_empty()
        {
            return Err(AppError::Config(
                "the funnel analysis draft has invalid authority metadata".into(),
            ));
        }
        let definition_json = serde_json::to_string(artifact)?;
        if definition_json.len() > MAX_FUNNEL_DEFINITION_JSON_BYTES {
            return Err(AppError::Config(
                "the funnel analysis draft exceeds the local definition budget".into(),
            ));
        }
        let graph_revision_ids = serde_json::to_string(&artifact.graph_revision_ids)?;
        let inserted = sqlx::query(
            "INSERT INTO funnel_analysis_artifacts
                (id, workspace_id, account_user_id, project_environment_id,
                 environment_revision, knowledge_grant_id, graph_revision_ids,
                 definition_json, state, revision, sync_status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'draft', 1, 'local', ?9, ?9)",
        )
        .bind(artifact.id.to_string())
        .bind(workspace_id.to_string())
        .bind(account_user_id)
        .bind(artifact.project_environment_id.to_string())
        .bind(funnel_u64_to_i64(
            artifact.environment_revision,
            "environment revision",
        )?)
        .bind(artifact.knowledge_grant_id.to_string())
        .bind(graph_revision_ids)
        .bind(definition_json)
        .bind(artifact.created_at)
        .execute(&self.pool)
        .await?;
        if inserted.rows_affected() != 1 {
            return Err(AppError::Config(
                "the funnel analysis draft was not persisted".into(),
            ));
        }
        Ok(())
    }

    pub(crate) async fn list_funnel_analysis_for_scope(
        &self,
        workspace_id: Uuid,
        account_user_id: &str,
        project_environment_id: Uuid,
        environment_revision: u64,
        knowledge_grant_id: Uuid,
        graph_revision_ids: &[Uuid],
    ) -> AppResult<Vec<FunnelAnalysisArtifactRecord>> {
        let rows: Vec<String> = sqlx::query_scalar(
            "SELECT definition_json
             FROM funnel_analysis_artifacts
             WHERE workspace_id = ?1 AND account_user_id = ?2
               AND project_environment_id = ?3 AND deleted_at IS NULL
             ORDER BY updated_at DESC, id",
        )
        .bind(workspace_id.to_string())
        .bind(account_user_id)
        .bind(project_environment_id.to_string())
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                let mut artifact: FunnelAnalysisArtifactRecord = serde_json::from_str(&row)?;
                if artifact.project_environment_id != project_environment_id {
                    return Err(AppError::Blocked {
                        reason: "a stored funnel analysis changed Environment identity".into(),
                    });
                }
                if artifact.environment_revision != environment_revision
                    || artifact.graph_revision_ids != graph_revision_ids
                {
                    artifact.freshness = FunnelAnalysisFreshness::GraphDrift;
                }
                artifact.knowledge_grant_id = knowledge_grant_id;
                Ok(artifact)
            })
            .collect()
    }

    pub(crate) async fn sync_remote_funnel_analysis(
        &self,
        workspace_id: Uuid,
        account_user_id: &str,
        artifact: &FunnelAnalysisArtifactRecord,
    ) -> AppResult<()> {
        if account_user_id.is_empty()
            || artifact.state != "published"
            || artifact.revision < 1
            || artifact.published_from_knowledge_grant_id.is_none()
        {
            return Err(AppError::Config(
                "the remote funnel analysis projection is invalid".into(),
            ));
        }
        let definition_json = serde_json::to_string(artifact)?;
        let graph_revision_ids = serde_json::to_string(&artifact.graph_revision_ids)?;
        let changed = sqlx::query(
            "INSERT INTO funnel_analysis_artifacts
                (id, workspace_id, account_user_id, project_environment_id,
                 environment_revision, knowledge_grant_id, graph_revision_ids,
                 definition_json, state, revision, remote_id, remote_revision,
                 sync_status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'published', ?9,
                     ?1, ?9, 'synced', ?10, ?11)
             ON CONFLICT(id, account_user_id) DO UPDATE SET
                 project_environment_id = excluded.project_environment_id,
                 environment_revision = excluded.environment_revision,
                 knowledge_grant_id = excluded.knowledge_grant_id,
                 graph_revision_ids = excluded.graph_revision_ids,
                 definition_json = excluded.definition_json,
                 state = excluded.state,
                 revision = excluded.revision,
                 remote_id = excluded.remote_id,
                 remote_revision = excluded.remote_revision,
                 sync_status = 'synced',
                 deleted_at = NULL,
                 updated_at = excluded.updated_at
             WHERE funnel_analysis_artifacts.remote_id IS NOT NULL
               AND funnel_analysis_artifacts.remote_revision <= excluded.remote_revision",
        )
        .bind(artifact.id.to_string())
        .bind(workspace_id.to_string())
        .bind(account_user_id)
        .bind(artifact.project_environment_id.to_string())
        .bind(funnel_u64_to_i64(
            artifact.environment_revision,
            "environment revision",
        )?)
        .bind(artifact.knowledge_grant_id.to_string())
        .bind(graph_revision_ids)
        .bind(definition_json)
        .bind(artifact.revision)
        .bind(artifact.created_at)
        .bind(artifact.updated_at)
        .execute(&self.pool)
        .await?;
        if changed.rows_affected() == 0 {
            return Err(AppError::Blocked {
                reason: "a local funnel analysis draft already uses the remote identity".into(),
            });
        }
        Ok(())
    }

    pub(crate) async fn mark_funnel_analysis_published(
        &self,
        workspace_id: Uuid,
        account_user_id: &str,
        artifact_id: Uuid,
        remote_revision: i64,
    ) -> AppResult<FunnelAnalysisArtifactRecord> {
        if remote_revision < 1 {
            return Err(AppError::Config(
                "the published funnel analysis revision is invalid".into(),
            ));
        }
        let current: String = sqlx::query_scalar(
            "SELECT definition_json FROM funnel_analysis_artifacts
             WHERE id = ?1 AND workspace_id = ?2 AND account_user_id = ?3
               AND state = 'draft' AND revision = 1 AND deleted_at IS NULL",
        )
        .bind(artifact_id.to_string())
        .bind(workspace_id.to_string())
        .bind(account_user_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| AppError::Blocked {
            reason: "the funnel analysis draft changed before publication".into(),
        })?;
        let mut artifact: FunnelAnalysisArtifactRecord = serde_json::from_str(&current)?;
        artifact.published_from_knowledge_grant_id = Some(artifact.knowledge_grant_id);
        artifact.state = "published".into();
        artifact.revision = remote_revision;
        artifact.updated_at = Utc::now();
        let definition_json = serde_json::to_string(&artifact)?;
        let changed = sqlx::query(
            "UPDATE funnel_analysis_artifacts
             SET definition_json = ?1, state = 'published', revision = ?2,
                 remote_id = ?3, remote_revision = ?2, sync_status = 'synced',
                 updated_at = ?4
             WHERE id = ?3 AND workspace_id = ?5 AND account_user_id = ?6
               AND state = 'draft' AND revision = 1 AND deleted_at IS NULL",
        )
        .bind(definition_json)
        .bind(remote_revision)
        .bind(artifact_id.to_string())
        .bind(artifact.updated_at)
        .bind(workspace_id.to_string())
        .bind(account_user_id)
        .execute(&self.pool)
        .await?;
        if changed.rows_affected() != 1 {
            return Err(AppError::Blocked {
                reason: "the funnel analysis draft changed while publication completed".into(),
            });
        }
        Ok(artifact)
    }
}
