//! Secret-minimized environment and profile command construction.

use std::collections::BTreeSet;
#[cfg(any(windows, test))]
use std::ffi::OsStr;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use portable_pty::CommandBuilder;

use crate::error::{AppError, AppResult};
use crate::kernel::identity::{ConnectionId, TerminalSessionId};

use super::super::domain::TerminalProfile;

const COMMON_ENVIRONMENT: &[&str] = &[
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
];

const WINDOWS_ENVIRONMENT: &[&str] = &[
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
    "PATHEXT",
];

pub(super) struct LaunchEnvironment<'a> {
    pub session_id: TerminalSessionId,
    pub connection_id: ConnectionId,
    pub session_token: &'a str,
    pub runtime_file: Option<&'a Path>,
    pub cli_directory: &'a Path,
    pub working_directory: &'a Path,
}

pub(super) fn command_for_profile(
    profile: TerminalProfile,
    environment: LaunchEnvironment<'_>,
) -> AppResult<CommandBuilder> {
    let mut command = match profile {
        TerminalProfile::Shell => shell_command()?,
        TerminalProfile::Codex => agent_command("codex", "Codex CLI")?,
        TerminalProfile::Claude => agent_command("claude", "Claude Code")?,
    };
    apply_environment(&mut command, environment)?;
    Ok(command)
}

fn agent_executable(binary: &str, display_name: &str) -> AppResult<PathBuf> {
    crate::cli_environment::find_executable(binary).ok_or_else(|| {
        AppError::Agent(format!(
            "{display_name} (`{binary}`) was not found in the supported CLI locations"
        ))
    })
}

fn agent_command(binary: &str, display_name: &str) -> AppResult<CommandBuilder> {
    Ok(agent_command_for_executable(agent_executable(
        binary,
        display_name,
    )?))
}

#[cfg(not(windows))]
fn agent_command_for_executable(executable: PathBuf) -> CommandBuilder {
    CommandBuilder::new(executable)
}

#[cfg(windows)]
fn agent_command_for_executable(executable: PathBuf) -> CommandBuilder {
    let is_script = executable
        .extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
        });
    if !is_script {
        return CommandBuilder::new(executable);
    }

    // CreateProcessW cannot launch npm's `.cmd` shims directly. Keep the
    // executable as a distinct argument so portable-pty applies Windows quoting.
    let shell = std::env::var_os("ComSpec")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| OsString::from("cmd.exe"));
    let mut command = CommandBuilder::new(shell);
    command.args(["/D", "/S", "/C"]);
    command.arg(executable);
    command
}

fn shell_command() -> AppResult<CommandBuilder> {
    #[cfg(windows)]
    {
        let program = std::env::var_os("ComSpec")
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| OsString::from("powershell.exe"));
        let mut command = CommandBuilder::new(program);
        if command
            .get_argv()
            .first()
            .and_then(|value| Path::new(value).file_name())
            .and_then(OsStr::to_str)
            .is_some_and(|name| name.eq_ignore_ascii_case("powershell.exe"))
        {
            command.args(["-NoLogo", "-NoExit"]);
        }
        Ok(command)
    }
    #[cfg(not(windows))]
    {
        let program = std::env::var_os("SHELL")
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| OsString::from("/bin/sh"));
        let path = Path::new(&program);
        if !path.is_absolute() {
            return Err(AppError::Config(
                "the configured user shell must be an absolute path".into(),
            ));
        }
        Ok(CommandBuilder::new(program))
    }
}

fn apply_environment(
    command: &mut CommandBuilder,
    environment: LaunchEnvironment<'_>,
) -> AppResult<()> {
    command.env_clear();
    let mut allowed = COMMON_ENVIRONMENT.iter().copied().collect::<BTreeSet<_>>();
    if cfg!(windows) {
        allowed.extend(WINDOWS_ENVIRONMENT.iter().copied());
    }
    for (key, value) in std::env::vars_os() {
        let key_text = key.to_string_lossy();
        if allowed.contains(key_text.as_ref()) || key_text.starts_with("LC_") {
            command.env(key, value);
        }
    }

    let path = terminal_path(environment.cli_directory)?;
    command.env("PATH", path);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "DopeDB");
    command.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    command.env(
        "DOPEDB_TERMINAL_SESSION_ID",
        environment.session_id.to_string(),
    );
    command.env(
        "DOPEDB_CONNECTION_SCOPE",
        environment.connection_id.to_string(),
    );
    command.env("DOPEDB_SESSION_TOKEN", environment.session_token);
    if let Some(runtime_file) = environment.runtime_file {
        command.env("DOPEDB_RUNTIME_FILE", runtime_file.as_os_str());
    }
    command.cwd(environment.working_directory.as_os_str());
    Ok(())
}

fn terminal_path(cli_directory: &Path) -> AppResult<OsString> {
    Ok(crate::cli_environment::executable_search_path(Some(
        cli_directory,
    )))
}

