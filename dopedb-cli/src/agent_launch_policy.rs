//! Closed command policy for app-only official ACP adapter launchers.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;

use dopedb_protocol::{AcpPluginId, AgentSessionRegisterArguments, SessionAuthentication};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zeroize::Zeroizing;

const MAX_LAUNCHER_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentLaunchPolicyError;

pub fn take_registration_authentication() -> Result<SessionAuthentication, AgentLaunchPolicyError> {
    let session_id = std::env::var("DOPEDB_TERMINAL_SESSION_ID")
        .ok()
        .and_then(|value| Uuid::parse_str(&value).ok())
        .ok_or(AgentLaunchPolicyError)?;
    let token = std::env::var("DOPEDB_SESSION_TOKEN")
        .ok()
        .filter(|value| !value.is_empty())
        .map(Zeroizing::new)
        .ok_or(AgentLaunchPolicyError)?;

    // Replace the visible inherited value before unsetting it. The bridge uses
    // a current-thread runtime and calls this before its first await, so no
    // worker thread can observe a partially changed process environment.
    let overwrite = Zeroizing::new("0".repeat(token.len()));
    std::env::set_var("DOPEDB_SESSION_TOKEN", overwrite.as_str());
    std::env::remove_var("DOPEDB_SESSION_TOKEN");
    Ok(SessionAuthentication::from_zeroizing_token(
        session_id, token,
    ))
}

pub fn validate_descriptor(
    registration: &AgentSessionRegisterArguments,
) -> Result<(), AgentLaunchPolicyError> {
    let path = Path::new(&registration.launcher_executable);
    let resolved = Path::new(&registration.launcher_resolved_executable);
    if !registration.validate() || !path.is_absolute() || !resolved.is_absolute() {
        return Err(AgentLaunchPolicyError);
    }
    Ok(())
}

pub fn verify_launcher(
    registration: &AgentSessionRegisterArguments,
) -> Result<(), AgentLaunchPolicyError> {
    validate_descriptor(registration)?;
    let invocation = Path::new(&registration.launcher_executable);
    let path = PathBuf::from(&registration.launcher_resolved_executable);
    if std::fs::canonicalize(invocation).map_err(|_| AgentLaunchPolicyError)? != path {
        return Err(AgentLaunchPolicyError);
    }
    let metadata = path.metadata().map_err(|_| AgentLaunchPolicyError)?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_LAUNCHER_BYTES {
        return Err(AgentLaunchPolicyError);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        if metadata.permissions().mode() & 0o111 == 0 {
            return Err(AgentLaunchPolicyError);
        }
    }
    let mut file = std::fs::File::open(path).map_err(|_| AgentLaunchPolicyError)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 16 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|_| AgentLaunchPolicyError)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    if hex::encode(hasher.finalize()) != registration.launcher_sha256 {
        return Err(AgentLaunchPolicyError);
    }
    Ok(())
}

pub fn adapter_command(
    registration: &AgentSessionRegisterArguments,
) -> Result<Command, AgentLaunchPolicyError> {
    verify_launcher(registration)?;
    let mut command = Command::new(&registration.launcher_executable);
    command
        .args(["-y", transitional_npx_package(registration.plugin_id)])
        .env_remove("DOPEDB_SESSION_TOKEN");
    Ok(command)
}

// Removed with the npx launcher once the signed plugin installer activates a
// verified adapter entrypoint. Keeping this mapping inside the closed bridge
// means the registration wire can no longer smuggle an npm package name.
fn transitional_npx_package(plugin_id: AcpPluginId) -> &'static str {
    match plugin_id {
        AcpPluginId::Claude => "@agentclientprotocol/claude-agent-acp@0.63.0",
        AcpPluginId::Codex => "@agentclientprotocol/codex-acp@1.1.7",
    }
}
