//! Credential-free discovery of supported subscription-backed agent CLIs.
//!
//! DopeDB never reads or copies provider credentials. It only checks the locally
//! installed CLI's own status command so Agent Tools can explain whether a Terminal
//! profile is ready.

use std::ffi::OsStr;
use std::path::Path;
use std::process::Output;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::cli_environment::{executable_search_path, find_executable};

const PROBE_TIMEOUT: Duration = Duration::from_secs(4);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentProvider {
    Claude,
    Codex,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliInfo {
    pub id: AgentProvider,
    pub name: String,
    pub installed: bool,
    pub authenticated: bool,
    pub auth_method: Option<String>,
    pub note: String,
}

pub async fn detect_clis() -> Vec<CliInfo> {
    let (claude, codex) = tokio::join!(detect_claude(), detect_codex());
    vec![claude, codex]
}

async fn detect_claude() -> CliInfo {
    let Some(binary) = find_executable("claude") else {
        return unavailable(
            AgentProvider::Claude,
            "Claude Code",
            "Install Claude Code to use its Terminal profile.",
        );
    };
    let installed = run_probe(&binary, &["--version"])
        .await
        .is_ok_and(|output| output.contains("Claude Code"));
    let (authenticated, auth_method) = if installed {
        run_probe(&binary, &["auth", "status"])
            .await
            .ok()
            .and_then(|output| serde_json::from_str::<serde_json::Value>(&output).ok())
            .filter(|value| {
                value
                    .get("loggedIn")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false)
            })
            .map(|value| {
                (
                    true,
                    value
                        .get("authMethod")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_owned),
                )
            })
            .unwrap_or((false, None))
    } else {
        (false, None)
    };
    CliInfo {
        id: AgentProvider::Claude,
        name: "Claude Code".into(),
        installed,
        authenticated,
        auth_method,
        note: "Uses your Claude subscription login in a connection-pinned Terminal.".into(),
    }
}

async fn detect_codex() -> CliInfo {
    let Some(binary) = find_executable("codex") else {
        return unavailable(
            AgentProvider::Codex,
            "Codex CLI",
            "Install Codex CLI to use its Terminal profile.",
        );
    };
    let installed = run_probe(&binary, &["--version"])
        .await
        .is_ok_and(|output| output.contains("codex-cli"));
    let authenticated = installed && run_probe(&binary, &["login", "status"]).await.is_ok();
    CliInfo {
        id: AgentProvider::Codex,
        name: "Codex CLI".into(),
        installed,
        authenticated,
        auth_method: None,
        note: "Uses your ChatGPT subscription login in a connection-pinned Terminal.".into(),
    }
}

fn unavailable(id: AgentProvider, name: &str, note: &str) -> CliInfo {
    CliInfo {
        id,
        name: name.into(),
        installed: false,
        authenticated: false,
        auth_method: None,
        note: note.into(),
    }
}

async fn run_probe(binary: &Path, args: &[&str]) -> Result<String, String> {
    let mut command = quiet_command(binary);
    command.args(args).env("PATH", executable_search_path(None));
    let mut command = tokio::process::Command::from(command);
    command.kill_on_drop(true);
    let output = tokio::time::timeout(PROBE_TIMEOUT, command.output())
        .await
        .map_err(|_| format!("command timed out after {} ms", PROBE_TIMEOUT.as_millis()))?
        .map_err(|error| error.to_string())?;
    decode_output(output)
}

fn decode_output(output: Output) -> Result<String, String> {
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
    } else {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        Err(if detail.is_empty() {
            "command failed".into()
        } else {
            detail
        })
    }
}

fn quiet_command(program: impl AsRef<OsStr>) -> std::process::Command {
    #[allow(unused_mut)]
    let mut command = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unavailable_provider_is_never_reported_authenticated() {
        let info = unavailable(AgentProvider::Codex, "Codex CLI", "missing");
        assert!(!info.installed);
        assert!(!info.authenticated);
        assert!(info.auth_method.is_none());
    }
}
