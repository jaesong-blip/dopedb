//! Desktop-approved project configuration and official external Agent launch.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, ExitStatus};

use dopedb_protocol::{
    EmptyArguments, ExternalAgentConfig, ExternalAgentConfigCreateArguments,
    ExternalAgentConfigCreateCommand, ExternalAgentProvider, ExternalAgentSessionRevokeCommand,
    ExternalAgentSessionStartArguments, ExternalAgentSessionStartCommand, SessionAuthentication,
};
use serde::Serialize;

use crate::client::ClientError;
use crate::commands::app;
use crate::output::{self, OutputMode};

const MAX_CONFIG_BYTES: u64 = 64 * 1024;
const DEFAULT_CONFIG_DIRECTORY: &str = ".dopedb";
const DEFAULT_CONFIG_FILE: &str = "agent.json";
const MCP_SERVER_NAME: &str = "dopedb";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InitOutput {
    config_path: String,
    provider: &'static str,
    project_id: uuid::Uuid,
    resource_count: usize,
    write_connection_id: Option<uuid::Uuid>,
}

pub(crate) async fn init(
    provider: ExternalAgentProvider,
    config_path: &Path,
    mode: OutputMode,
) -> Result<(), ClientError> {
    let working_directory = canonical_working_directory()?;
    let destination = resolve_new_config_path(&working_directory, config_path)?;
    if fs::symlink_metadata(&destination).is_ok() {
        return Err(ClientError::AgentConfigExists);
    }

    let client = app::client_or_launch().await?;
    let result = client
        .request::<ExternalAgentConfigCreateCommand>(&ExternalAgentConfigCreateArguments {
            provider,
            working_directory: utf8_path(&working_directory)?.to_owned(),
        })
        .await?;
    if !result.config.validate() || result.config.provider != provider {
        return Err(ClientError::InvalidResponse);
    }
    write_config(&working_directory, &destination, &result.config)?;

    let resource_count = result
        .config
        .resource_scopes
        .iter()
        .map(|scope| scope.connection_ids.len() + scope.source_ids.len())
        .sum();
    let summary = InitOutput {
        config_path: utf8_path(&destination)?.to_owned(),
        provider: provider_name(provider),
        project_id: result.config.project_id,
        resource_count,
        write_connection_id: result.config.write_connection_id,
    };
    match mode {
        OutputMode::Json => output::write_json(&summary),
        OutputMode::Human => output::write_human(&[
            format!("Created {}", summary.config_path),
            format!(
                "{} will request {} exact Project resource(s) through DopeDB Desktop",
                provider_display_name(provider),
                summary.resource_count
            ),
            match summary.write_connection_id {
                Some(connection_id) => format!("Write proposals are pinned to {connection_id}"),
                None => "The Agent session is read-only".into(),
            },
        ]),
    }
}

pub(crate) async fn start(
    config_path: Option<&Path>,
    provider_arguments: &[String],
) -> Result<(), ClientError> {
    let working_directory = canonical_working_directory()?;
    let (_, config) = load_config(&working_directory, config_path)?;
    let client = app::client_or_launch().await?;
    let runtime_file = client.runtime_file().to_path_buf();
    let result = client
        .request::<ExternalAgentSessionStartCommand>(&ExternalAgentSessionStartArguments {
            config: config.clone(),
            working_directory: utf8_path(&working_directory)?.to_owned(),
        })
        .await?;
    let authentication = SessionAuthentication::process_bound(result.terminal_session_id);

    let launch_result = launch_provider(
        config.provider,
        provider_arguments,
        &working_directory,
        &runtime_file,
        result.terminal_session_id,
    );
    let revoke_result = client
        .request_with_authentication::<ExternalAgentSessionRevokeCommand>(
            &EmptyArguments::default(),
            Some(authentication),
        )
        .await;

    match launch_result {
        Err(error) => Err(error),
        Ok(status) if !status.success() => Err(ClientError::AgentExited(status.code())),
        Ok(_) => revoke_result.map(|_| ()),
    }
}

fn launch_provider(
    provider: ExternalAgentProvider,
    provider_arguments: &[String],
    working_directory: &Path,
    runtime_file: &Path,
    terminal_session_id: uuid::Uuid,
) -> Result<ExitStatus, ClientError> {
    let executable = std::env::current_exe().map_err(|_| ClientError::Internal)?;
    let executable = utf8_path(&executable)?;
    let runtime_file = utf8_path(runtime_file)?;
    let terminal_session_id = terminal_session_id.to_string();
    let mut command = match provider {
        ExternalAgentProvider::Codex => codex_command(
            executable,
            runtime_file,
            &terminal_session_id,
            provider_arguments,
        )?,
        ExternalAgentProvider::Claude => claude_command(
            executable,
            runtime_file,
            &terminal_session_id,
            provider_arguments,
        )?,
    };
    command
        .current_dir(working_directory)
        .env("DOPEDB_RUNTIME_FILE", runtime_file)
        .env("DOPEDB_TERMINAL_SESSION_ID", &terminal_session_id)
        .env("DOPEDB_AGENT_PROCESS_BOUND", "1")
        .env_remove("DOPEDB_SESSION_TOKEN")
        .status()
        .map_err(|error| match error.kind() {
            io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied => {
                ClientError::AgentProviderUnavailable
            }
            _ => ClientError::Internal,
        })
}

