//! Immutable Project Knowledge storage and last-good activation.

use super::super::*;
use dopedb_protocol::{
    GraphBuildArtifactV1, GraphRevisionDiffV1, KnowledgeSourceBindingV1, KnowledgeSourceProvider,
    KnowledgeSourceVisibility,
};
use sha2::{Digest, Sha256};

use crate::features::agents::domain::AgentKnowledgeEnvironment;
use crate::features::knowledge::domain::{
    validate_environment_connection_label, EnvironmentConnectionBinding, EnvironmentRiskClass,
    KnowledgeGrant, KnowledgeMappingProposal, KnowledgeSessionConnection, KnowledgeSessionScope,
    MappingProposalState, Project, ProjectEnvironment, SourceSnapshot, StoredKnowledgeScope,
};
use crate::features::knowledge::ports::{
    KnowledgeGrantPort, KnowledgeGraphRepositoryPort, KnowledgeMappingRepositoryPort,
    KnowledgeScopeRepositoryPort,
};

const MAX_GRAPH_ARTIFACT_JSON_BYTES: usize = 256 * 1024 * 1024;

impl Store {
    pub(crate) async fn agent_knowledge_environments(
        &self,
        connection: &PinnedConnection,
    ) -> AppResult<Vec<AgentKnowledgeEnvironment>> {
        let rows: Vec<(String, String, String, String, i64)> = sqlx::query_as(
            "SELECT environment.id, project.name, environment.name,
                    environment.risk_class, COUNT(head.graph_revision_id)
             FROM knowledge_environment_connections binding
             JOIN knowledge_project_environments environment
               ON environment.id = binding.project_environment_id
              AND environment.revision = binding.environment_revision
             JOIN knowledge_projects project ON project.id = environment.project_id
             LEFT JOIN knowledge_environment_heads head
               ON head.project_environment_id = environment.id
              AND head.environment_revision = environment.revision
             WHERE binding.connection_id = ?1
               AND binding.connection_revision = ?2
               AND binding.revoked_at IS NULL
               AND project.workspace_id = ?3
             GROUP BY environment.id, project.name, environment.name,
                      environment.risk_class
             ORDER BY project.name, environment.name, environment.id",
        )
        .bind(connection.connection_id.to_string())
        .bind(connection.connection_revision)
        .bind(connection.scope.workspace_id.to_string())
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(
                |(id, project_name, name, risk_class, graph_revision_count)| {
                    Ok(AgentKnowledgeEnvironment {
                        id: parse_uuid(id)?,
                        project_name,
                        name,
                        risk_class: parse_risk_class(&risk_class)?,
                        graph_revision_count: u64::try_from(graph_revision_count).map_err(
                            |_| AppError::Config("the Knowledge graph count is invalid".into()),
                        )?,
                    })
                },
            )
            .collect()
    }

    pub(crate) async fn knowledge_session_scope(
        &self,
        connection: &PinnedConnection,
        requested_environment_id: Option<Uuid>,
    ) -> AppResult<Option<KnowledgeSessionScope>> {
        let environment_rows: Vec<(String, i64)> = sqlx::query_as(
            "SELECT DISTINCT environment.id, environment.revision
             FROM knowledge_environment_connections binding
             JOIN knowledge_project_environments environment
               ON environment.id = binding.project_environment_id
              AND environment.revision = binding.environment_revision
             JOIN knowledge_projects project ON project.id = environment.project_id
             WHERE binding.connection_id = ?1
               AND binding.connection_revision = ?2
               AND binding.revoked_at IS NULL
               AND project.workspace_id = ?3
               AND (?4 IS NULL OR environment.id = ?4)
             ORDER BY environment.id",
        )
        .bind(connection.connection_id.to_string())
        .bind(connection.connection_revision)
        .bind(connection.scope.workspace_id.to_string())
        .bind(requested_environment_id.map(|value| value.to_string()))
        .fetch_all(&self.pool)
        .await?;
        if environment_rows.is_empty() {
            if requested_environment_id.is_some() {
                return Err(AppError::Blocked {
                    reason: "the connection is not bound to that Project Environment revision"
                        .into(),
                });
            }
            return Ok(None);
        }
        if environment_rows.len() != 1 {
            return Err(AppError::Blocked {
                reason: "select one Project Environment before starting this Agent session".into(),
            });
        }
        let (environment_id, environment_revision) = &environment_rows[0];
        let project_environment_id = parse_uuid(environment_id.clone())?;
        let graphs = self.active_set(project_environment_id).await?;
        if graphs.is_empty() {
            return Ok(None);
        }
        let environment_revision = u64::try_from(*environment_revision).map_err(|_| {
            AppError::Config("the stored Project Environment revision is invalid".into())
        })?;
        if graphs
            .iter()
            .any(|graph| graph.environment_revision != environment_revision)
        {
            return Err(AppError::Blocked {
                reason: "the Project Environment Knowledge graph set is stale".into(),
            });
        }
        let bindings = self
            .environment_connections(connection.scope.workspace_id, project_environment_id)
            .await?;
        if bindings.len() > 32 {
            return Err(AppError::Blocked {
                reason: "the Project Environment has too many database bindings".into(),
            });
        }
        let mut connections = Vec::new();
        for binding in bindings {
            if binding.connection_revision != binding.current_connection_revision {
                return Err(AppError::Blocked {
                    reason: format!(
                        "the {} Environment database binding changed; reconfirm it before starting an Agent session",
                        binding.alias
                    ),
                });
            }
            let pinned = self.pin_connection_for_read(binding.connection_id).await?;
            if pinned.connection_revision != binding.connection_revision
                || pinned.scope.workspace_id != connection.scope.workspace_id
                || pinned.scope.account_scope.storage_key()
                    != connection.scope.account_scope.storage_key()
            {
                return Err(AppError::Blocked {
                    reason: "an Environment database is outside this member's exact grant".into(),
                });
            }
            connections.push(KnowledgeSessionConnection {
                connection_id: binding.connection_id,
                connection_revision: binding.connection_revision,
                role: binding.role,
                alias: binding.alias,
            });
        }
        connections.sort_by(|left, right| {
            (&left.role, &left.alias, left.connection_id).cmp(&(
                &right.role,
                &right.alias,
                right.connection_id,
            ))
        });
        if !connections
            .iter()
            .any(|value| value.connection_id == Uuid::from(connection.connection_id))
        {
            return Err(AppError::Blocked {
                reason: "the current connection is not in the selected Environment grant".into(),
            });
        }
        Ok(Some(KnowledgeSessionScope {
            project_environment_id,
            environment_revision,
            graph_revision_ids: graphs
                .into_iter()
                .map(|graph| graph.graph_revision_id)
                .collect(),
            connections,
        }))
    }

