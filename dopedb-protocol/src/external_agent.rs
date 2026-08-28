//! Secret-free project configuration and approval-bound external Agent sessions.

use std::collections::BTreeSet;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{AuthenticationRequirement, CommandName, CommandSpec, EmptyArguments};

pub const EXTERNAL_AGENT_CONFIG_SCHEMA_VERSION: u16 = 1;
pub const MAX_EXTERNAL_AGENT_SCOPES: usize = 16;
pub const MAX_EXTERNAL_AGENT_CONNECTIONS: usize = 32;
pub const MAX_EXTERNAL_AGENT_SOURCES: usize = 100;
pub const MAX_EXTERNAL_AGENT_WORKING_DIRECTORY_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExternalAgentProvider {
    Codex,
    Claude,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalAgentResourceScope {
    pub project_environment_id: Uuid,
    pub authority_connection_id: Uuid,
    #[serde(default)]
    pub connection_ids: Vec<Uuid>,
    #[serde(default)]
    pub source_ids: Vec<Uuid>,
}

impl ExternalAgentResourceScope {
    pub fn validate(&self) -> bool {
        !self.project_environment_id.is_nil()
            && !self.authority_connection_id.is_nil()
            && (!self.connection_ids.is_empty() || !self.source_ids.is_empty())
            && self.connection_ids.len() <= MAX_EXTERNAL_AGENT_CONNECTIONS
            && self.source_ids.len() <= MAX_EXTERNAL_AGENT_SOURCES
            && self
                .connection_ids
                .iter()
                .all(|connection_id| !connection_id.is_nil())
            && self.source_ids.iter().all(|source_id| !source_id.is_nil())
            && self.connection_ids.iter().collect::<BTreeSet<_>>().len()
                == self.connection_ids.len()
            && self.source_ids.iter().collect::<BTreeSet<_>>().len() == self.source_ids.len()
    }
}

/// Checked-in project configuration. It contains stable resource identities but
/// never a password, provider token, Broker capability, or connection URL.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalAgentConfig {
    pub schema_version: u16,
    pub provider: ExternalAgentProvider,
    pub project_id: Uuid,
    pub anchor_connection_id: Uuid,
    pub resource_scopes: Vec<ExternalAgentResourceScope>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub write_connection_id: Option<Uuid>,
}

impl ExternalAgentConfig {
    pub fn validate(&self) -> bool {
        if self.schema_version != EXTERNAL_AGENT_CONFIG_SCHEMA_VERSION
            || self.project_id.is_nil()
            || self.anchor_connection_id.is_nil()
            || self.resource_scopes.is_empty()
            || self.resource_scopes.len() > MAX_EXTERNAL_AGENT_SCOPES
            || self.resource_scopes.iter().any(|scope| !scope.validate())
        {
            return false;
        }

        let environment_ids = self
            .resource_scopes
            .iter()
            .map(|scope| scope.project_environment_id)
            .collect::<BTreeSet<_>>();
        let connection_ids = self
            .resource_scopes
            .iter()
            .flat_map(|scope| scope.connection_ids.iter().copied())
            .collect::<BTreeSet<_>>();
        let source_ids = self
            .resource_scopes
            .iter()
            .flat_map(|scope| scope.source_ids.iter().copied())
            .collect::<BTreeSet<_>>();
        let resource_count = self
            .resource_scopes
            .iter()
            .map(|scope| scope.connection_ids.len() + scope.source_ids.len())
            .sum::<usize>();
        let anchor_is_selected_or_authority = connection_ids.contains(&self.anchor_connection_id)
            || self
                .resource_scopes
                .iter()
                .any(|scope| scope.authority_connection_id == self.anchor_connection_id);

        environment_ids.len() == self.resource_scopes.len()
            && connection_ids.len() <= MAX_EXTERNAL_AGENT_CONNECTIONS
            && source_ids.len() <= MAX_EXTERNAL_AGENT_SOURCES
            && connection_ids.len() + source_ids.len() == resource_count
            && anchor_is_selected_or_authority
            && self
                .write_connection_id
                .is_none_or(|write_connection_id| connection_ids.contains(&write_connection_id))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalAgentConfigCreateArguments {
    pub provider: ExternalAgentProvider,
    pub working_directory: String,
}

impl ExternalAgentConfigCreateArguments {
    pub fn validate(&self) -> bool {
        valid_working_directory(&self.working_directory)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalAgentConfigCreateResult {
    pub config: ExternalAgentConfig,
}

pub struct ExternalAgentConfigCreateCommand;

impl CommandSpec for ExternalAgentConfigCreateCommand {
    type Arguments = ExternalAgentConfigCreateArguments;
    type Result = ExternalAgentConfigCreateResult;

    const NAME: CommandName = CommandName::ExternalAgentConfigCreate;
    const AUTHENTICATION: AuthenticationRequirement = AuthenticationRequirement::None;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalAgentSessionStartArguments {
    pub config: ExternalAgentConfig,
    pub working_directory: String,
}

impl ExternalAgentSessionStartArguments {
    pub fn validate(&self) -> bool {
        self.config.validate() && valid_working_directory(&self.working_directory)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalAgentSessionStartResult {
    pub terminal_session_id: Uuid,
    pub expires_at: DateTime<Utc>,
}

pub struct ExternalAgentSessionStartCommand;

impl CommandSpec for ExternalAgentSessionStartCommand {
    type Arguments = ExternalAgentSessionStartArguments;
    type Result = ExternalAgentSessionStartResult;

    const NAME: CommandName = CommandName::ExternalAgentSessionStart;
    const AUTHENTICATION: AuthenticationRequirement = AuthenticationRequirement::None;
}

pub struct ExternalAgentSessionRevokeCommand;

impl CommandSpec for ExternalAgentSessionRevokeCommand {
    type Arguments = EmptyArguments;
    type Result = EmptyArguments;

    const NAME: CommandName = CommandName::ExternalAgentSessionRevoke;
    const AUTHENTICATION: AuthenticationRequirement = AuthenticationRequirement::TerminalSession;
}

fn valid_working_directory(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_EXTERNAL_AGENT_WORKING_DIRECTORY_BYTES
        && !value.contains('\0')
}
