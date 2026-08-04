//! Fixed-binary, fixed-argv provider CLI boundary.
//!
//! Raw stdout remains bounded and process-local. The caller receives only a
//! schema-checked JSON value and must still verify the exact Provider and DB
//! target independently before advancing a receipt to `Ready`.

#[path = "process_tree.rs"]
mod process_tree;

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

use crate::error::AppResult;
use crate::operations::canonical_hash;

use super::super::domain::LocalProvider;
use super::ProvisioningExecutionPermit;
use process_tree::ProvisioningProcessTree;

const MAX_EXECUTABLE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_ARGUMENTS: usize = 128;
const MAX_ARGUMENT_BYTES: usize = 4096;
const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
const MIN_TIMEOUT: Duration = Duration::from_secs(1);
const MAX_TIMEOUT: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProvisioningExecutableIdentity {
    provider: LocalProvider,
    canonical_path: String,
    sha256: String,
    byte_length: u64,
}

impl ProvisioningExecutableIdentity {
    pub(crate) async fn audit(
        provider: LocalProvider,
        executable: &Path,
        allowed_roots: &[PathBuf],
        allowed_file_names: &[&str],
    ) -> Result<Self, ProvisioningProcessFailure> {
        if allowed_roots.is_empty() || allowed_file_names.is_empty() {
            return Err(ProvisioningProcessFailure::ExecutableRejected);
        }
        let canonical_path = tokio::fs::canonicalize(executable)
            .await
            .map_err(|_| ProvisioningProcessFailure::ExecutableUnavailable)?;
        let file_name = canonical_path
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| allowed_file_names.contains(value))
            .ok_or(ProvisioningProcessFailure::ExecutableRejected)?;
        if cfg!(windows) && !file_name.to_ascii_lowercase().ends_with(".exe") {
            return Err(ProvisioningProcessFailure::ExecutableRejected);
        }
        let mut inside_allowed_root = false;
        for root in allowed_roots {
            let canonical_root = tokio::fs::canonicalize(root)
                .await
                .map_err(|_| ProvisioningProcessFailure::ExecutableRejected)?;
            if canonical_path.starts_with(canonical_root) {
                inside_allowed_root = true;
                break;
            }
        }
        if !inside_allowed_root {
            return Err(ProvisioningProcessFailure::ExecutableRejected);
        }
        let (sha256, byte_length) = hash_regular_file(&canonical_path).await?;
        let canonical_path = canonical_path
            .to_str()
            .filter(|value| !value.chars().any(char::is_control))
            .ok_or(ProvisioningProcessFailure::ExecutableRejected)?
            .to_owned();
        Ok(Self {
            provider,
            canonical_path,
            sha256,
            byte_length,
        })
    }

    async fn revalidate(&self) -> Result<PathBuf, ProvisioningProcessFailure> {
        let requested = PathBuf::from(&self.canonical_path);
        let canonical = tokio::fs::canonicalize(&requested)
            .await
            .map_err(|_| ProvisioningProcessFailure::ExecutableChanged)?;
        if canonical != requested {
            return Err(ProvisioningProcessFailure::ExecutableChanged);
        }
        let (sha256, byte_length) = hash_regular_file(&canonical).await?;
        if sha256 != self.sha256 || byte_length != self.byte_length {
            return Err(ProvisioningProcessFailure::ExecutableChanged);
        }
        Ok(canonical)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(tag = "type", content = "path", rename_all = "camelCase")]
pub(crate) enum ProvisioningCliEnvironment {
    SafePath,
    Home(String),
    CloudSdkConfig(String),
    XdgConfigHome(String),
    PlanetScaleConfig(String),
    NeonConfig(String),
}

