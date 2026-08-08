//! Typed command payloads shared by the Desktop broker and CLI.
//!
//! The outer envelope intentionally carries a JSON value for protocol evolution,
//! but an active dispatcher must decode through one of these closed command specs
//! before it can reach an application service.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::{AcpPluginId, CommandName, RequestEnvelope};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthenticationRequirement {
    None,
    TerminalSession,
}

pub trait CommandSpec {
    type Arguments: Serialize + DeserializeOwned;
    type Result: Serialize + DeserializeOwned;

    const NAME: CommandName;
    const AUTHENTICATION: AuthenticationRequirement;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum CommandPayloadError {
    #[error("request command does not match the typed command payload")]
    CommandMismatch,
    #[error("request arguments do not match the typed command payload")]
    InvalidArguments,
}

pub fn decode_arguments<C: CommandSpec>(
    request: &RequestEnvelope,
) -> Result<C::Arguments, CommandPayloadError> {
    if request.command != C::NAME {
        return Err(CommandPayloadError::CommandMismatch);
    }
    serde_json::from_value(request.arguments.clone())
        .map_err(|_| CommandPayloadError::InvalidArguments)
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmptyArguments {}

pub struct VersionCommand;

impl CommandSpec for VersionCommand {
    type Arguments = EmptyArguments;
    type Result = VersionResult;

    const NAME: CommandName = CommandName::Version;
    const AUTHENTICATION: AuthenticationRequirement = AuthenticationRequirement::None;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VersionResult {
    pub app_version: String,
    pub protocol_min: u16,
    pub protocol_max: u16,
    pub command_schema_version: u16,
    pub runtime_id: Uuid,
}

pub struct StatusCommand;

impl CommandSpec for StatusCommand {
    type Arguments = EmptyArguments;
    type Result = StatusResult;

    const NAME: CommandName = CommandName::Status;
    const AUTHENTICATION: AuthenticationRequirement = AuthenticationRequirement::None;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StatusResult {
    pub app_version: String,
    pub protocol_min: u16,
    pub protocol_max: u16,
    pub runtime_id: Uuid,
}

pub struct AppOpenCommand;

/// Bind the token-bearing ACP launcher process to its in-memory Broker session.
/// This command is intentionally absent from the public CLI surface.
pub struct AgentSessionRegisterCommand;

pub const MAX_AGENT_LAUNCHER_PATH_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSessionRegisterArguments {
    pub plugin_id: AcpPluginId,
    pub launcher_executable: String,
    pub launcher_resolved_executable: String,
    pub launcher_sha256: String,
}

impl AgentSessionRegisterArguments {
    pub fn validate(&self) -> bool {
        !self.launcher_executable.is_empty()
            && self.launcher_executable.len() <= MAX_AGENT_LAUNCHER_PATH_BYTES
            && !self.launcher_executable.contains('\0')
            && !self.launcher_resolved_executable.is_empty()
            && self.launcher_resolved_executable.len() <= MAX_AGENT_LAUNCHER_PATH_BYTES
            && !self.launcher_resolved_executable.contains('\0')
            && self.launcher_sha256.len() == 64
            && self
                .launcher_sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }
}

impl CommandSpec for AgentSessionRegisterCommand {
    type Arguments = AgentSessionRegisterArguments;
    type Result = EmptyArguments;

    const NAME: CommandName = CommandName::AgentSessionRegister;
    const AUTHENTICATION: AuthenticationRequirement = AuthenticationRequirement::TerminalSession;
}

impl CommandSpec for AppOpenCommand {
    type Arguments = AppOpenArguments;
    type Result = AppOpenResult;

    const NAME: CommandName = CommandName::AppOpen;
    const AUTHENTICATION: AuthenticationRequirement = AuthenticationRequirement::None;
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppOpenArguments {
    #[serde(default)]
    pub wait: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppOpenResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_id: Option<Uuid>,
    pub launched: bool,
    pub ready: bool,
}