fn codex_command(
    dopedb_executable: &str,
    runtime_file: &str,
    terminal_session_id: &str,
    provider_arguments: &[String],
) -> Result<Command, ClientError> {
    let mut command = Command::new("codex");
    let settings = [
        format!(
            "mcp_servers.{MCP_SERVER_NAME}.command={}",
            toml_string(dopedb_executable)?
        ),
        format!("mcp_servers.{MCP_SERVER_NAME}.args=[\"agent\",\"mcp\"]"),
        format!(
            "mcp_servers.{MCP_SERVER_NAME}.env.DOPEDB_RUNTIME_FILE={}",
            toml_string(runtime_file)?
        ),
        format!(
            "mcp_servers.{MCP_SERVER_NAME}.env.DOPEDB_TERMINAL_SESSION_ID={}",
            toml_string(terminal_session_id)?
        ),
        format!("mcp_servers.{MCP_SERVER_NAME}.env.DOPEDB_AGENT_PROCESS_BOUND=\"1\""),
    ];
    for setting in settings {
        command.args(["-c", setting.as_str()]);
    }
    command.args(provider_arguments);
    Ok(command)
}

fn claude_command(
    dopedb_executable: &str,
    runtime_file: &str,
    terminal_session_id: &str,
    provider_arguments: &[String],
) -> Result<Command, ClientError> {
    let mcp_config = serde_json::json!({
        "mcpServers": {
            MCP_SERVER_NAME: {
                "command": dopedb_executable,
                "args": ["agent", "mcp"],
                "env": {
                    "DOPEDB_RUNTIME_FILE": runtime_file,
                    "DOPEDB_TERMINAL_SESSION_ID": terminal_session_id,
                    "DOPEDB_AGENT_PROCESS_BOUND": "1"
                }
            }
        }
    });
    let mcp_config = serde_json::to_string(&mcp_config).map_err(|_| ClientError::Internal)?;
    let mut command = Command::new("claude");
    command.args(["--mcp-config", mcp_config.as_str()]);
    command.args(provider_arguments);
    Ok(command)
}

fn toml_string(value: &str) -> Result<String, ClientError> {
    // JSON and TOML basic strings share the escaping needed for filesystem
    // paths used here. Reject control characters that could make the command
    // override ambiguous even after quoting.
    if value.chars().any(char::is_control) {
        return Err(ClientError::AgentConfigInvalid);
    }
    serde_json::to_string(value).map_err(|_| ClientError::Internal)
}

fn canonical_working_directory() -> Result<PathBuf, ClientError> {
    let current = std::env::current_dir().map_err(|_| ClientError::AgentConfigInvalid)?;
    let canonical = fs::canonicalize(current).map_err(|_| ClientError::AgentConfigInvalid)?;
    if canonical.is_dir() {
        Ok(canonical)
    } else {
        Err(ClientError::AgentConfigInvalid)
    }
}

fn resolve_new_config_path(root: &Path, supplied: &Path) -> Result<PathBuf, ClientError> {
    if supplied.as_os_str().is_empty() {
        return Err(ClientError::AgentConfigInvalid);
    }
    let candidate = lexical_path(root, supplied)?;
    if candidate == root || !candidate.starts_with(root) || candidate.file_name().is_none() {
        return Err(ClientError::AgentConfigInvalid);
    }
    Ok(candidate)
}

fn lexical_path(root: &Path, supplied: &Path) -> Result<PathBuf, ClientError> {
    if supplied
        .components()
        .any(|component| component == Component::ParentDir)
    {
        return Err(ClientError::AgentConfigInvalid);
    }
    let candidate = if supplied.is_absolute() {
        supplied.to_path_buf()
    } else {
        root.join(supplied)
    };
    Ok(candidate)
}

fn write_config(
    root: &Path,
    destination: &Path,
    config: &ExternalAgentConfig,
) -> Result<(), ClientError> {
    let parent = destination
        .parent()
        .filter(|parent| *parent != destination)
        .ok_or(ClientError::AgentConfigInvalid)?;
    ensure_directory_chain(root, parent)?;
    let canonical_parent = fs::canonicalize(parent).map_err(|_| ClientError::AgentConfigInvalid)?;
    if canonical_parent != parent || !canonical_parent.starts_with(root) {
        return Err(ClientError::AgentConfigInvalid);
    }
    let mut bytes = serde_json::to_vec_pretty(config).map_err(|_| ClientError::Internal)?;
    bytes.push(b'\n');
    if bytes.len() as u64 > MAX_CONFIG_BYTES {
        return Err(ClientError::AgentConfigInvalid);
    }
    let mut file = open_config_create_new(destination)?;
    if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(destination);
        return Err(if error.kind() == io::ErrorKind::AlreadyExists {
            ClientError::AgentConfigExists
        } else {
            ClientError::Internal
        });
    }
    Ok(())
}