pub(super) fn neutral_working_directory() -> AppResult<PathBuf> {
    let base = dirs::data_local_dir()
        .or_else(dirs::data_dir)
        .ok_or_else(|| AppError::Config("no local application-data directory".into()))?;
    let directory = base.join("dopedb").join("terminal-workdir");
    std::fs::create_dir_all(&directory)?;
    let metadata = std::fs::symlink_metadata(&directory)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(AppError::Blocked {
            reason: "the Terminal working directory is not a safe directory".into(),
        });
    }
    Ok(directory)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_path_puts_the_bundled_cli_first_without_duplicates() {
        let directory = std::env::temp_dir().join("dopedb-cli-fixture");
        let path = terminal_path(&directory).unwrap();
        let paths = std::env::split_paths(&path).collect::<Vec<_>>();
        assert_eq!(
            paths.first().map(PathBuf::as_path),
            Some(directory.as_path())
        );
        assert_eq!(
            paths
                .iter()
                .filter(|path| path.as_path() == directory.as_path())
                .count(),
            1
        );
    }

    #[test]
    fn terminal_environment_has_only_the_ephemeral_broker_authority() {
        let session_id = TerminalSessionId::from(uuid::Uuid::new_v4());
        let connection_id = ConnectionId::from(uuid::Uuid::new_v4());
        let cli_directory = std::env::temp_dir().join("dopedb-cli-fixture");
        let working_directory = std::env::temp_dir();
        let runtime_file = working_directory.join("runtime.json");
        let command = command_for_profile(
            TerminalProfile::Shell,
            LaunchEnvironment {
                session_id,
                connection_id,
                session_token: "ephemeral-session-token",
                runtime_file: Some(&runtime_file),
                cli_directory: &cli_directory,
                working_directory: &working_directory,
            },
        )
        .unwrap();
        let session_id_text = session_id.to_string();
        let connection_id_text = connection_id.to_string();

        assert_eq!(
            command
                .get_env("DOPEDB_TERMINAL_SESSION_ID")
                .and_then(OsStr::to_str),
            Some(session_id_text.as_str())
        );
        assert_eq!(
            command
                .get_env("DOPEDB_CONNECTION_SCOPE")
                .and_then(OsStr::to_str),
            Some(connection_id_text.as_str())
        );
        assert_eq!(
            command.get_env("DOPEDB_SESSION_TOKEN"),
            Some(OsStr::new("ephemeral-session-token"))
        );
        assert_eq!(
            command.get_env("DOPEDB_RUNTIME_FILE"),
            Some(runtime_file.as_os_str())
        );
        for forbidden in [
            "DATABASE_URL",
            "DATABASE_URL_UNPOOLED",
            "PGPASSWORD",
            "POSTGRES_PASSWORD",
            "MYSQL_PWD",
            "MONGODB_URI",
            "AWS_SECRET_ACCESS_KEY",
            "GOOGLE_APPLICATION_CREDENTIALS",
            "SSH_AUTH_SOCK",
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
            "BETTER_AUTH_SECRET",
            "DOPEDB_MCP_TOKEN",
        ] {
            assert!(
                command.get_env(forbidden).is_none(),
                "{forbidden} must not enter a Terminal child"
            );
        }
        assert!(
            command
                .get_argv()
                .iter()
                .all(|argument| argument != "ephemeral-session-token"),
            "the session capability must not enter argv"
        );
    }

    #[cfg(unix)]
    #[test]
    fn secret_free_environment_runs_through_an_interactive_pty() {
        use std::io::{Read, Write};

        use portable_pty::{native_pty_system, PtySize};

        let session_id = TerminalSessionId::from(uuid::Uuid::new_v4());
        let connection_id = ConnectionId::from(uuid::Uuid::new_v4());
        let working_directory = std::env::temp_dir();
        let mut command = CommandBuilder::new("/bin/sh");
        apply_environment(
            &mut command,
            LaunchEnvironment {
                session_id,
                connection_id,
                session_token: "ephemeral-session-token",
                runtime_file: None,
                cli_directory: &working_directory,
                working_directory: &working_directory,
            },
        )
        .unwrap();
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 20,
                cols: 80,
                pixel_width: 640,
                pixel_height: 400,
            })
            .unwrap();
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let (output_tx, output_rx) = std::sync::mpsc::channel();
        let reader_thread = std::thread::spawn(move || {
            let mut output = Vec::new();
            reader.read_to_end(&mut output).unwrap();
            output_tx.send(output).unwrap();
        });
        let mut writer = pair.master.take_writer().unwrap();
        pair.master
            .resize(PtySize {
                rows: 30,
                cols: 100,
                pixel_width: 800,
                pixel_height: 600,
            })
            .unwrap();
        #[cfg(target_os = "macos")]
        std::thread::sleep(std::time::Duration::from_millis(50));
        write!(
            writer,
            "printf 'pty-ok:%s:%s\\n' \"$DOPEDB_CONNECTION_SCOPE\" \"${{DATABASE_URL:+leaked}}\"; exit\r\n"
        )
        .unwrap();
        writer.flush().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if std::time::Instant::now() >= deadline {
                child.kill().unwrap();
                let _ = child.wait();
                drop(writer);
                drop(pair.master);
                let output = output_rx
                    .recv_timeout(std::time::Duration::from_secs(1))
                    .unwrap_or_default();
                panic!(
                    "the interactive PTY shell did not exit: {:?}",
                    String::from_utf8_lossy(&output)
                );
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        };
        assert!(status.success());
        drop(writer);
        drop(pair.master);
        let output = output_rx
            .recv_timeout(std::time::Duration::from_secs(1))
            .unwrap();
        reader_thread.join().unwrap();
        let output = String::from_utf8_lossy(&output);
        let expected = format!("pty-ok:{connection_id}:");
        assert!(
            output
                .lines()
                .any(|line| line.trim_end_matches('\r') == expected),
            "unexpected PTY output: {output:?}"
        );
    }
}
