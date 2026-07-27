//! Fail-closed Google ADC/WIF verifier.
//!
//! The adapter accepts only a deliberately small ADC/WIF subset.  It opens
//! the selected credential as a no-follow regular file, then runs the fixed
//! `gcloud auth application-default print-access-token` command in a scrubbed
//! environment.  Neither the ADC contents nor the ephemeral bearer token can
//! escape this module.

// Windows intentionally returns unavailable before reaching the Unix-like
// fixed-argv gcloud path; keep those audited helpers available to shared tests
// without making the Windows production target fail dead-code linting.
#![cfg_attr(windows, allow(dead_code))]

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde_json::{Map, Value};
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio::time::timeout;
use zeroize::Zeroizing;

use crate::error::{AppError, AppResult};

use super::super::domain::{ProviderBindingScope, ProviderVerification};
use super::super::ports::GcpAdcVerifier;

pub(super) mod gcp_target;
#[cfg(test)]
mod gcp_target_tests;
mod process_group;
mod subject_token;
mod target_access;

use process_group::{finish_child_before_snapshot_cleanup, terminate_child, ChildTermination};
pub(crate) use subject_token::{external_subject_token_guard, read_adc_document, GcloudSnapshot};
pub(crate) use target_access::resolve_cloud_sql_connect_settings;

pub(super) const MAX_ADC_BYTES: u64 = 64 * 1024;
const MAX_TOKEN_BYTES: usize = 64 * 1024;
const GCLOUD_TIMEOUT: Duration = Duration::from_secs(10);

/// Production keyless verifier.  Its fixed principal is intentionally the
/// only data returned after the short-lived token has been discarded.
#[derive(Clone, Default)]
pub(crate) struct ProductionGcpAdcVerifier;