fn ensure_directory_chain(root: &Path, directory: &Path) -> Result<(), ClientError> {
    let relative = directory
        .strip_prefix(root)
        .map_err(|_| ClientError::AgentConfigInvalid)?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(component) = component else {
            return Err(ClientError::AgentConfigInvalid);
        };
        current.push(component);
        match fs::create_dir(&current) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(ClientError::Internal),
        }
        let metadata = fs::symlink_metadata(&current).map_err(|_| ClientError::Internal)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(ClientError::AgentConfigInvalid);
        }
    }
    Ok(())
}

fn load_config(
    working_directory: &Path,
    supplied: Option<&Path>,
) -> Result<(PathBuf, ExternalAgentConfig), ClientError> {
    let path = match supplied {
        Some(path) => lexical_path(working_directory, path)?,
        None => find_config(working_directory)?,
    };
    let metadata = fs::symlink_metadata(&path).map_err(|error| match error.kind() {
        io::ErrorKind::NotFound => ClientError::AgentConfigNotFound,
        _ => ClientError::AgentConfigInvalid,
    })?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() == 0
        || metadata.len() > MAX_CONFIG_BYTES
    {
        return Err(ClientError::AgentConfigInvalid);
    }
    let parent = path.parent().ok_or(ClientError::AgentConfigInvalid)?;
    if fs::canonicalize(parent).map_err(|_| ClientError::AgentConfigInvalid)? != parent {
        return Err(ClientError::AgentConfigInvalid);
    }
    let file = open_config_read(&path)?;
    let mut bytes = Vec::with_capacity(
        usize::try_from(metadata.len()).map_err(|_| ClientError::AgentConfigInvalid)?,
    );
    file.take(MAX_CONFIG_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ClientError::AgentConfigInvalid)?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_CONFIG_BYTES {
        return Err(ClientError::AgentConfigInvalid);
    }
    let config: ExternalAgentConfig =
        serde_json::from_slice(&bytes).map_err(|_| ClientError::AgentConfigInvalid)?;
    if !config.validate() {
        return Err(ClientError::AgentConfigInvalid);
    }
    Ok((path, config))
}

fn find_config(working_directory: &Path) -> Result<PathBuf, ClientError> {
    for ancestor in working_directory.ancestors() {
        let directory = ancestor.join(DEFAULT_CONFIG_DIRECTORY);
        let candidate = directory.join(DEFAULT_CONFIG_FILE);
        match fs::symlink_metadata(&candidate) {
            Ok(_) => return Ok(candidate),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                if fs::symlink_metadata(&directory)
                    .is_ok_and(|metadata| metadata.file_type().is_symlink())
                {
                    return Err(ClientError::AgentConfigInvalid);
                }
            }
            Err(_) => return Err(ClientError::AgentConfigInvalid),
        }
    }
    Err(ClientError::AgentConfigNotFound)
}

#[cfg(unix)]
fn open_config_create_new(path: &Path) -> Result<File, ClientError> {
    use std::os::unix::fs::OpenOptionsExt;

    OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o644)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|error| match error.kind() {
            io::ErrorKind::AlreadyExists => ClientError::AgentConfigExists,
            _ => ClientError::Internal,
        })
}

#[cfg(windows)]
fn open_config_create_new(path: &Path) -> Result<File, ClientError> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;

    OpenOptions::new()
        .create_new(true)
        .write(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|error| match error.kind() {
            io::ErrorKind::AlreadyExists => ClientError::AgentConfigExists,
            _ => ClientError::Internal,
        })
}

#[cfg(unix)]
fn open_config_read(path: &Path) -> Result<File, ClientError> {
    use std::os::unix::fs::OpenOptionsExt;

    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| ClientError::AgentConfigInvalid)
}

#[cfg(windows)]
fn open_config_read(path: &Path) -> Result<File, ClientError> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;

    OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|_| ClientError::AgentConfigInvalid)
}

fn utf8_path(path: &Path) -> Result<&str, ClientError> {
    path.to_str().ok_or(ClientError::AgentConfigInvalid)
}

const fn provider_name(provider: ExternalAgentProvider) -> &'static str {
    match provider {
        ExternalAgentProvider::Codex => "codex",
        ExternalAgentProvider::Claude => "claude",
    }
}

const fn provider_display_name(provider: ExternalAgentProvider) -> &'static str {
    match provider {
        ExternalAgentProvider::Codex => "Codex",
        ExternalAgentProvider::Claude => "Claude Code",
    }
}
