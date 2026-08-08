//! Token-bearing bootstrap for one unmodified official ACP adapter.
//!
//! The launcher accepts a closed adapter enum, verifies the exact app-selected
//! launcher image, consumes its one-time Broker registration capability, and
//! never forwards that capability to the official adapter process.

use dopedb_cli::agent_launch_policy::{
    adapter_command, take_registration_authentication, validate_descriptor, verify_launcher,
};
use dopedb_protocol::{
    AcpPluginId, AgentSessionRegisterArguments, AgentSessionRegisterCommand, EmptyArguments,
};

use crate::client::{BrokerClient, ClientError};

pub(crate) async fn run(
    plugin_id: AcpPluginId,
    launcher_executable: String,
    launcher_resolved_executable: String,
    launcher_sha256: String,
) -> Result<(), ClientError> {
    let registration = AgentSessionRegisterArguments {
        plugin_id,
        launcher_executable,
        launcher_resolved_executable,
        launcher_sha256,
    };
    validate_registration(&registration)?;

    // Capture the bootstrap capability in a zeroizing allocation and scrub the
    // inherited environment before filesystem I/O, Broker discovery, or an
    // async suspension can extend its lifetime.
    let authentication =
        take_registration_authentication().map_err(|_| ClientError::AuthenticationUnavailable)?;
    verify_launcher(&registration).map_err(|_| ClientError::InvalidArguments)?;
    let client = BrokerClient::discover()?;
    let _: EmptyArguments = client
        .request_with_authentication::<AgentSessionRegisterCommand>(
            &registration,
            Some(authentication),
        )
        .await?;
    launch(registration)
}

fn validate_registration(registration: &AgentSessionRegisterArguments) -> Result<(), ClientError> {
    validate_descriptor(registration).map_err(|_| ClientError::InvalidArguments)
}

#[cfg(unix)]
fn launch(registration: AgentSessionRegisterArguments) -> Result<(), ClientError> {
    use std::os::unix::process::CommandExt;

    // Re-hash immediately before exec so replacement after registration fails
    // closed instead of starting an unapproved launcher image.
    let error = adapter_command(&registration)
        .map_err(|_| ClientError::InvalidArguments)?
        .exec();
    let _ = error;
    Err(ClientError::Internal)
}

#[cfg(windows)]
fn launch(registration: AgentSessionRegisterArguments) -> Result<(), ClientError> {
    // Windows keeps this bridge alive as the process-ancestry root. The
    // bootstrap bearer was already consumed and scrubbed before this wait.
    let status = adapter_command(&registration)
        .map_err(|_| ClientError::InvalidArguments)?
        .status()
        .map_err(|_| ClientError::Internal)?;
    if status.success() {
        Ok(())
    } else {
        Err(ClientError::Internal)
    }
}