impl GcpAdcVerifier for ProductionGcpAdcVerifier {
    async fn verify_adc(&self, binding: &ProviderBindingScope) -> AppResult<ProviderVerification> {
        #[cfg(windows)]
        {
            // `gcloud.cmd` requires a command interpreter. This adapter never
            // invokes a shell, so Windows is unavailable until a native,
            // fixed-argv executable path is deliberately supported.
            return Err(blocked("GCP ADC verification is unavailable"));
        }
        #[cfg(not(windows))]
        {
            target_access::verify_cloud_sql_target(binding).await
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub(super) struct GcloudCommandSpec {
    pub(super) executable: PathBuf,
    pub(super) env: Vec<(String, String)>,
    pub(super) windows_no_window: bool,
    pub(super) unix_process_group: bool,
}

#[derive(Clone)]
pub(super) struct AdcSource {
    pub(super) path: PathBuf,
    pub(super) config_directory: PathBuf,
}

pub(super) fn blocked(reason: &'static str) -> AppError {
    AppError::Blocked {
        reason: reason.into(),
    }
}

fn adc_source() -> AppResult<AdcSource> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let path = if let Some(path) = std::env::var_os("GOOGLE_APPLICATION_CREDENTIALS") {
        PathBuf::from(path)
    } else {
        home.as_ref()
            .ok_or_else(|| blocked("GCP ADC credential is unavailable"))?
            .join(".config/gcloud/application_default_credentials.json")
    };
    if !path.is_absolute() {
        return Err(blocked("GCP ADC credential is invalid"));
    }
    let config_directory = path
        .parent()
        .filter(|directory| directory.is_absolute())
        .map(Path::to_path_buf)
        .ok_or_else(|| blocked("GCP ADC credential is invalid"))?;
    Ok(AdcSource {
        path,
        config_directory,
    })
}

pub(super) fn validate_adc(value: &Value) -> AppResult<()> {
    let object = value
        .as_object()
        .ok_or_else(|| blocked("GCP ADC credential is invalid"))?;
    match required_string(object, "type", 64)?.as_str() {
        "authorized_user" => validate_authorized_user(object),
        "external_account" => validate_external_account(object),
        "service_account" => Err(blocked("GCP service-account credentials are unsupported")),
        _ => Err(blocked("GCP ADC credential is unsupported")),
    }
}

fn validate_authorized_user(object: &Map<String, Value>) -> AppResult<()> {
    require_exact_keys(
        object,
        &[
            "type",
            "client_id",
            "client_secret",
            "refresh_token",
            "quota_project_id",
            "universe_domain",
        ],
    )?;
    for key in ["client_id", "client_secret", "refresh_token"] {
        required_string(object, key, 4096)?;
    }
    for key in ["quota_project_id", "universe_domain"] {
        if let Some(value) = object.get(key) {
            bounded_string(value, 1024)?;
        }
    }
    Ok(())
}

fn validate_external_account(object: &Map<String, Value>) -> AppResult<()> {
    require_exact_keys(
        object,
        &[
            "type",
            "audience",
            "subject_token_type",
            "token_url",
            "credential_source",
            "workforce_pool_user_project",
            "universe_domain",
            "service_account_impersonation_url",
        ],
    )?;
    let audience = required_string(object, "audience", 2048)?;
    if !audience.starts_with("//iam.googleapis.com/") {
        return Err(blocked("GCP WIF credential is invalid"));
    }
    let subject_type = required_string(object, "subject_token_type", 256)?;
    if !matches!(
        subject_type.as_str(),
        "urn:ietf:params:oauth:token-type:jwt" | "urn:ietf:params:oauth:token-type:saml2"
    ) || required_string(object, "token_url", 256)? != "https://sts.googleapis.com/v1/token"
    {
        return Err(blocked("GCP WIF credential is invalid"));
    }
    for key in ["workforce_pool_user_project", "universe_domain"] {
        if let Some(value) = object.get(key) {
            bounded_string(value, 1024)?;
        }
    }
    if let Some(value) = object.get("service_account_impersonation_url") {
        gcp_target::validate_impersonation_url(value)?;
    }
    validate_credential_source(
        object
            .get("credential_source")
            .and_then(Value::as_object)
            .ok_or_else(|| blocked("GCP WIF credential is invalid"))?,
    )
}

fn validate_credential_source(source: &Map<String, Value>) -> AppResult<()> {
    let keys = source.keys().map(String::as_str).collect::<BTreeSet<_>>();
    if keys.contains("executable") || keys.contains("environment_id") || keys.contains("url") {
        return Err(blocked("GCP WIF credential is invalid"));
    }
    if keys.contains("file") {
        if keys != BTreeSet::from(["file"]) && keys != BTreeSet::from(["file", "format"]) {
            return Err(blocked("GCP WIF credential is invalid"));
        }
        let file = required_string(source, "file", 4096)?;
        if !Path::new(&file).is_absolute() || source.get("format").is_some_and(|v| !safe_format(v))
        {
            return Err(blocked("GCP WIF credential is invalid"));
        }
        return Ok(());
    }
    Err(blocked("GCP WIF credential is invalid"))
}

fn safe_format(value: &Value) -> bool {
    value
        .as_object()
        .is_some_and(|format| match format.get("type").and_then(Value::as_str) {
            Some("text") => format.len() == 1,
            Some("json") => {
                format.len() <= 2
                    && format
                        .keys()
                        .all(|key| matches!(key.as_str(), "type" | "subject_token_field_name"))
                    && format
                        .get("subject_token_field_name")
                        .is_none_or(|name| bounded_string(name, 128).is_ok())
            }
            _ => false,
        })
}

fn require_exact_keys(object: &Map<String, Value>, allowed: &[&str]) -> AppResult<()> {
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(blocked("GCP ADC credential is invalid"));
    }
    Ok(())
}

fn required_string(object: &Map<String, Value>, key: &str, maximum: usize) -> AppResult<String> {
    bounded_string(
        object
            .get(key)
            .ok_or_else(|| blocked("GCP ADC credential is invalid"))?,
        maximum,
    )
}

fn bounded_string(value: &Value, maximum: usize) -> AppResult<String> {
    let value = value
        .as_str()
        .filter(|value| !value.is_empty() && value.len() <= maximum && value.is_ascii())
        .ok_or_else(|| blocked("GCP ADC credential is invalid"))?;
    Ok(value.to_owned())
}

pub(super) fn command_spec(executable: PathBuf, source: AdcSource) -> AppResult<GcloudCommandSpec> {
    let root = executable
        .ancestors()
        .find(|candidate| {
            candidate.file_name().and_then(|value| value.to_str()) == Some("google-cloud-sdk")
        })
        .ok_or_else(|| blocked("gcloud is unavailable"))?;
    let executable = audited_gcloud_from_root(root)?;
    let env = vec![
        ("PATH".into(), safe_path().into()),
        (
            "GOOGLE_APPLICATION_CREDENTIALS".into(),
            source.path.to_string_lossy().into_owned(),
        ),
        (
            "CLOUDSDK_CONFIG".into(),
            source.config_directory.to_string_lossy().into_owned(),
        ),
        // These documented gcloud configuration overrides retain the fixed
        // token stdout while disabling interactivity, telemetry, and HTTP
        // debug logging inside the private snapshot config root.
        ("CLOUDSDK_CORE_DISABLE_PROMPTS".into(), "1".into()),
        (
            "CLOUDSDK_CORE_DISABLE_USAGE_REPORTING".into(),
            "true".into(),
        ),
        ("CLOUDSDK_CORE_LOG_HTTP".into(), "false".into()),
    ];
    Ok(GcloudCommandSpec {
        executable,
        env,
        windows_no_window: cfg!(windows),
        unix_process_group: cfg!(unix),
    })
}

pub(super) fn audited_gcloud_from_root(root: &Path) -> AppResult<PathBuf> {
    let root = root
        .canonicalize()
        .map_err(|_| blocked("gcloud is unavailable"))?;
    if root.file_name().and_then(|value| value.to_str()) != Some("google-cloud-sdk") {
        return Err(blocked("gcloud is unavailable"));
    }
    let expected = root.join("bin/gcloud");
    let executable = expected
        .canonicalize()
        .map_err(|_| blocked("gcloud is unavailable"))?;
    let metadata = executable
        .metadata()
        .map_err(|_| blocked("gcloud is unavailable"))?;
    if !executable.is_absolute()
        || executable != expected
        || !executable.starts_with(&root)
        || !metadata.is_file()
        || !is_executable(&metadata)
    {
        return Err(blocked("gcloud is unavailable"));
    }
    Ok(executable)
}

#[cfg(unix)]
fn is_executable(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_: &std::fs::Metadata) -> bool {
    true
}

#[cfg(windows)]
fn find_gcloud() -> AppResult<PathBuf> {
    Err(blocked("GCP ADC verification is unavailable"))
}

#[cfg(not(windows))]
fn find_gcloud() -> AppResult<PathBuf> {
    for root in audited_gcloud_roots() {
        if let Ok(executable) = audited_gcloud_from_root(Path::new(root)) {
            return Ok(executable);
        }
    }
    Err(blocked("gcloud is unavailable"))
}

#[cfg(not(windows))]
fn audited_gcloud_roots() -> &'static [&'static str] {
    &[
        "/usr/lib/google-cloud-sdk",
        "/opt/google-cloud-sdk",
        "/usr/local/google-cloud-sdk",
        "/opt/homebrew/Caskroom/google-cloud-sdk/latest/google-cloud-sdk",
        "/usr/local/Caskroom/google-cloud-sdk/latest/google-cloud-sdk",
    ]
}

