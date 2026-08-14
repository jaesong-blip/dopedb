//! Knowledge graph revision staging, activation, and lookup.

use chrono::Utc;
use dopedb_protocol::{GraphBuildArtifactV1, GraphRevisionDiffV1};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::store::{parse_uuid, Store};

use super::codec::{artifact_json, parse_artifact, u64_to_i64};

impl Store {
    /// Import a graph already authorized as the active revision by the hosted
    /// KnowledgeGrant endpoint. The authenticated response, artifact digest, and
    /// exact grant are verified before this trusted adapter boundary is called.
    pub(in crate::features::knowledge::adapters) async fn import_granted_active_graph(
        &self,
        artifact: &GraphBuildArtifactV1,
    ) -> AppResult<()> {
        self.stage(artifact).await?;
        let environment_revision =
            u64_to_i64(artifact.environment_revision, "environment revision")?;
        sqlx::query(
            "UPDATE knowledge_mapping_proposals
             SET state = 'stale', decided_at = ?3
             WHERE project_environment_id = ?1 AND graph_revision_id IN (
                   SELECT revision.graph_revision_id
                   FROM knowledge_graph_revisions revision
                   WHERE revision.source_id = ?4
                     AND revision.graph_revision_id <> ?2
               )
               AND state IN ('proposed', 'approved')",
        )
        .bind(artifact.binding.project_environment_id.to_string())
        .bind(artifact.graph_revision_id.to_string())
        .bind(Utc::now())
        .bind(artifact.binding.source_id.to_string())
        .execute(self.pool())
        .await?;
        sqlx::query(
            "INSERT INTO knowledge_environment_heads
                 (project_environment_id, source_id, graph_revision_id,
                  environment_revision, activated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(project_environment_id, source_id) DO UPDATE SET
                 graph_revision_id = excluded.graph_revision_id,
                 environment_revision = excluded.environment_revision,
                 activated_at = excluded.activated_at",
        )
        .bind(artifact.binding.project_environment_id.to_string())
        .bind(artifact.binding.source_id.to_string())
        .bind(artifact.graph_revision_id.to_string())
        .bind(environment_revision)
        .bind(Utc::now())
        .execute(self.pool())
        .await?;
        Ok(())
    }

    pub(in crate::features::knowledge::adapters) async fn retain_granted_environment_heads(
        &self,
        project_environment_id: Uuid,
        graph_revision_ids: &[Uuid],
    ) -> AppResult<()> {
        let heads: Vec<(String, String)> = sqlx::query_as(
            "SELECT head.source_id, head.graph_revision_id
             FROM knowledge_environment_heads head
             JOIN knowledge_sources source ON source.id = head.source_id
             WHERE head.project_environment_id = ?1
               AND source.provider = 'github'",
        )
        .bind(project_environment_id.to_string())
        .fetch_all(self.pool())
        .await?;
        for (source_id, graph_revision_id) in heads {
            let graph_revision_id = parse_uuid(graph_revision_id)?;
            if graph_revision_ids.contains(&graph_revision_id) {
                continue;
            }
            sqlx::query(
                "DELETE FROM knowledge_environment_heads
                 WHERE project_environment_id = ?1 AND source_id = ?2
                   AND graph_revision_id = ?3",
            )
            .bind(project_environment_id.to_string())
            .bind(source_id)
            .bind(graph_revision_id.to_string())
            .execute(self.pool())
            .await?;
        }
        Ok(())
    }
}

impl Store {
    pub(in crate::features::knowledge::adapters) async fn stage(
        &self,
        artifact: &GraphBuildArtifactV1,
    ) -> AppResult<()> {
        let (json, sha256) = artifact_json(artifact)?;
        let environment_revision =
            u64_to_i64(artifact.environment_revision, "environment revision")?;
        let stored_scope: Option<(String, String, i64)> = sqlx::query_as(
            "SELECT project_id, project_environment_id, environment_revision
             FROM knowledge_sources WHERE id = ?1",
        )
        .bind(artifact.binding.source_id.to_string())
        .fetch_optional(self.pool())
        .await?;
        if stored_scope
            != Some((
                artifact.binding.project_id.to_string(),
                artifact.binding.project_environment_id.to_string(),
                environment_revision,
            ))
        {
            return Err(AppError::Blocked {
                reason: "the Knowledge graph candidate belongs to a stale source scope".into(),
            });
        }
        sqlx::query(
            "INSERT INTO knowledge_graph_revisions
                 (graph_revision_id, source_id, project_environment_id,
                  environment_revision, parent_graph_revision_id,
                  source_revision_sha256, artifact_sha256, artifact_json,
                  generated_at, staged_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(graph_revision_id) DO NOTHING",
        )
        .bind(artifact.graph_revision_id.to_string())
        .bind(artifact.binding.source_id.to_string())
        .bind(artifact.binding.project_environment_id.to_string())
        .bind(environment_revision)
        .bind(artifact.parent_graph_revision_id.map(|id| id.to_string()))
        .bind(&artifact.source_revision_sha256)
        .bind(&sha256)
        .bind(&json)
        .bind(artifact.generated_at)
        .bind(Utc::now())
        .execute(self.pool())
        .await?;
        let stored: Option<(String, String)> = sqlx::query_as(
            "SELECT artifact_sha256, artifact_json
             FROM knowledge_graph_revisions WHERE graph_revision_id = ?1",
        )
        .bind(artifact.graph_revision_id.to_string())
        .fetch_optional(self.pool())
        .await?;
        if stored != Some((sha256, json)) {
            return Err(AppError::Blocked {
                reason: "a Knowledge graph revision ID was reused with different content".into(),
            });
        }
        Ok(())
    }

    pub(in crate::features::knowledge::adapters) async fn activate(
        &self,
        artifact: &GraphBuildArtifactV1,
    ) -> AppResult<()> {
        let (json, sha256) = artifact_json(artifact)?;
        let environment_revision =
            u64_to_i64(artifact.environment_revision, "environment revision")?;
        let environment_id = artifact.binding.project_environment_id.to_string();
        let mut tx = self.pool().begin().await?;
        let locked = sqlx::query(
            "UPDATE knowledge_project_environments SET updated_at = updated_at
             WHERE id = ?1 AND project_id = ?2 AND revision = ?3",
        )
        .bind(&environment_id)
        .bind(artifact.binding.project_id.to_string())
        .bind(environment_revision)
        .execute(&mut *tx)
        .await?;
        if locked.rows_affected() != 1 {
            return Err(AppError::Blocked {
                reason: "the Project Environment changed before graph activation".into(),
            });
        }
        let staged: Option<(String, String)> = sqlx::query_as(
            "SELECT artifact_sha256, artifact_json
             FROM knowledge_graph_revisions
             WHERE graph_revision_id = ?1 AND source_id = ?2
               AND project_environment_id = ?3 AND environment_revision = ?4",
        )
        .bind(artifact.graph_revision_id.to_string())
        .bind(artifact.binding.source_id.to_string())
        .bind(&environment_id)
        .bind(environment_revision)
        .fetch_optional(&mut *tx)
        .await?;
        if staged != Some((sha256, json)) {
            return Err(AppError::Blocked {
                reason: "the exact Knowledge graph candidate was not staged".into(),
            });
        }
        let current: Option<String> = sqlx::query_scalar(
            "SELECT graph_revision_id FROM knowledge_environment_heads
             WHERE project_environment_id = ?1 AND source_id = ?2",
        )
        .bind(&environment_id)
        .bind(artifact.binding.source_id.to_string())
        .fetch_optional(&mut *tx)
        .await?;
        if artifact.parent_graph_revision_id.map(|id| id.to_string()) != current {
            return Err(AppError::Blocked {
                reason:
                    "the Knowledge graph candidate is not based on the current last-good revision"
                        .into(),
            });
        }
        sqlx::query(
            "UPDATE knowledge_mapping_proposals
             SET state = 'stale', decided_at = ?3
             WHERE project_environment_id = ?1 AND graph_revision_id IN (
                   SELECT revision.graph_revision_id
                   FROM knowledge_graph_revisions revision
                   WHERE revision.source_id = ?4
                     AND revision.graph_revision_id <> ?2
               )
               AND state IN ('proposed', 'approved')",
        )
        .bind(&environment_id)
        .bind(artifact.graph_revision_id.to_string())
        .bind(Utc::now())
        .bind(artifact.binding.source_id.to_string())
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO knowledge_environment_heads
                 (project_environment_id, source_id, graph_revision_id,
                  environment_revision, activated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(project_environment_id, source_id) DO UPDATE SET
                 graph_revision_id = excluded.graph_revision_id,
                 environment_revision = excluded.environment_revision,
                 activated_at = excluded.activated_at",
        )
        .bind(&environment_id)
        .bind(artifact.binding.source_id.to_string())
        .bind(artifact.graph_revision_id.to_string())
        .bind(environment_revision)
        .bind(Utc::now())
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub(in crate::features::knowledge::adapters) async fn active_for_source(
        &self,
        source_id: Uuid,
    ) -> AppResult<Option<GraphBuildArtifactV1>> {
        let json: Option<String> = sqlx::query_scalar(
            "SELECT revision.artifact_json
             FROM knowledge_environment_heads head
             JOIN knowledge_graph_revisions revision
               ON revision.graph_revision_id = head.graph_revision_id
             WHERE head.source_id = ?1
               AND revision.source_id = head.source_id
               AND revision.project_environment_id = head.project_environment_id
               AND revision.environment_revision = head.environment_revision",
        )
        .bind(source_id.to_string())
        .fetch_optional(self.pool())
        .await?;
        json.map(parse_artifact).transpose()
    }

    pub(in crate::features::knowledge::adapters) async fn active_set(
        &self,
        project_environment_id: Uuid,
    ) -> AppResult<Vec<GraphBuildArtifactV1>> {
        let rows = sqlx::query_scalar::<_, String>(
            "SELECT revision.artifact_json
             FROM knowledge_environment_heads head
             JOIN knowledge_graph_revisions revision
               ON revision.graph_revision_id = head.graph_revision_id
             JOIN knowledge_sources source ON source.id = head.source_id
             WHERE head.project_environment_id = ?1
               AND source.revoked_at IS NULL
               AND revision.source_id = head.source_id
               AND revision.project_environment_id = head.project_environment_id
               AND revision.environment_revision = head.environment_revision
             ORDER BY head.source_id",
        )
        .bind(project_environment_id.to_string())
        .fetch_all(self.pool())
        .await?;
        rows.into_iter().map(parse_artifact).collect()
    }

    pub(in crate::features::knowledge::adapters) async fn by_revision(
        &self,
        graph_revision_id: Uuid,
    ) -> AppResult<Option<GraphBuildArtifactV1>> {
        let json: Option<String> = sqlx::query_scalar(
            "SELECT artifact_json FROM knowledge_graph_revisions
             WHERE graph_revision_id = ?1",
        )
        .bind(graph_revision_id.to_string())
        .fetch_optional(self.pool())
        .await?;
        let artifact = json.map(parse_artifact).transpose()?;
        if artifact
            .as_ref()
            .is_some_and(|artifact| artifact.graph_revision_id != graph_revision_id)
        {
            return Err(AppError::Config(
                "the stored Knowledge graph identity changed".into(),
            ));
        }
        Ok(artifact)
    }

    pub(in crate::features::knowledge::adapters) async fn diff(
        &self,
        from_graph_revision_id: Uuid,
        to_graph_revision_id: Uuid,
    ) -> AppResult<GraphRevisionDiffV1> {
        if from_graph_revision_id == to_graph_revision_id {
            return Err(AppError::Config(
                "Knowledge graph diff requires two distinct revisions".into(),
            ));
        }
        let from = self
            .by_revision(from_graph_revision_id)
            .await?
            .ok_or_else(|| AppError::NotFound("the earlier Knowledge graph revision".into()))?;
        let to = self
            .by_revision(to_graph_revision_id)
            .await?
            .ok_or_else(|| AppError::NotFound("the later Knowledge graph revision".into()))?;
        if from.binding.project_environment_id != to.binding.project_environment_id
            || from.binding.source_id != to.binding.source_id
        {
            return Err(AppError::Blocked {
                reason: "Knowledge graph diff cannot cross source or environment scope".into(),
            });
        }
        let from_nodes = from
            .nodes
            .iter()
            .map(|node| node.id.as_str())
            .collect::<std::collections::BTreeSet<_>>();
        let to_nodes = to
            .nodes
            .iter()
            .map(|node| node.id.as_str())
            .collect::<std::collections::BTreeSet<_>>();
        let from_edges = from
            .edges
            .iter()
            .map(|edge| edge.id.as_str())
            .collect::<std::collections::BTreeSet<_>>();
        let to_edges = to
            .edges
            .iter()
            .map(|edge| edge.id.as_str())
            .collect::<std::collections::BTreeSet<_>>();
        let diff = GraphRevisionDiffV1 {
            project_environment_id: to.binding.project_environment_id,
            from_graph_revision_id,
            to_graph_revision_id,
            added_node_ids: to_nodes
                .difference(&from_nodes)
                .map(|value| (*value).to_owned())
                .collect(),
            removed_node_ids: from_nodes
                .difference(&to_nodes)
                .map(|value| (*value).to_owned())
                .collect(),
            added_edge_ids: to_edges
                .difference(&from_edges)
                .map(|value| (*value).to_owned())
                .collect(),
            removed_edge_ids: from_edges
                .difference(&to_edges)
                .map(|value| (*value).to_owned())
                .collect(),
            changed_files: to.changed_files,
        };
        if !diff.validate() {
            return Err(AppError::Config(
                "the Knowledge graph diff failed integrity validation".into(),
            ));
        }
        Ok(diff)
    }
}
