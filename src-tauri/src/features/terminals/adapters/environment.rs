//! Secret-minimized environment and profile command construction.

use std::collections::BTreeSet;
#[cfg(windows)]
use std::ffi::OsStr;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use portable_pty::CommandBuilder;

use crate::error::{AppError, AppResult};
use crate::kernel::identity::{ConnectionId, TerminalSessionId};

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

pub(super) fn shell_command(environment: LaunchEnvironment<'_>) -> AppResult<CommandBuilder> {
    let mut command = user_shell_command()?;
    apply_environment(&mut command, environment)?;
    Ok(command)
}

fn user_shell_command() -> AppResult<CommandBuilder> {
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
    apply_base_environment(
        command,
        environment.cli_directory,
        environment.working_directory,
    )?;
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
    Ok(())
}

fn apply_base_environment(
    command: &mut CommandBuilder,
    cli_directory: &Path,
    working_directory: &Path,
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

    let path = terminal_path(cli_directory)?;
    command.env("PATH", path);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "DopeDB");
    command.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    command.cwd(working_directory.as_os_str());
    Ok(())
}

fn terminal_path(cli_directory: &Path) -> AppResult<OsString> {
    Ok(crate::cli_environment::executable_search_path(Some(
        cli_directory,
    )))
}

pub(super) fn neutral_working_directory() -> AppResult<PathBuf> {
    let directory = crate::app_paths::local_data_root()?.join("terminal-workdir");
    std::fs::create_dir_all(&directory)?;
    let metadata = std::fs::symlink_metadata(&directory)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(AppError::Blocked {
            reason: "the Terminal working directory is not a safe directory".into(),
        });
    }
    Ok(directory)
}
