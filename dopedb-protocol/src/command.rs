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
pub const MAX_AGENT_BUNDLE_VERSION_BYTES: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSessionRegisterArguments {
    pub plugin_id: AcpPluginId,
    pub adapter_bundle_version: String,
    pub runtime_executable: String,
    pub runtime_resolved_executable: String,
    pub runtime_sha256: String,
    pub adapter_entrypoint: String,
    pub adapter_entrypoint_sha256: String,
    pub provider_cli_executable: String,
    pub provider_cli_resolved_executable: String,
    pub provider_cli_sha256: String,
}

impl AgentSessionRegisterArguments {
    pub fn validate(&self) -> bool {
        valid_bundle_version(&self.adapter_bundle_version)
            && valid_launcher_path(&self.runtime_executable)
            && valid_launcher_path(&self.runtime_resolved_executable)
            && valid_digest(&self.runtime_sha256)
            && valid_launcher_path(&self.adapter_entrypoint)
            && valid_digest(&self.adapter_entrypoint_sha256)
            && valid_launcher_path(&self.provider_cli_executable)
            && valid_launcher_path(&self.provider_cli_resolved_executable)
            && valid_digest(&self.provider_cli_sha256)
    }
}

fn valid_launcher_path(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_AGENT_LAUNCHER_PATH_BYTES && !value.contains('\0')
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_bundle_version(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_AGENT_BUNDLE_VERSION_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+'))
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
