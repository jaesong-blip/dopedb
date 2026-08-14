//! Exact Knowledge grant persistence and lookup.

use chrono::{DateTime, Utc};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::features::knowledge::domain::KnowledgeGrant;
use crate::kernel::identity::{AccountId, WorkspaceId};
use crate::store::{parse_uuid, Store};

use super::codec::u64_to_i64;

impl Store {
    pub(in crate::features::knowledge::adapters) async fn active_knowledge_grant(
        &self,
        workspace_id: Uuid,
        account_id: &str,
        project_environment_id: Uuid,
        environment_revision: u64,
        graph_revision_ids: &[Uuid],
    ) -> AppResult<Option<Uuid>> {
        let candidates: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM knowledge_grants
             WHERE workspace_id = ?1 AND account_user_id = ?2
               AND project_environment_id = ?3 AND environment_revision = ?4
               AND expires_at > ?5
             ORDER BY expires_at DESC, id",
        )
        .bind(workspace_id.to_string())
        .bind(account_id)
        .bind(project_environment_id.to_string())
        .bind(u64_to_i64(environment_revision, "environment revision")?)
        .bind(Utc::now())
        .fetch_all(self.pool())
        .await?;
        for candidate in candidates {
            let id = parse_uuid(candidate)?;
            if self
                .exact_grant(id)
                .await?
                .is_some_and(|grant| grant.graph_revision_ids == graph_revision_ids)
            {
                return Ok(Some(id));
            }
        }
        Ok(None)
    }

    pub(in crate::features::knowledge::adapters) async fn revoke_knowledge_grants_for_account(
        &self,
        workspace_id: Uuid,
        account_id: &str,
    ) -> AppResult<()> {
        sqlx::query(
            "DELETE FROM knowledge_grants
             WHERE workspace_id = ?1 AND account_user_id = ?2",
        )
        .bind(workspace_id.to_string())
        .bind(account_id)
        .execute(self.pool())
        .await?;
        Ok(())
    }
}