    pub(crate) async fn exact_knowledge_session_graphs(
        &self,
        scope: &KnowledgeSessionScope,
    ) -> AppResult<Vec<GraphBuildArtifactV1>> {
        let graphs = self.active_set(scope.project_environment_id).await?;
        let active_ids = graphs
            .iter()
            .map(|graph| graph.graph_revision_id)
            .collect::<Vec<_>>();
        if graphs.is_empty()
            || graphs
                .iter()
                .any(|graph| graph.environment_revision != scope.environment_revision)
            || active_ids != scope.graph_revision_ids
        {
            return Err(AppError::Blocked {
                reason: "the Agent Knowledge scope changed; start a new session to reconfirm it"
                    .into(),
            });
        }
        if scope.connections.is_empty()
            || scope.connections.len() > 32
            || scope.connections.iter().any(|connection| {
                connection.connection_revision <= 0
                    || !validate_environment_connection_label(&connection.role, 64)
                    || !validate_environment_connection_label(&connection.alias, 128)
            })
        {
            return Err(AppError::Blocked {
                reason: "the Agent Knowledge database scope is invalid".into(),
            });
        }
        for connection in &scope.connections {
            let active: bool = sqlx::query_scalar(
                "SELECT EXISTS(
                    SELECT 1
                    FROM knowledge_environment_connections binding
                    JOIN knowledge_project_environments environment
                      ON environment.id = binding.project_environment_id
                     AND environment.revision = binding.environment_revision
                    JOIN connections current ON current.id = binding.connection_id
                    WHERE binding.project_environment_id = ?1
                      AND binding.environment_revision = ?2
                      AND binding.connection_id = ?3
                      AND binding.connection_revision = ?4
                      AND binding.revoked_at IS NULL
                      AND current.revision = binding.connection_revision
                      AND current.deleted_at IS NULL
                )",
            )
            .bind(scope.project_environment_id.to_string())
            .bind(u64_to_i64(
                scope.environment_revision,
                "environment revision",
            )?)
            .bind(connection.connection_id.to_string())
            .bind(connection.connection_revision)
            .fetch_one(&self.pool)
            .await?;
            if !active {
                return Err(AppError::Blocked {
                    reason: "the Agent Environment connection scope changed; start a new session"
                        .into(),
                });
            }
        }
        Ok(graphs)
    }

    pub(crate) async fn bind_environment_connection(
        &self,
        binding_id: Uuid,
        connection: &PinnedConnection,
        project_environment_id: Uuid,
        role: &str,
        alias: &str,
    ) -> AppResult<EnvironmentConnectionBinding> {
        if connection.connection_revision <= 0
            || !validate_environment_connection_label(role, 64)
            || !validate_environment_connection_label(alias, 128)
        {
            return Err(AppError::Config(
                "the Environment connection binding is invalid".into(),
            ));
        }
        let environment: Option<(i64,)> = sqlx::query_as(
            "SELECT environment.revision
             FROM knowledge_project_environments environment
             JOIN knowledge_projects project ON project.id = environment.project_id
             WHERE environment.id = ?1 AND project.workspace_id = ?2",
        )
        .bind(project_environment_id.to_string())
        .bind(connection.scope.workspace_id.to_string())
        .fetch_optional(&self.pool)
        .await?;
        let Some((environment_revision,)) = environment else {
            return Err(AppError::NotFound(
                "the active workspace Project Environment".into(),
            ));
        };
        let now = Utc::now();
        sqlx::query(
            "INSERT INTO knowledge_environment_connections
                 (id, workspace_id, project_environment_id, environment_revision,
                  connection_id, connection_revision, role, alias, created_at, revoked_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL)
             ON CONFLICT(project_environment_id, connection_id) WHERE revoked_at IS NULL
             DO UPDATE SET environment_revision = excluded.environment_revision,
                           connection_revision = excluded.connection_revision,
                           role = excluded.role, alias = excluded.alias",
        )
        .bind(binding_id.to_string())
        .bind(connection.scope.workspace_id.to_string())
        .bind(project_environment_id.to_string())
        .bind(environment_revision)
        .bind(connection.connection_id.to_string())
        .bind(connection.connection_revision)
        .bind(role.trim())
        .bind(alias.trim())
        .bind(now)
        .execute(&self.pool)
        .await?;
        self.environment_connections(connection.scope.workspace_id, project_environment_id)
            .await?
            .into_iter()
            .find(|binding| binding.connection_id == Uuid::from(connection.connection_id))
            .ok_or_else(|| AppError::Config("the Environment connection binding was lost".into()))
    }

    pub(crate) async fn remote_connection_id(
        &self,
        connection: &PinnedConnection,
    ) -> AppResult<Option<Uuid>> {
        let remote_id: Option<String> = sqlx::query_scalar(
            "SELECT remote_id FROM connections
             WHERE id = ?1 AND workspace_id = ?2 AND revision = ?3
               AND deleted_at IS NULL",
        )
        .bind(connection.connection_id.to_string())
        .bind(connection.scope.workspace_id.to_string())
        .bind(connection.connection_revision)
        .fetch_optional(&self.pool)
        .await?
        .flatten();
        remote_id.map(parse_uuid).transpose()
    }

    pub(crate) async fn local_connection_id_for_remote(
        &self,
        workspace_id: Uuid,
        remote_connection_id: Uuid,
    ) -> AppResult<Option<Uuid>> {
        let id: Option<String> = sqlx::query_scalar(
            "SELECT id FROM connections
             WHERE workspace_id = ?1 AND remote_id = ?2 AND deleted_at IS NULL",
        )
        .bind(workspace_id.to_string())
        .bind(remote_connection_id.to_string())
        .fetch_optional(&self.pool)
        .await?;
        id.map(parse_uuid).transpose()
    }

    pub(crate) async fn environment_connections(
        &self,
        workspace_id: Uuid,
        project_environment_id: Uuid,
    ) -> AppResult<Vec<EnvironmentConnectionBinding>> {
        let rows: Vec<(
            String,
            String,
            String,
            i64,
            String,
            i64,
            i64,
            String,
            String,
            String,
        )> = sqlx::query_as(
            "SELECT binding.id, binding.workspace_id, binding.project_environment_id,
                        binding.environment_revision, binding.connection_id,
                        binding.connection_revision, connection.revision,
                        connection.name, binding.role, binding.alias
                 FROM knowledge_environment_connections binding
                 JOIN knowledge_project_environments environment
                   ON environment.id = binding.project_environment_id
                  AND environment.revision = binding.environment_revision
                 JOIN knowledge_projects project ON project.id = environment.project_id
                 JOIN connections connection ON connection.id = binding.connection_id
                 WHERE binding.workspace_id = ?1
                   AND binding.project_environment_id = ?2
                   AND binding.revoked_at IS NULL
                   AND project.workspace_id = binding.workspace_id
                   AND connection.workspace_id = binding.workspace_id
                   AND connection.deleted_at IS NULL
                 ORDER BY binding.role, binding.alias, binding.id",
        )
        .bind(workspace_id.to_string())
        .bind(project_environment_id.to_string())
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(
                |(
                    id,
                    workspace_id,
                    environment_id,
                    environment_revision,
                    connection_id,
                    connection_revision,
                    current_connection_revision,
                    connection_name,
                    role,
                    alias,
                )| {
                    Ok(EnvironmentConnectionBinding {
                        id: parse_uuid(id)?,
                        workspace_id: WorkspaceId::from(parse_uuid(workspace_id)?),
                        project_environment_id: parse_uuid(environment_id)?,
                        environment_revision: u64::try_from(environment_revision).map_err(
                            |_| {
                                AppError::Config(
                                    "the stored Environment revision is invalid".into(),
                                )
                            },
                        )?,
                        connection_id: parse_uuid(connection_id)?,
                        connection_revision,
                        current_connection_revision,
                        connection_name,
                        role,
                        alias,
                    })
                },
            )
            .collect()
    }

    pub(crate) async fn revoke_environment_connection(
        &self,
        workspace_id: Uuid,
        binding_id: Uuid,
    ) -> AppResult<()> {
        let changed = sqlx::query(
            "UPDATE knowledge_environment_connections
             SET revoked_at = ?1
             WHERE id = ?2 AND workspace_id = ?3 AND revoked_at IS NULL",
        )
        .bind(Utc::now())
        .bind(binding_id.to_string())
        .bind(workspace_id.to_string())
        .execute(&self.pool)
        .await?;
        if changed.rows_affected() != 1 {
            return Err(AppError::NotFound(
                "the Environment connection binding".into(),
            ));
        }
        Ok(())
    }
}

