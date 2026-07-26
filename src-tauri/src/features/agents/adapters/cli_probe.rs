//! Process adapter for bounded, credential-free Agent CLI status probes.

use std::collections::BTreeSet;
use std::ffi::OsStr;
use std::path::Path;
use std::process::Output;
use std::time::Duration;

use crate::cli_environment::{executable_search_path, find_executable};

use super::super::domain::{AgentCliInfo, AgentProvider};
use super::super::ports::AgentCliProbePort;

const PROBE_TIMEOUT: Duration = Duration::from_secs(4);
const SAFE_PROBE_ENVIRONMENT: &[&str] = &[
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "TZ",
    "TMPDIR",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "USERPROFILE",
    "USERNAME",
    "HOMEDRIVE",
    "HOMEPATH",
    "LOCALAPPDATA",
    "APPDATA",
    "TEMP",
    "TMP",
    "SystemRoot",
    "ComSpec",
];

/// Runs only public CLI status subcommands, with no credential reads or environment copies.
#[derive(Clone, Copy, Default)]
pub(crate) struct ProcessAgentCliProbe;

impl AgentCliProbePort for ProcessAgentCliProbe {
    async fn detect(&self) -> Vec<AgentCliInfo> {
        let (claude, codex) = tokio::join!(detect_claude(), detect_codex());
        vec![claude, codex]
    }
}

async fn detect_claude() -> AgentCliInfo {
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
    AgentCliInfo {
        id: AgentProvider::Claude,
        name: "Claude Code".into(),
        installed,
        authenticated,
        auth_method,
        note: "Uses your Claude subscription login in a connection-pinned Terminal.".into(),
    }
}

async fn detect_codex() -> AgentCliInfo {
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
    AgentCliInfo {
        id: AgentProvider::Codex,
        name: "Codex CLI".into(),
        installed,
        authenticated,
        auth_method: None,
        note: "Uses your ChatGPT subscription login in a connection-pinned Terminal.".into(),
    }
}

fn unavailable(id: AgentProvider, name: &str, note: &str) -> AgentCliInfo {
    AgentCliInfo {
        id,
        name: name.into(),
        installed: false,
        authenticated: false,
        auth_method: None,
        note: note.into(),
    }
}

async fn run_probe(binary: &Path, args: &[&str]) -> Result<String, String> {
    run_probe_with_timeout(binary, args, PROBE_TIMEOUT).await
}

async fn run_probe_with_timeout(
    binary: &Path,
    args: &[&str],
    timeout: Duration,
) -> Result<String, String> {
    let mut command = quiet_command(binary);
    command.args(args);
    apply_probe_environment(&mut command);
    let mut command = tokio::process::Command::from(command);
    command.kill_on_drop(true);
    let output = tokio::time::timeout(timeout, command.output())
        .await
        .map_err(|_| format!("command timed out after {} ms", timeout.as_millis()))?
        .map_err(|error| error.to_string())?;
    decode_output(output)
}

fn apply_probe_environment(command: &mut std::process::Command) {
    command.env_clear();
    let allowed = SAFE_PROBE_ENVIRONMENT
        .iter()
        .copied()
        .collect::<BTreeSet<_>>();
    for (key, value) in std::env::vars_os() {
        let key_text = key.to_string_lossy();
        if allowed.contains(key_text.as_ref()) || key_text.starts_with("LC_") {
            command.env(key, value);
        }
    }
    command.env("PATH", executable_search_path(None));
}

fn decode_output(output: Output) -> Result<String, String> {
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
    } else {
        Err(format!("command failed with status {}", output.status))
    }
}

fn quiet_command(program: impl AsRef<OsStr>) -> std::process::Command {
    let program = program.as_ref();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let is_script = Path::new(program)
            .extension()
            .and_then(OsStr::to_str)
            .is_some_and(|extension| {
                extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
            });
        if is_script {
            let shell = std::env::var_os("ComSpec")
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "cmd.exe".into());
            let mut command = std::process::Command::new(shell);
            command
                .creation_flags(CREATE_NO_WINDOW)
                .args(["/D", "/S", "/C"])
                .arg(program);
            return command;
        }

        let mut command = std::process::Command::new(program);
        command.creation_flags(CREATE_NO_WINDOW);
        command
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new(program)
    }
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

    #[test]
    fn probe_environment_drops_database_and_provider_credentials() {
        let mut command = quiet_command("dopedb-agent-probe-fixture");
        command
            .env("DATABASE_URL", "redacted-database-fixture")
            .env("PGPASSWORD", "redacted-postgres-fixture")
            .env("ANTHROPIC_API_KEY", "redacted-provider-fixture");

        apply_probe_environment(&mut command);

        for forbidden in ["DATABASE_URL", "PGPASSWORD", "ANTHROPIC_API_KEY"] {
            assert!(
                command
                    .get_envs()
                    .all(|(key, value)| key != forbidden || value.is_none()),
                "{forbidden} must not enter an Agent CLI probe"
            );
        }
    }

    #[test]
    fn failed_probe_never_returns_stderr_contents() {
        let output = failing_output_with_secret();
        let error = decode_output(output).unwrap_err();

        assert!(error.contains("command failed with status"));
        assert!(!error.contains("credential-fixture"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn probe_timeout_is_bounded() {
        let error = run_probe_with_timeout(
            Path::new("/bin/sh"),
            &["-c", "sleep 1"],
            Duration::from_millis(10),
        )
        .await
        .unwrap_err();

        assert_eq!(error, "command timed out after 10 ms");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn probe_timeout_is_bounded() {
        let command = std::env::var_os("ComSpec")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::PathBuf::from("cmd.exe"));
        let error = run_probe_with_timeout(
            &command,
            &["/D", "/S", "/C", "ping -n 3 127.0.0.1 >NUL"],
            Duration::from_millis(20),
        )
        .await
        .unwrap_err();

        assert_eq!(error, "command timed out after 20 ms");
    }

    #[cfg(unix)]
    fn failing_output_with_secret() -> Output {
        std::process::Command::new("/bin/sh")
            .args(["-c", "printf credential-fixture >&2; exit 7"])
            .output()
            .unwrap()
    }

    #[cfg(windows)]
    fn failing_output_with_secret() -> Output {
        let command = std::env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into());
        std::process::Command::new(command)
            .args(["/D", "/S", "/C", "echo credential-fixture 1>&2 & exit /b 7"])
            .output()
            .unwrap()
    }

    #[cfg(windows)]
    #[test]
    fn npm_command_shims_are_launched_through_cmd_without_a_window() {
        let command = quiet_command(r"C:\fixture\codex.cmd");
        let arguments = command
            .get_args()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert_eq!(&arguments[..3], ["/D", "/S", "/C"]);
        assert_eq!(arguments[3], r"C:\fixture\codex.cmd");
    }
}