impl Store {
    pub(in crate::features::knowledge::adapters) async fn save_grant(
        &self,
        grant: &KnowledgeGrant,
    ) -> AppResult<()> {
        let now = Utc::now();
        if grant.environment_revision == 0
            || grant.graph_revision_ids.is_empty()
            || grant.graph_revision_ids.len() > 100
            || grant
                .graph_revision_ids
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != grant.graph_revision_ids.len()
            || grant.expires_at <= now
            || grant.expires_at > now + chrono::Duration::hours(24)
        {
            return Err(AppError::Blocked {
                reason: "the Knowledge grant lifetime is invalid".into(),
            });
        }
        let environment_revision = u64_to_i64(grant.environment_revision, "environment revision")?;
        let mut tx = self.pool().begin().await?;
        for graph_revision_id in &grant.graph_revision_ids {
            let authorized: bool = sqlx::query_scalar(
                "SELECT EXISTS(
                 SELECT 1
                 FROM knowledge_projects project
                 JOIN workspaces workspace
                   ON workspace.id = project.workspace_id
                  AND workspace.lifecycle_state = 'active'
                 JOIN knowledge_project_environments environment
                   ON environment.project_id = project.id
                  AND environment.id = ?4
                  AND environment.revision = ?5
                 JOIN knowledge_graph_revisions graph
                   ON graph.project_environment_id = environment.id
                  AND graph.graph_revision_id = ?6
                  AND graph.environment_revision = environment.revision
                 JOIN knowledge_environment_heads head
                   ON head.project_environment_id = environment.id
                  AND head.graph_revision_id = graph.graph_revision_id
                  AND head.source_id = graph.source_id
                 JOIN knowledge_sources source
                   ON source.id = graph.source_id
                  AND source.provider = 'github'
                  AND source.revoked_at IS NULL
                 WHERE project.id = ?3 AND project.workspace_id = ?1
                   AND (
                     (workspace.kind = 'team' AND EXISTS(
                       SELECT 1 FROM workspace_members member
                       WHERE member.workspace_id = project.workspace_id
                         AND member.user_id = ?2
                         AND member.status = 'active'
                     ))
                     OR (workspace.kind = 'personal' AND EXISTS(
                       SELECT 1 FROM workspace_accounts account
                       WHERE account.user_id = ?2
                     ))
                   )
             )",
            )
            .bind(grant.workspace_id.to_string())
            .bind(grant.account_id.as_str())
            .bind(grant.project_id.to_string())
            .bind(grant.project_environment_id.to_string())
            .bind(environment_revision)
            .bind(graph_revision_id.to_string())
            .fetch_one(&mut *tx)
            .await?;
            if !authorized {
                return Err(AppError::Blocked {
                    reason: "the Knowledge grant is outside the member's exact workspace scope"
                        .into(),
                });
            }
        }
        sqlx::query(
            "INSERT INTO knowledge_grants
                 (id, workspace_id, account_user_id, project_id,
                  project_environment_id, environment_revision,
                  graph_revision_id, expires_at, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        )
        .bind(grant.id.to_string())
        .bind(grant.workspace_id.to_string())
        .bind(grant.account_id.as_str())
        .bind(grant.project_id.to_string())
        .bind(grant.project_environment_id.to_string())
        .bind(environment_revision)
        .bind(grant.graph_revision_ids[0].to_string())
        .bind(grant.expires_at)
        .bind(now)
        .execute(&mut *tx)
        .await?;
        for graph_revision_id in &grant.graph_revision_ids {
            sqlx::query(
                "INSERT INTO knowledge_grant_graph_revisions (grant_id, graph_revision_id)
                 VALUES (?1, ?2)",
            )
            .bind(grant.id.to_string())
            .bind(graph_revision_id.to_string())
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub(in crate::features::knowledge::adapters) async fn exact_grant(
        &self,
        grant_id: Uuid,
    ) -> AppResult<Option<KnowledgeGrant>> {
        let row: Option<(String, String, String, String, i64, DateTime<Utc>)> = sqlx::query_as(
            "SELECT grant.workspace_id, grant.account_user_id, grant.project_id,
                        grant.project_environment_id, grant.environment_revision,
                        grant.expires_at
                 FROM knowledge_grants grant
                 JOIN knowledge_projects project
                   ON project.id = grant.project_id
                  AND project.workspace_id = grant.workspace_id
                 JOIN workspaces workspace
                   ON workspace.id = grant.workspace_id
                  AND workspace.lifecycle_state = 'active'
                 JOIN knowledge_project_environments environment
                   ON environment.id = grant.project_environment_id
                  AND environment.project_id = project.id
                  AND environment.revision = grant.environment_revision
                 WHERE grant.id = ?1 AND grant.expires_at > ?2
                   AND (
                     (workspace.kind = 'team' AND EXISTS(
                       SELECT 1 FROM workspace_members member
                       WHERE member.workspace_id = grant.workspace_id
                         AND member.user_id = grant.account_user_id
                         AND member.status = 'active'
                     ))
                     OR (workspace.kind = 'personal' AND EXISTS(
                       SELECT 1 FROM workspace_accounts account
                       WHERE account.user_id = grant.account_user_id
                     ))
                   )",
        )
        .bind(grant_id.to_string())
        .bind(Utc::now())
        .fetch_optional(self.pool())
        .await?;
        let Some((
            workspace_id,
            account_id,
            project_id,
            project_environment_id,
            environment_revision,
            expires_at,
        )) = row
        else {
            return Ok(None);
        };
        let graph_revision_rows: Vec<String> = sqlx::query_scalar(
            "SELECT revision.graph_revision_id
             FROM knowledge_grant_graph_revisions grant_revision
             JOIN knowledge_graph_revisions revision
               ON revision.graph_revision_id = grant_revision.graph_revision_id
             JOIN knowledge_environment_heads head
               ON head.graph_revision_id = revision.graph_revision_id
              AND head.source_id = revision.source_id
              AND head.project_environment_id = revision.project_environment_id
             JOIN knowledge_sources source
               ON source.id = revision.source_id
              AND source.provider = 'github'
              AND source.revoked_at IS NULL
             WHERE grant_revision.grant_id = ?1
               AND revision.project_environment_id = ?2
               AND revision.environment_revision = ?3
             ORDER BY revision.source_id",
        )
        .bind(grant_id.to_string())
        .bind(&project_environment_id)
        .bind(environment_revision)
        .fetch_all(self.pool())
        .await?;
        if graph_revision_rows.is_empty() {
            return Ok(None);
        }
        Ok(Some(KnowledgeGrant {
            id: grant_id,
            workspace_id: WorkspaceId::from(parse_uuid(workspace_id)?),
            account_id: AccountId::new(account_id).ok_or_else(|| {
                AppError::Config("the stored Knowledge grant account is invalid".into())
            })?,
            project_id: parse_uuid(project_id)?,
            project_environment_id: parse_uuid(project_environment_id)?,
            environment_revision: u64::try_from(environment_revision).map_err(|_| {
                AppError::Config("the stored Knowledge grant revision is invalid".into())
            })?,
            graph_revision_ids: graph_revision_rows
                .into_iter()
                .map(parse_uuid)
                .collect::<AppResult<Vec<_>>>()?,
            expires_at,
        }))
    }
}