fn checked_name(value: &str) -> AppResult<&str> {
    let value = value.trim();
    if value.is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
        return Err(AppError::Config(
            "the Project Knowledge name is invalid".into(),
        ));
    }
    Ok(value)
}

fn provider_value(provider: KnowledgeSourceProvider) -> &'static str {
    match provider {
        KnowledgeSourceProvider::Github => "github",
        KnowledgeSourceProvider::LocalFolder => "local_folder",
    }
}

fn visibility_value(visibility: KnowledgeSourceVisibility) -> &'static str {
    match visibility {
        KnowledgeSourceVisibility::LocalOnly => "local_only",
        KnowledgeSourceVisibility::SharedGraph => "shared_graph",
    }
}

fn risk_class_value(risk_class: EnvironmentRiskClass) -> &'static str {
    match risk_class {
        EnvironmentRiskClass::Production => "production",
        EnvironmentRiskClass::Staging => "staging",
        EnvironmentRiskClass::Development => "development",
        EnvironmentRiskClass::Test => "test",
        EnvironmentRiskClass::Custom => "custom",
    }
}

fn parse_risk_class(value: &str) -> AppResult<EnvironmentRiskClass> {
    match value {
        "production" => Ok(EnvironmentRiskClass::Production),
        "staging" => Ok(EnvironmentRiskClass::Staging),
        "development" => Ok(EnvironmentRiskClass::Development),
        "test" => Ok(EnvironmentRiskClass::Test),
        "custom" => Ok(EnvironmentRiskClass::Custom),
        _ => Err(AppError::Config(
            "the stored Project Environment risk class is invalid".into(),
        )),
    }
}