fn spawn_gcloud(spec: &GcloudCommandSpec) -> AppResult<Child> {
    let mut command = Command::new(&spec.executable);
    command
        .args([
            "--quiet",
            "auth",
            "application-default",
            "print-access-token",
        ])
        .env_clear()
        .envs(spec.env.iter().map(|(key, value)| (key, value)))
        .kill_on_drop(true)
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    command
        .spawn()
        .map_err(|_| blocked("GCP ADC verification is unavailable"))
}

async fn terminate_and_reject(
    child: &mut Child,
    termination: ChildTermination,
    error: AppError,
) -> AppError {
    // The caller always runs descriptor-rooted snapshot cleanup after this
    // returns. Do not expose OS process details, but never let a failed fence
    // skip the wipe/unlink attempt.
    let _ = terminate_child(child, termination).await;
    error
}

pub(super) async fn read_token_output(child: &mut Child) -> AppResult<Zeroizing<Vec<u8>>> {
    // Capture the PGID while the leader is certainly live. After stdout EOF
    // the leader can already be a zombie, where `getpgid` is no longer a
    // reliable way to recover its original isolated group.
    let termination = ChildTermination::capture(child);
    let Some(mut stdout) = child.stdout.take() else {
        return Err(terminate_and_reject(
            child,
            termination,
            blocked("GCP ADC credential was rejected"),
        )
        .await);
    };
    let result = timeout(GCLOUD_TIMEOUT, async {
        let mut token = Zeroizing::new(Vec::with_capacity(1024));
        let mut chunk = [0_u8; 4096];
        loop {
            let read = match stdout.read(&mut chunk).await {
                Ok(read) => read,
                Err(_) => {
                    return Err(terminate_and_reject(
                        child,
                        termination,
                        blocked("GCP ADC credential was rejected"),
                    )
                    .await);
                }
            };
            if read == 0 {
                break;
            }
            if token.len().saturating_add(read) > MAX_TOKEN_BYTES {
                return Err(terminate_and_reject(
                    child,
                    termination,
                    blocked("GCP ADC credential was rejected"),
                )
                .await);
            }
            token.extend_from_slice(&chunk[..read]);
        }
        let success = finish_child_before_snapshot_cleanup(child, termination).await?;
        normalize_command_output(success, token)
    })
    .await;
    match result {
        Ok(value) => value,
        Err(_) => Err(terminate_and_reject(
            child,
            termination,
            blocked("GCP ADC verification timed out"),
        )
        .await),
    }
}

pub(super) fn normalize_command_output(
    success: bool,
    mut token: Zeroizing<Vec<u8>>,
) -> AppResult<Zeroizing<Vec<u8>>> {
    if !success {
        return Err(blocked("GCP ADC credential was rejected"));
    }
    if token.ends_with(b"\r\n") {
        let length = token.len() - 2;
        token.truncate(length);
    } else if token.ends_with(b"\n") {
        token.pop();
    }
    validate_access_token(&token)?;
    Ok(token)
}

pub(super) fn validate_access_token(token: &[u8]) -> AppResult<()> {
    if token.is_empty()
        || token.len() > MAX_TOKEN_BYTES
        || token.iter().any(|byte| !byte.is_ascii_graphic())
    {
        return Err(blocked("GCP ADC credential was rejected"));
    }
    Ok(())
}

#[cfg(test)]
pub(super) fn command_timeout() -> Duration {
    GCLOUD_TIMEOUT
}

fn safe_path() -> &'static str {
    if cfg!(windows) {
        r"C:\Windows\System32"
    } else {
        "/usr/bin:/bin"
    }
}
