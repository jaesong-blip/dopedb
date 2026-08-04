//! Token-bearing bootstrap for one unmodified official ACP adapter.
//!
//! The launcher registers its OS process identity with the Local Broker, removes
//! the bearer capability from the child environment, and then replaces itself
//! with the exact adapter command selected by DopeDB.

use std::path::Path;
use std::process::Command;

use dopedb_protocol::{AgentSessionRegisterCommand, EmptyArguments};

use crate::client::{BrokerClient, ClientError};

const MAX_ADAPTER_ARGUMENTS: usize = 64;
const MAX_ADAPTER_ARGUMENT_BYTES: usize = 16 * 1024;

pub(crate) async fn run(command: Vec<String>) -> Result<(), ClientError> {
    validate_command(&command)?;
    let client = BrokerClient::discover()?;
    let _: EmptyArguments = client
        .request::<AgentSessionRegisterCommand>(&EmptyArguments::default())
        .await?;
    launch(command)
}

fn validate_command(command: &[String]) -> Result<(), ClientError> {
    if command.is_empty() || command.len() > MAX_ADAPTER_ARGUMENTS {
        return Err(ClientError::InvalidArguments);
    }
    let executable = Path::new(&command[0]);
    if !executable.is_absolute() || command.iter().any(|argument| argument.contains('\0')) {
        return Err(ClientError::InvalidArguments);
    }
    let total = command.iter().try_fold(0usize, |total, argument| {
        total
            .checked_add(argument.len())
            .filter(|total| *total <= MAX_ADAPTER_ARGUMENT_BYTES)
    });
    if total.is_none() {
        return Err(ClientError::InvalidArguments);
    }
    Ok(())
}

#[cfg(unix)]
fn launch(command: Vec<String>) -> Result<(), ClientError> {
    use std::os::unix::process::CommandExt;

    let mut arguments = command.into_iter();
    let executable = arguments.next().ok_or(ClientError::InvalidArguments)?;
    let error = Command::new(executable)
        .args(arguments)
        .env_remove("DOPEDB_SESSION_TOKEN")
        .exec();
    let _ = error;
    Err(ClientError::Internal)
}

#[cfg(windows)]
fn launch(command: Vec<String>) -> Result<(), ClientError> {
    let mut arguments = command.into_iter();
    let executable = arguments.next().ok_or(ClientError::InvalidArguments)?;
    let status = Command::new(executable)
        .args(arguments)
        .env_remove("DOPEDB_SESSION_TOKEN")
        .status()
        .map_err(|_| ClientError::Internal)?;
    if status.success() {
        Ok(())
    } else {
        Err(ClientError::Internal)
    }
}