fn mapping_state_value(state: MappingProposalState) -> &'static str {
    match state {
        MappingProposalState::Proposed => "proposed",
        MappingProposalState::Approved => "approved",
        MappingProposalState::Rejected => "rejected",
        MappingProposalState::Stale => "stale",
    }
}

fn parse_mapping_state(value: &str) -> AppResult<MappingProposalState> {
    match value {
        "proposed" => Ok(MappingProposalState::Proposed),
        "approved" => Ok(MappingProposalState::Approved),
        "rejected" => Ok(MappingProposalState::Rejected),
        "stale" => Ok(MappingProposalState::Stale),
        _ => Err(AppError::Config(
            "the stored Knowledge mapping state is invalid".into(),
        )),
    }
}

fn u64_to_i64(value: u64, field: &str) -> AppResult<i64> {
    i64::try_from(value).map_err(|_| AppError::Config(format!("{field} is too large")))
}

fn artifact_json(artifact: &GraphBuildArtifactV1) -> AppResult<(String, String)> {
    if !artifact.validate() {
        return Err(AppError::Blocked {
            reason: "an unhealthy Knowledge graph candidate cannot be staged".into(),
        });
    }
    let json = serde_json::to_string(artifact)?;
    if json.len() > MAX_GRAPH_ARTIFACT_JSON_BYTES {
        return Err(AppError::Config(
            "the Knowledge graph candidate exceeds the local storage limit".into(),
        ));
    }
    let sha256 = hex::encode(Sha256::digest(json.as_bytes()));
    Ok((json, sha256))
}

fn parse_artifact(json: String) -> AppResult<GraphBuildArtifactV1> {
    if json.len() > MAX_GRAPH_ARTIFACT_JSON_BYTES {
        return Err(AppError::Config(
            "the stored Knowledge graph exceeds the local storage limit".into(),
        ));
    }
    let artifact: GraphBuildArtifactV1 = serde_json::from_str(&json)?;
    if !artifact.validate() {
        return Err(AppError::Config(
            "the stored Knowledge graph failed integrity validation".into(),
        ));
    }
    Ok(artifact)
}