impl ProvisioningCliEnvironment {
    fn key_and_value(&self) -> Result<(&'static str, &str), ProvisioningProcessFailure> {
        match self {
            Self::SafePath => Ok(("PATH", safe_path())),
            Self::Home(path) => validate_environment_path("HOME", path),
            Self::CloudSdkConfig(path) => validate_environment_path("CLOUDSDK_CONFIG", path),
            Self::XdgConfigHome(path) => validate_environment_path("XDG_CONFIG_HOME", path),
            Self::PlanetScaleConfig(path) => validate_environment_path("PSCALE_CONFIG_DIR", path),
            Self::NeonConfig(path) => validate_environment_path("NEON_CONFIG_DIR", path),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProvisioningCliOutputSchema {
    Empty,
    JsonObject,
    JsonArray,
    JsonLines,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProvisioningCliCommand {
    provider: LocalProvider,
    executable: ProvisioningExecutableIdentity,
    argv: Vec<String>,
    environment: Vec<ProvisioningCliEnvironment>,
    output_schema: ProvisioningCliOutputSchema,
    timeout_ms: u64,
}

impl ProvisioningCliCommand {
    pub(crate) fn new(
        provider: LocalProvider,
        executable: ProvisioningExecutableIdentity,
        argv: Vec<String>,
        environment: Vec<ProvisioningCliEnvironment>,
        output_schema: ProvisioningCliOutputSchema,
        timeout: Duration,
    ) -> Result<Self, ProvisioningProcessFailure> {
        let command = Self {
            provider,
            executable,
            argv,
            environment,
            output_schema,
            timeout_ms: u64::try_from(timeout.as_millis())
                .map_err(|_| ProvisioningProcessFailure::CommandRejected)?,
        };
        command.validate()?;
        Ok(command)
    }

    pub(crate) fn redacted_plan(&self) -> Value {
        serde_json::json!({
            "provider": self.provider,
            "executableSha256": self.executable.sha256,
            "argv": self.argv,
            "environmentKeys": self.environment.iter().filter_map(|value| {
                value.key_and_value().ok().map(|(key, _)| key)
            }).collect::<Vec<_>>(),
            "outputSchema": self.output_schema,
            "timeoutMs": self.timeout_ms,
        })
    }

    /// Hash the complete local execution specification. The UI renders only the
    /// redacted projection, while the approved plan pins argv, environment paths,
    /// executable identity, output schema, and timeout together.
    pub(crate) fn execution_sha256(&self) -> AppResult<String> {
        canonical_hash(&serde_json::to_value(self)?)
    }

    pub(super) async fn run(
        &self,
        permit: &ProvisioningExecutionPermit,
        cancellation: &CancellationToken,
    ) -> Result<ProvisioningCliOutput, ProvisioningProcessFailure> {
        self.validate()?;
        if permit.provider != self.provider
            || permit.execution_sha256
                != self
                    .execution_sha256()
                    .map_err(|_| ProvisioningProcessFailure::CommandRejected)?
            || permit.plan_sha256.len() != 64
            || permit.operation_id.is_nil()
        {
            return Err(ProvisioningProcessFailure::CommandRejected);
        }
        if cancellation.is_cancelled() {
            return Err(ProvisioningProcessFailure::Cancelled);
        }
        let executable = self.executable.revalidate().await?;
        let mut command = Command::new(executable);
        command
            .args(&self.argv)
            .env_clear()
            .kill_on_drop(true)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        for environment in &self.environment {
            let (key, value) = environment.key_and_value()?;
            command.env(key, value);
        }
        #[cfg(unix)]
        command.process_group(0);
        #[cfg(windows)]
        command.creation_flags(
            windows_sys::Win32::System::Threading::CREATE_NO_WINDOW
                | windows_sys::Win32::System::Threading::CREATE_NEW_PROCESS_GROUP,
        );
        let mut child = command
            .spawn()
            .map_err(|_| ProvisioningProcessFailure::SpawnFailed)?;
        let mut tree = match ProvisioningProcessTree::attach(&child) {
            Ok(tree) => tree,
            Err(error) => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                return Err(error);
            }
        };
        let stdout = child
            .stdout
            .take()
            .ok_or(ProvisioningProcessFailure::OutputRejected)?;
        let read = read_bounded(stdout);
        let timeout = Duration::from_millis(self.timeout_ms);
        let result = tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err(ProvisioningProcessFailure::Cancelled),
            value = tokio::time::timeout(timeout, read) => match value {
                Ok(value) => value,
                Err(_) => Err(ProvisioningProcessFailure::TimedOut),
            },
        };
        let cleanup = tree.terminate_and_reap(&mut child).await;
        if cleanup.is_err() {
            return Err(ProvisioningProcessFailure::CleanupFailed);
        }
        let output = result?;
        parse_output(self.output_schema, output)
    }

    fn validate(&self) -> Result<(), ProvisioningProcessFailure> {
        let timeout = Duration::from_millis(self.timeout_ms);
        if self.provider != self.executable.provider
            || self.argv.is_empty()
            || self.argv.len() > MAX_ARGUMENTS
            || !(MIN_TIMEOUT..=MAX_TIMEOUT).contains(&timeout)
            || self.argv.iter().any(|argument| {
                argument.is_empty()
                    || argument.len() > MAX_ARGUMENT_BYTES
                    || argument
                        .chars()
                        .any(|value| value == '\0' || value.is_control())
            })
        {
            return Err(ProvisioningProcessFailure::CommandRejected);
        }
        let mut keys = BTreeSet::new();
        for environment in &self.environment {
            let (key, _) = environment.key_and_value()?;
            if !keys.insert(key) {
                return Err(ProvisioningProcessFailure::CommandRejected);
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ProvisioningCliOutput {
    value: Value,
}

impl ProvisioningCliOutput {
    pub(crate) fn value(&self) -> &Value {
        &self.value
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub(crate) enum ProvisioningProcessFailure {
    #[error("provider CLI is unavailable")]
    ExecutableUnavailable,
    #[error("provider CLI executable was rejected")]
    ExecutableRejected,
    #[error("provider CLI executable changed after planning")]
    ExecutableChanged,
    #[error("provider CLI command was rejected")]
    CommandRejected,
    #[error("provider CLI process isolation failed")]
    ProcessIsolationFailed,
    #[error("provider CLI could not start")]
    SpawnFailed,
    #[error("provider CLI operation was cancelled")]
    Cancelled,
    #[error("provider CLI operation timed out")]
    TimedOut,
    #[error("provider CLI output was rejected")]
    OutputRejected,
    #[error("provider CLI process cleanup failed")]
    CleanupFailed,
}

async fn hash_regular_file(path: &Path) -> Result<(String, u64), ProvisioningProcessFailure> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|_| ProvisioningProcessFailure::ExecutableUnavailable)?;
    let before = file
        .metadata()
        .await
        .map_err(|_| ProvisioningProcessFailure::ExecutableUnavailable)?;
    if !before.is_file() || before.len() == 0 || before.len() > MAX_EXECUTABLE_BYTES {
        return Err(ProvisioningProcessFailure::ExecutableRejected);
    }
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut observed = 0_u64;
    loop {
        let read = file
            .read(&mut buffer)
            .await
            .map_err(|_| ProvisioningProcessFailure::ExecutableChanged)?;
        if read == 0 {
            break;
        }
        observed = observed
            .checked_add(u64::try_from(read).expect("buffer length fits in u64"))
            .ok_or(ProvisioningProcessFailure::ExecutableRejected)?;
        if observed > MAX_EXECUTABLE_BYTES {
            return Err(ProvisioningProcessFailure::ExecutableRejected);
        }
        digest.update(&buffer[..read]);
    }
    let after = file
        .metadata()
        .await
        .map_err(|_| ProvisioningProcessFailure::ExecutableChanged)?;
    if observed != before.len() || after.len() != before.len() {
        return Err(ProvisioningProcessFailure::ExecutableChanged);
    }
    Ok((lower_hex(&digest.finalize()), observed))
}

async fn read_bounded(
    mut stdout: tokio::process::ChildStdout,
) -> Result<Zeroizing<Vec<u8>>, ProvisioningProcessFailure> {
    let mut output = Zeroizing::new(Vec::with_capacity(4096));
    let mut buffer = [0_u8; 8192];
    loop {
        let read = stdout
            .read(&mut buffer)
            .await
            .map_err(|_| ProvisioningProcessFailure::OutputRejected)?;
        if read == 0 {
            return Ok(output);
        }
        if output.len().saturating_add(read) > MAX_OUTPUT_BYTES {
            return Err(ProvisioningProcessFailure::OutputRejected);
        }
        output.extend_from_slice(&buffer[..read]);
    }
}

fn parse_output(
    schema: ProvisioningCliOutputSchema,
    output: Zeroizing<Vec<u8>>,
) -> Result<ProvisioningCliOutput, ProvisioningProcessFailure> {
    let value = match schema {
        ProvisioningCliOutputSchema::Empty if output.iter().all(u8::is_ascii_whitespace) => {
            Value::Null
        }
        ProvisioningCliOutputSchema::Empty => {
            return Err(ProvisioningProcessFailure::OutputRejected)
        }
        ProvisioningCliOutputSchema::JsonObject => serde_json::from_slice(&output)
            .ok()
            .filter(Value::is_object)
            .ok_or(ProvisioningProcessFailure::OutputRejected)?,
        ProvisioningCliOutputSchema::JsonArray => serde_json::from_slice(&output)
            .ok()
            .filter(Value::is_array)
            .ok_or(ProvisioningProcessFailure::OutputRejected)?,
        ProvisioningCliOutputSchema::JsonLines => {
            let mut values = Vec::new();
            for line in output.split(|byte| *byte == b'\n') {
                let line = line
                    .strip_suffix(b"\r")
                    .unwrap_or(line)
                    .iter()
                    .copied()
                    .collect::<Vec<_>>();
                if line.iter().all(u8::is_ascii_whitespace) {
                    continue;
                }
                values.push(
                    serde_json::from_slice(&line)
                        .map_err(|_| ProvisioningProcessFailure::OutputRejected)?,
                );
            }
            Value::Array(values)
        }
    };
    Ok(ProvisioningCliOutput { value })
}

fn validate_environment_path<'a>(
    key: &'static str,
    value: &'a str,
) -> Result<(&'static str, &'a str), ProvisioningProcessFailure> {
    let path = Path::new(value);
    if !path.is_absolute()
        || value.is_empty()
        || value.len() > MAX_ARGUMENT_BYTES
        || value.chars().any(char::is_control)
    {
        return Err(ProvisioningProcessFailure::CommandRejected);
    }
    Ok((key, value))
}

fn safe_path() -> &'static str {
    if cfg!(windows) {
        r"C:\Windows\System32"
    } else {
        "/usr/bin:/bin"
    }
}

fn lower_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

#[cfg(test)]
pub(crate) async fn assert_process_boundary() {
    use uuid::Uuid;

    #[cfg(unix)]
    {
        let executable = ProvisioningExecutableIdentity::audit(
            LocalProvider::GcpCloudSql,
            Path::new("/usr/bin/printf"),
            &[PathBuf::from("/usr/bin")],
            &["printf"],
        )
        .await
        .expect("audit a fixed native fixture executable");
        let command = ProvisioningCliCommand::new(
            LocalProvider::GcpCloudSql,
            executable.clone(),
            vec![r#"{"target":"exact"}"#.into()],
            vec![ProvisioningCliEnvironment::SafePath],
            ProvisioningCliOutputSchema::JsonObject,
            Duration::from_secs(2),
        )
        .expect("construct fixed argv fixture");
        let output = command
            .run(
                &ProvisioningExecutionPermit::issue(
                    Uuid::from_u128(51),
                    LocalProvider::GcpCloudSql,
                    "ef".repeat(32),
                    command.execution_sha256().unwrap(),
                ),
                &CancellationToken::new(),
            )
            .await
            .expect("execute fixed argv fixture");
        assert_eq!(output.value()["target"], "exact");
        assert_eq!(command.execution_sha256().unwrap().len(), 64);
        assert!(!command
            .redacted_plan()
            .to_string()
            .contains("provider-secret"));

        assert!(ProvisioningCliCommand::new(
            LocalProvider::GcpCloudSql,
            executable.clone(),
            vec!["bad\nargument".into()],
            vec![ProvisioningCliEnvironment::SafePath],
            ProvisioningCliOutputSchema::Empty,
            Duration::from_secs(2),
        )
        .is_err());
        assert!(ProvisioningCliCommand::new(
            LocalProvider::GcpCloudSql,
            executable.clone(),
            vec!["x".into()],
            vec![
                ProvisioningCliEnvironment::SafePath,
                ProvisioningCliEnvironment::SafePath,
            ],
            ProvisioningCliOutputSchema::Empty,
            Duration::from_secs(2),
        )
        .is_err());

        let cancelled = CancellationToken::new();
        cancelled.cancel();
        let cancelled_command = ProvisioningCliCommand::new(
            LocalProvider::GcpCloudSql,
            executable,
            vec!["x".into()],
            vec![],
            ProvisioningCliOutputSchema::Empty,
            Duration::from_secs(2),
        )
        .expect("construct cancellation fixture");
        assert_eq!(
            cancelled_command
                .run(
                    &ProvisioningExecutionPermit::issue(
                        Uuid::from_u128(52),
                        LocalProvider::GcpCloudSql,
                        "ef".repeat(32),
                        cancelled_command.execution_sha256().unwrap(),
                    ),
                    &cancelled,
                )
                .await,
            Err(ProvisioningProcessFailure::Cancelled)
        );
    }
}