impl KnowledgeScopeRepositoryPort for Store {
    async fn save_scope(
        &self,
        project: &Project,
        environment: &ProjectEnvironment,
        binding: &KnowledgeSourceBindingV1,
        environment_revision: u64,
    ) -> AppResult<()> {
        if project.revision == 0
            || environment.revision == 0
            || environment.project_id != project.id
            || binding.project_id != project.id
            || binding.project_environment_id != environment.id
            || environment_revision != environment.revision
            || !binding.validate()
        {
            return Err(AppError::Blocked {
                reason: "the Project Knowledge scope is invalid or stale".into(),
            });
        }
        let project_name = checked_name(&project.name)?;
        let environment_name = checked_name(&environment.name)?;
        let binding_json = serde_json::to_string(binding)?;
        if binding_json.len() > 65_536 {
            return Err(AppError::Config(
                "the Knowledge source binding is too large".into(),
            ));
        }
        let project_revision = u64_to_i64(project.revision, "project revision")?;
        let environment_revision = u64_to_i64(environment_revision, "environment revision")?;
        let now = Utc::now();
        let mut tx = self.pool.begin().await?;

        sqlx::query(
            "INSERT INTO knowledge_projects
                 (id, workspace_id, name, revision, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)
             ON CONFLICT(id) DO UPDATE SET
                 name = excluded.name,
                 revision = excluded.revision,
                 updated_at = excluded.updated_at
             WHERE knowledge_projects.workspace_id = excluded.workspace_id
               AND knowledge_projects.revision <= excluded.revision",
        )
        .bind(project.id.to_string())
        .bind(project.workspace_id.to_string())
        .bind(project_name)
        .bind(project_revision)
        .bind(now)
        .execute(&mut *tx)
        .await?;
        let stored_workspace: Option<String> =
            sqlx::query_scalar("SELECT workspace_id FROM knowledge_projects WHERE id = ?1")
                .bind(project.id.to_string())
                .fetch_optional(&mut *tx)
                .await?;
        if stored_workspace.as_deref() != Some(&project.workspace_id.to_string()) {
            return Err(AppError::Blocked {
                reason: "the Project identity belongs to another workspace".into(),
            });
        }

        sqlx::query(
            "INSERT INTO knowledge_project_environments
                 (id, project_id, name, production, risk_class, revision, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
             ON CONFLICT(id) DO UPDATE SET
                 name = excluded.name,
                 production = excluded.production,
                 risk_class = excluded.risk_class,
                 revision = excluded.revision,
                 updated_at = excluded.updated_at
             WHERE knowledge_project_environments.project_id = excluded.project_id
               AND knowledge_project_environments.revision <= excluded.revision",
        )
        .bind(environment.id.to_string())
        .bind(project.id.to_string())
        .bind(environment_name)
        .bind(environment.risk_class == EnvironmentRiskClass::Production)
        .bind(risk_class_value(environment.risk_class))
        .bind(environment_revision)
        .bind(now)
        .execute(&mut *tx)
        .await?;
        let stored_project: Option<String> = sqlx::query_scalar(
            "SELECT project_id FROM knowledge_project_environments WHERE id = ?1",
        )
        .bind(environment.id.to_string())
        .fetch_optional(&mut *tx)
        .await?;
        if stored_project.as_deref() != Some(&project.id.to_string()) {
            return Err(AppError::Blocked {
                reason: "the Project Environment identity belongs to another Project".into(),
            });
        }

        sqlx::query(
            "INSERT INTO knowledge_sources
                 (id, project_id, project_environment_id, environment_revision,
                  provider, display_name, visibility, binding_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
             ON CONFLICT(id) DO UPDATE SET
                 environment_revision = excluded.environment_revision,
                 display_name = excluded.display_name,
                 visibility = excluded.visibility,
                 binding_json = excluded.binding_json,
                 updated_at = excluded.updated_at
             WHERE knowledge_sources.project_id = excluded.project_id
               AND knowledge_sources.project_environment_id = excluded.project_environment_id
               AND knowledge_sources.provider = excluded.provider
               AND knowledge_sources.environment_revision <= excluded.environment_revision",
        )
        .bind(binding.source_id.to_string())
        .bind(project.id.to_string())
        .bind(environment.id.to_string())
        .bind(environment_revision)
        .bind(provider_value(binding.provider))
        .bind(&binding.display_name)
        .bind(visibility_value(binding.visibility))
        .bind(binding_json)
        .bind(now)
        .execute(&mut *tx)
        .await?;
        let stored_identity: Option<(String, String, String)> = sqlx::query_as(
            "SELECT project_id, project_environment_id, provider
             FROM knowledge_sources WHERE id = ?1",
        )
        .bind(binding.source_id.to_string())
        .fetch_optional(&mut *tx)
        .await?;
        if stored_identity
            != Some((
                project.id.to_string(),
                environment.id.to_string(),
                provider_value(binding.provider).to_owned(),
            ))
        {
            return Err(AppError::Blocked {
                reason: "the Knowledge source identity changed".into(),
            });
        }
        tx.commit().await?;
        Ok(())
    }

    async fn scopes(&self, workspace_id: Uuid) -> AppResult<Vec<StoredKnowledgeScope>> {
        let rows: Vec<(
            String,
            String,
            i64,
            String,
            String,
            String,
            i64,
            i64,
            String,
        )> = sqlx::query_as(
            "SELECT project.id, project.name, project.revision,
                    environment.id, environment.name, environment.risk_class,
                    environment.revision, source.environment_revision,
                    source.binding_json
             FROM knowledge_sources source
             JOIN knowledge_projects project ON project.id = source.project_id
             JOIN knowledge_project_environments environment
               ON environment.id = source.project_environment_id
              AND environment.project_id = project.id
             WHERE project.workspace_id = ?1 AND source.revoked_at IS NULL
             ORDER BY project.name, environment.name, source.display_name",
        )
        .bind(workspace_id.to_string())
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(
                |(
                    project_id,
                    project_name,
                    project_revision,
                    environment_id,
                    environment_name,
                    risk_class,
                    environment_revision,
                    source_environment_revision,
                    binding_json,
                )| {
                    if environment_revision != source_environment_revision {
                        return Err(AppError::Config(
                            "the stored Knowledge source is stale".into(),
                        ));
                    }
                    let project_id = parse_uuid(project_id)?;
                    let environment_id = parse_uuid(environment_id)?;
                    let binding: KnowledgeSourceBindingV1 = serde_json::from_str(&binding_json)?;
                    if !binding.validate()
                        || binding.project_id != project_id
                        || binding.project_environment_id != environment_id
                    {
                        return Err(AppError::Config(
                            "the stored Knowledge source failed integrity validation".into(),
                        ));
                    }
                    Ok(StoredKnowledgeScope {
                        project: Project {
                            id: project_id,
                            workspace_id: WorkspaceId::from(workspace_id),
                            name: project_name,
                            revision: u64::try_from(project_revision).map_err(|_| {
                                AppError::Config("the stored Project revision is invalid".into())
                            })?,
                        },
                        environment: ProjectEnvironment {
                            id: environment_id,
                            project_id,
                            name: environment_name,
                            risk_class: parse_risk_class(&risk_class)?,
                            revision: u64::try_from(environment_revision).map_err(|_| {
                                AppError::Config(
                                    "the stored Environment revision is invalid".into(),
                                )
                            })?,
                        },
                        binding,
                    })
                },
            )
            .collect()
    }

    async fn remove_scope(&self, source_id: Uuid) -> AppResult<()> {
        let updated = sqlx::query(
            "UPDATE knowledge_sources
             SET revoked_at = ?1, snapshot_json = NULL,
                 source_revision_sha256 = NULL, updated_at = ?1
             WHERE id = ?2 AND revoked_at IS NULL",
        )
        .bind(Utc::now())
        .bind(source_id.to_string())
        .execute(&self.pool)
        .await?;
        if updated.rows_affected() != 1 {
            return Err(AppError::NotFound("the Project Knowledge source".into()));
        }
        Ok(())
    }

    async fn save_snapshot(&self, snapshot: &SourceSnapshot) -> AppResult<()> {
        if !snapshot.binding.validate()
            || snapshot.environment_revision == 0
            || snapshot.source_revision_sha256.len() != 64
            || snapshot.files.len() > 100_000
        {
            return Err(AppError::Blocked {
                reason: "the Knowledge source manifest is invalid".into(),
            });
        }
        let json = serde_json::to_string(snapshot)?;
        if json.len() > 64 * 1024 * 1024 {
            return Err(AppError::Config(
                "the Knowledge source manifest exceeds the local storage limit".into(),
            ));
        }
        let updated = sqlx::query(
            "UPDATE knowledge_sources
             SET source_revision_sha256 = ?1, snapshot_json = ?2, updated_at = ?3
             WHERE id = ?4
               AND project_environment_id = ?5
               AND environment_revision = ?6",
        )
        .bind(&snapshot.source_revision_sha256)
        .bind(json)
        .bind(Utc::now())
        .bind(snapshot.binding.source_id.to_string())
        .bind(snapshot.binding.project_environment_id.to_string())
        .bind(u64_to_i64(
            snapshot.environment_revision,
            "environment revision",
        )?)
        .execute(&self.pool)
        .await?;
        if updated.rows_affected() != 1 {
            return Err(AppError::Blocked {
                reason: "the Knowledge source scope changed before its manifest was saved".into(),
            });
        }
        Ok(())
    }

    async fn source_snapshot(&self, source_id: Uuid) -> AppResult<Option<SourceSnapshot>> {
        let value: Option<String> =
            sqlx::query_scalar("SELECT snapshot_json FROM knowledge_sources WHERE id = ?1")
                .bind(source_id.to_string())
                .fetch_optional(&self.pool)
                .await?
                .flatten();
        let Some(value) = value else { return Ok(None) };
        if value.len() > 64 * 1024 * 1024 {
            return Err(AppError::Config(
                "the stored Knowledge source manifest exceeds the limit".into(),
            ));
        }
        let snapshot: SourceSnapshot = serde_json::from_str(&value)?;
        if !snapshot.binding.validate()
            || snapshot.binding.source_id != source_id
            || snapshot.source_revision_sha256.len() != 64
            || snapshot.files.len() > 100_000
        {
            return Err(AppError::Config(
                "the stored Knowledge source manifest failed integrity validation".into(),
            ));
        }
        Ok(Some(snapshot))
    }
}

impl KnowledgeGraphRepositoryPort for Store {
    async fn stage(&self, artifact: &GraphBuildArtifactV1) -> AppResult<()> {
        let (json, sha256) = artifact_json(artifact)?;
        let environment_revision =
            u64_to_i64(artifact.environment_revision, "environment revision")?;
        let stored_scope: Option<(String, String, i64)> = sqlx::query_as(
            "SELECT project_id, project_environment_id, environment_revision
             FROM knowledge_sources WHERE id = ?1",
        )
        .bind(artifact.binding.source_id.to_string())
        .fetch_optional(&self.pool)
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
        .execute(&self.pool)
        .await?;
        let stored: Option<(String, String)> = sqlx::query_as(
            "SELECT artifact_sha256, artifact_json
             FROM knowledge_graph_revisions WHERE graph_revision_id = ?1",
        )
        .bind(artifact.graph_revision_id.to_string())
        .fetch_optional(&self.pool)
        .await?;
        if stored != Some((sha256, json)) {
            return Err(AppError::Blocked {
                reason: "a Knowledge graph revision ID was reused with different content".into(),
            });
        }
        Ok(())
    }

    async fn activate(&self, artifact: &GraphBuildArtifactV1) -> AppResult<()> {
        let (json, sha256) = artifact_json(artifact)?;
        let environment_revision =
            u64_to_i64(artifact.environment_revision, "environment revision")?;
        let environment_id = artifact.binding.project_environment_id.to_string();
        let mut tx = self.pool.begin().await?;
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

    async fn active_for_source(&self, source_id: Uuid) -> AppResult<Option<GraphBuildArtifactV1>> {
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
        .fetch_optional(&self.pool)
        .await?;
        json.map(parse_artifact).transpose()
    }

    async fn active_set(
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
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(parse_artifact).collect()
    }

    async fn by_revision(
        &self,
        graph_revision_id: Uuid,
    ) -> AppResult<Option<GraphBuildArtifactV1>> {
        let json: Option<String> = sqlx::query_scalar(
            "SELECT artifact_json FROM knowledge_graph_revisions
             WHERE graph_revision_id = ?1",
        )
        .bind(graph_revision_id.to_string())
        .fetch_optional(&self.pool)
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

    async fn diff(
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

impl KnowledgeGrantPort for Store {
    async fn save_grant(&self, grant: &KnowledgeGrant) -> AppResult<()> {
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
        let mut tx = self.pool.begin().await?;
        for graph_revision_id in &grant.graph_revision_ids {
            let authorized: bool = sqlx::query_scalar(
                "SELECT EXISTS(
                 SELECT 1
                 FROM knowledge_projects project
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
                  AND source.revoked_at IS NULL
                 JOIN workspace_members member
                   ON member.workspace_id = project.workspace_id
                  AND member.user_id = ?2
                  AND member.status = 'active'
                 WHERE project.id = ?3 AND project.workspace_id = ?1
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

    async fn exact_grant(&self, grant_id: Uuid) -> AppResult<Option<KnowledgeGrant>> {
        let row: Option<(String, String, String, String, i64, DateTime<Utc>)> = sqlx::query_as(
            "SELECT grant.workspace_id, grant.account_user_id, grant.project_id,
                        grant.project_environment_id, grant.environment_revision,
                        grant.expires_at
                 FROM knowledge_grants grant
                 JOIN knowledge_projects project
                   ON project.id = grant.project_id
                  AND project.workspace_id = grant.workspace_id
                 JOIN knowledge_project_environments environment
                   ON environment.id = grant.project_environment_id
                  AND environment.project_id = project.id
                  AND environment.revision = grant.environment_revision
                 JOIN workspace_members member
                   ON member.workspace_id = grant.workspace_id
                  AND member.user_id = grant.account_user_id
                  AND member.status = 'active'
                 WHERE grant.id = ?1 AND grant.expires_at > ?2",
        )
        .bind(grant_id.to_string())
        .bind(Utc::now())
        .fetch_optional(&self.pool)
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
               ON source.id = revision.source_id AND source.revoked_at IS NULL
             WHERE grant_revision.grant_id = ?1
               AND revision.project_environment_id = ?2
               AND revision.environment_revision = ?3
             ORDER BY revision.source_id",
        )
        .bind(grant_id.to_string())
        .bind(&project_environment_id)
        .bind(environment_revision)
        .fetch_all(&self.pool)
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

    async fn revoke_grant(&self, grant_id: Uuid) -> AppResult<()> {
        sqlx::query("DELETE FROM knowledge_grants WHERE id = ?1")
            .bind(grant_id.to_string())
            .execute(&self.pool)
            .await?;
        Ok(())
    }
}

impl KnowledgeMappingRepositoryPort for Store {
    async fn propose_mapping(&self, proposal: &KnowledgeMappingProposal) -> AppResult<()> {
        if proposal.state != MappingProposalState::Proposed
            || proposal.schema_fingerprint.len() != 64
            || proposal.from_node_id.len() != 64
            || proposal.target_kind.trim().is_empty()
            || proposal.target_kind.len() > 128
            || proposal.target_identity.trim().is_empty()
            || proposal.target_identity.len() > 2_048
            || proposal
                .target_identity
                .chars()
                .any(|character| character.is_control())
        {
            return Err(AppError::Config(
                "the Knowledge mapping proposal is invalid".into(),
            ));
        }
        let belongs: bool = sqlx::query_scalar(
            "SELECT EXISTS(
                 SELECT 1 FROM knowledge_graph_revisions graph
                 WHERE graph.graph_revision_id = ?1
                   AND graph.project_environment_id = ?2
                   AND EXISTS (
                     SELECT 1 FROM knowledge_environment_heads head
                     WHERE head.project_environment_id = graph.project_environment_id
                       AND head.graph_revision_id = graph.graph_revision_id
                   )
             )",
        )
        .bind(proposal.graph_revision_id.to_string())
        .bind(proposal.project_environment_id.to_string())
        .fetch_one(&self.pool)
        .await?;
        if !belongs {
            return Err(AppError::Blocked {
                reason: "a mapping can only be proposed against the active Knowledge graph".into(),
            });
        }
        sqlx::query(
            "INSERT INTO knowledge_mapping_proposals
                 (id, project_environment_id, graph_revision_id, schema_fingerprint,
                  from_node_id, target_kind, target_identity, state, proposed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'proposed', ?8)",
        )
        .bind(proposal.id.to_string())
        .bind(proposal.project_environment_id.to_string())
        .bind(proposal.graph_revision_id.to_string())
        .bind(&proposal.schema_fingerprint)
        .bind(&proposal.from_node_id)
        .bind(&proposal.target_kind)
        .bind(&proposal.target_identity)
        .bind(proposal.proposed_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn decide_mapping(
        &self,
        proposal_id: Uuid,
        expected_graph_revision_id: Uuid,
        state: MappingProposalState,
    ) -> AppResult<()> {
        if !matches!(
            state,
            MappingProposalState::Approved | MappingProposalState::Rejected
        ) {
            return Err(AppError::Config(
                "a mapping review must approve or reject".into(),
            ));
        }
        let updated = sqlx::query(
            "UPDATE knowledge_mapping_proposals AS proposal
             SET state = ?3, decided_at = ?4
             WHERE proposal.id = ?1 AND proposal.graph_revision_id = ?2
               AND proposal.state = 'proposed'
               AND EXISTS (
                 SELECT 1 FROM knowledge_environment_heads head
                 WHERE head.project_environment_id = proposal.project_environment_id
                   AND head.graph_revision_id = proposal.graph_revision_id
               )",
        )
        .bind(proposal_id.to_string())
        .bind(expected_graph_revision_id.to_string())
        .bind(mapping_state_value(state))
        .bind(Utc::now())
        .execute(&self.pool)
        .await?;
        if updated.rows_affected() != 1 {
            return Err(AppError::Blocked {
                reason: "the Knowledge mapping proposal is stale or already decided".into(),
            });
        }
        Ok(())
    }

    async fn mappings_for_revision(
        &self,
        project_environment_id: Uuid,
        graph_revision_id: Uuid,
    ) -> AppResult<Vec<KnowledgeMappingProposal>> {
        let rows: Vec<(
            String,
            String,
            String,
            String,
            String,
            String,
            DateTime<Utc>,
        )> = sqlx::query_as(
            "SELECT id, schema_fingerprint, from_node_id, target_kind,
                        target_identity, state, proposed_at
                 FROM knowledge_mapping_proposals
                 WHERE project_environment_id = ?1 AND graph_revision_id = ?2
                 ORDER BY proposed_at, id",
        )
        .bind(project_environment_id.to_string())
        .bind(graph_revision_id.to_string())
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(
                |(
                    id,
                    schema_fingerprint,
                    from_node_id,
                    target_kind,
                    target_identity,
                    state,
                    proposed_at,
                )| {
                    Ok(KnowledgeMappingProposal {
                        id: parse_uuid(id)?,
                        project_environment_id,
                        graph_revision_id,
                        schema_fingerprint,
                        from_node_id,
                        target_kind,
                        target_identity,
                        state: parse_mapping_state(&state)?,
                        proposed_at,
                    })
                },
            )
            .collect()
    }
}
