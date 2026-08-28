//! BigQuery connection onboarding through the official Google Cloud CLI.
//!
//! Browser OAuth and service-account credential import stay inside `gcloud`.
//! Desktop receives only bounded account and resource identifiers, while `bq`
//! remains the sole process that talks to BigQuery.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tokio::process::Command;

use crate::error::{AppError, AppResult};
use crate::model::{ConnectionProfile, Engine, Provider, WorkspaceConnectionAccess};
use crate::process_tree::ProcessTree;

use super::{
    default_cloudsdk_config, discover_sdk_executable, map_process_tree_error, read_bounded,
    safe_path, CommandFailure, CommandOutput, ResolvedSdkExecutable, MAX_ERROR_BYTES,
    MAX_LIST_RESULTS, MAX_OUTPUT_BYTES,
};

const AUTH_MODE_PARAMETER: &str = "authMode";
const GOOGLE_ACCOUNT_MODE: &str = "googleAccount";
const SERVICE_ACCOUNT_MODE: &str = "serviceAccount";
const MAX_PROJECT_RESULTS: usize = 500;
const AUTH_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(45);
const MAX_CREDENTIAL_FILE_BYTES: u64 = 1 << 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum BigQueryAuthMode {
    GoogleAccount,
    ServiceAccount,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BigQueryAuthState {
    mode: BigQueryAuthMode,
    authenticated: bool,
    account: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BigQueryProjectSummary {
    id: String,
    name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BigQueryDatasetSummary {
    id: String,
}

#[derive(Debug, Clone, Copy)]
enum SdkExecutable {
    Bq,
    Gcloud,
}

impl SdkExecutable {
    fn label(self) -> &'static str {
        match self {
            Self::Bq => "BigQuery CLI",
            Self::Gcloud => "Google Cloud CLI",
        }
    }
}

pub(super) fn validate_auth_mode(profile: &ConnectionProfile) -> AppResult<()> {
    auth_mode(profile).map(|_| ())
}

pub(crate) fn uses_service_account_auth(profile: &ConnectionProfile) -> AppResult<bool> {
    Ok(auth_mode(profile)? == BigQueryAuthMode::ServiceAccount)
}

pub(super) fn cloudsdk_config(profile: &ConnectionProfile, home: &Path) -> AppResult<PathBuf> {
    match auth_mode(profile)? {
        BigQueryAuthMode::GoogleAccount => default_cloudsdk_config(home),
        BigQueryAuthMode::ServiceAccount => service_account_config(profile),
    }
}

pub(crate) async fn auth_state(profile: ConnectionProfile) -> AppResult<BigQueryAuthState> {
    validate_onboarding_profile(&profile)?;
    let mode = auth_mode(&profile)?;
    let config = config_for_onboarding(&profile)?;
    if mode == BigQueryAuthMode::ServiceAccount && !config.is_dir() {
        return Ok(BigQueryAuthState {
            mode,
            authenticated: false,
            account: None,
        });
    }
    let value = run_json(
        SdkExecutable::Gcloud,
        &[
            "--quiet".into(),
            "--format=json".into(),
            "auth".into(),
            "list".into(),
            "--filter=status:ACTIVE".into(),
        ],
        &config,
        DISCOVERY_TIMEOUT,
    )
    .await?;
    parse_auth_state(mode, &value)
}

pub(crate) async fn authenticate_google_account(
    profile: ConnectionProfile,
) -> AppResult<BigQueryAuthState> {
    validate_onboarding_profile(&profile)?;
    if auth_mode(&profile)? != BigQueryAuthMode::GoogleAccount {
        return Err(AppError::Config(
            "select Google account authentication before starting browser login".into(),
        ));
    }
    let config = config_for_onboarding(&profile)?;
    run_checked(
        SdkExecutable::Gcloud,
        &[
            "--quiet".into(),
            "auth".into(),
            "login".into(),
            "--brief".into(),
            "--force".into(),
            "--launch-browser".into(),
        ],
        &config,
        AUTH_TIMEOUT,
    )
    .await?;
    auth_state(profile).await
}

pub(crate) async fn authenticate_service_account(
    profile: ConnectionProfile,
    credential_file: String,
) -> AppResult<BigQueryAuthState> {
    validate_onboarding_profile(&profile)?;
    if auth_mode(&profile)? != BigQueryAuthMode::ServiceAccount {
        return Err(AppError::Config(
            "select service account authentication before choosing a key file".into(),
        ));
    }
    let credential = audited_credential_path(Path::new(&credential_file))?;
    let config = config_for_onboarding(&profile)?;
    prepare_private_directory(&config)?;
    run_checked(
        SdkExecutable::Gcloud,
        &[
            "--quiet".into(),
            "auth".into(),
            "login".into(),
            format!("--cred-file={}", credential.to_string_lossy()),
            "--brief".into(),
        ],
        &config,
        AUTH_TIMEOUT,
    )
    .await?;
    auth_state(profile).await
}

pub(crate) async fn discover_projects(
    profile: ConnectionProfile,
) -> AppResult<Vec<BigQueryProjectSummary>> {
    validate_onboarding_profile(&profile)?;
    let config = config_for_onboarding(&profile)?;
    let value = run_json(
        SdkExecutable::Gcloud,
        &[
            "--quiet".into(),
            "--format=json".into(),
            "projects".into(),
            "list".into(),
            format!("--limit={MAX_PROJECT_RESULTS}"),
            "--sort-by=projectId".into(),
        ],
        &config,
        DISCOVERY_TIMEOUT,
    )
    .await?;
    parse_projects(&value)
}

pub(crate) async fn discover_datasets(
    profile: ConnectionProfile,
    project_id: String,
) -> AppResult<Vec<BigQueryDatasetSummary>> {
    validate_onboarding_profile(&profile)?;
    let project_id = project_id.trim();
    if !super::valid_project_id(project_id) {
        return Err(AppError::Config("BigQuery project ID is invalid".into()));
    }
    let config = config_for_onboarding(&profile)?;
    let value = run_json(
        SdkExecutable::Bq,
        &[
            format!("--bigqueryrc={}", super::null_device()),
            "--api=https://bigquery.googleapis.com".into(),
            "--format=json".into(),
            "--headless=true".into(),
            "--quiet=true".into(),
            "--debug_mode=false".into(),
            "--disable_ssl_validation=false".into(),
            "--httplib2_debuglevel=0".into(),
            format!("--project_id={project_id}"),
            "ls".into(),
            "--datasets=true".into(),
            format!("--max_results={MAX_LIST_RESULTS}"),
            project_id.into(),
        ],
        &config,
        DISCOVERY_TIMEOUT,
    )
    .await?;
    parse_datasets(&value, project_id)
}

pub(crate) async fn cleanup_service_account_auth(profile: &ConnectionProfile) -> AppResult<()> {
    if profile.engine != Engine::Bigquery {
        return Ok(());
    }
    let target = service_account_config(profile)?;
    let metadata = match tokio::fs::symlink_metadata(&target).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_symlink() || metadata.is_file() {
        tokio::fs::remove_file(target).await?;
    } else if metadata.is_dir() {
        tokio::fs::remove_dir_all(target).await?;
    } else {
        return Err(AppError::Blocked {
            reason: "BigQuery service-account credential storage has an invalid file type".into(),
        });
    }
    Ok(())
}

fn auth_mode(profile: &ConnectionProfile) -> AppResult<BigQueryAuthMode> {
    match profile
        .extra_params
        .get(AUTH_MODE_PARAMETER)
        .map(String::as_str)
    {
        None | Some(GOOGLE_ACCOUNT_MODE) => Ok(BigQueryAuthMode::GoogleAccount),
        Some(SERVICE_ACCOUNT_MODE) => Ok(BigQueryAuthMode::ServiceAccount),
        Some(_) => Err(AppError::Config(
            "BigQuery authMode must be googleAccount or serviceAccount".into(),
        )),
    }
}

fn validate_onboarding_profile(profile: &ConnectionProfile) -> AppResult<()> {
    if profile.engine != Engine::Bigquery || profile.provider != Provider::Generic {
        return Err(AppError::Config(
            "BigQuery onboarding requires a local generic BigQuery profile".into(),
        ));
    }
    if profile.workspace_access != WorkspaceConnectionAccess::Local {
        return Err(AppError::Blocked {
            reason: "shared BigQuery credentials must be connected from a member-local binding"
                .into(),
        });
    }
    validate_auth_mode(profile)
}

fn config_for_onboarding(profile: &ConnectionProfile) -> AppResult<PathBuf> {
    let home = crate::app_paths::home_dir()?;
    cloudsdk_config(profile, &home)
}

fn service_account_config(profile: &ConnectionProfile) -> AppResult<PathBuf> {
    Ok(crate::app_paths::local_data_root()?
        .join("bigquery-gcloud")
        .join(profile.id.simple().to_string()))
}

fn prepare_private_directory(directory: &Path) -> AppResult<()> {
    let root = directory.parent().ok_or_else(|| AppError::Blocked {
        reason: "BigQuery service-account credential storage is invalid".into(),
    })?;
    prepare_directory(root)?;
    prepare_directory(directory)
}

fn prepare_directory(directory: &Path) -> AppResult<()> {
    match std::fs::symlink_metadata(directory) {
        Ok(metadata) => {
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err(AppError::Blocked {
                    reason: "BigQuery credential storage must be a private local directory".into(),
                });
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir(directory)?;
        }
        Err(error) => return Err(error.into()),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn audited_credential_path(path: &Path) -> AppResult<PathBuf> {
    if !path.is_absolute() || path_has_unsafe_characters(path) {
        return Err(AppError::Config(
            "the service-account credential file path is invalid".into(),
        ));
    }
    let metadata = std::fs::symlink_metadata(path).map_err(|_| {
        AppError::Config("the service-account credential file is unavailable".into())
    })?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() == 0
        || metadata.len() > MAX_CREDENTIAL_FILE_BYTES
    {
        return Err(AppError::Config(
            "the service-account credential must be a regular JSON file up to 1 MiB".into(),
        ));
    }
    path.canonicalize().map_err(AppError::from)
}

fn path_has_unsafe_characters(path: &Path) -> bool {
    path.to_string_lossy().chars().any(|value| {
        value.is_control()
            || matches!(
                value,
                '\u{061c}'
                    | '\u{200e}'
                    | '\u{200f}'
                    | '\u{202a}'..='\u{202e}'
                    | '\u{2066}'..='\u{2069}'
                    | '\u{feff}'
            )
    })
}

async fn discover_onboarding_executable(kind: SdkExecutable) -> AppResult<ResolvedSdkExecutable> {
    let allowed_names = match kind {
        SdkExecutable::Bq => &["bq", "bq.cmd"][..],
        SdkExecutable::Gcloud => &["gcloud", "gcloud.cmd"][..],
    };
    discover_sdk_executable(allowed_names, kind.label()).await
}

async fn run_json(
    kind: SdkExecutable,
    arguments: &[String],
    config: &Path,
    timeout: Duration,
) -> AppResult<Value> {
    let output = run_checked(kind, arguments, config, timeout).await?;
    serde_json::from_slice(&output.stdout)
        .map_err(|_| AppError::Config(format!("{} returned invalid JSON", kind.label())))
}

async fn run_checked(
    kind: SdkExecutable,
    arguments: &[String],
    config: &Path,
    timeout: Duration,
) -> AppResult<CommandOutput> {
    validate_arguments(arguments)?;
    let resolved = discover_onboarding_executable(kind).await?;
    let executable = resolved
        .identity
        .revalidate()
        .await
        .map_err(onboarding_command_failure)?;
    let home = crate::app_paths::home_dir()?;
    let mut command = Command::new(executable);
    command
        .args(arguments)
        .env_clear()
        .env("PATH", safe_path())
        .env("HOME", home)
        .env("CLOUDSDK_CONFIG", config)
        .env("CLOUDSDK_CORE_DISABLE_PROMPTS", "1")
        .env("CLOUDSDK_CORE_DISABLE_USAGE_REPORTING", "true")
        .env("CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK", "1")
        .env("CLOUDSDK_CORE_LOG_HTTP", "false")
        .env("PYTHONIOENCODING", "utf-8")
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    resolved.environment.apply(&mut command);
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    command.creation_flags(
        windows_sys::Win32::System::Threading::CREATE_NO_WINDOW
            | windows_sys::Win32::System::Threading::CREATE_NEW_PROCESS_GROUP,
    );
    let mut child = command
        .spawn()
        .map_err(|_| onboarding_command_failure(CommandFailure::Spawn))?;
    let mut tree = match ProcessTree::attach(&child) {
        Ok(tree) => tree,
        Err(_) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            return Err(onboarding_command_failure(CommandFailure::Isolation));
        }
    };
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| onboarding_command_failure(CommandFailure::Output))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| onboarding_command_failure(CommandFailure::Output))?;
    let captured = tokio::time::timeout(timeout, async move {
        tokio::try_join!(
            read_bounded(stdout, MAX_OUTPUT_BYTES),
            read_bounded(stderr, MAX_ERROR_BYTES)
        )
    })
    .await;
    let status = tree
        .terminate_and_reap(&mut child)
        .await
        .map_err(map_process_tree_error)
        .map_err(onboarding_command_failure)?;
    let (stdout, stderr) = captured
        .map_err(|_| onboarding_command_failure(CommandFailure::TimedOut))?
        .map_err(onboarding_command_failure)?;
    let output = CommandOutput {
        status,
        stdout,
        stderr,
    };
    if output.status.success() {
        Ok(output)
    } else {
        Err(safe_onboarding_error(kind, &output.stderr))
    }
}

fn validate_arguments(arguments: &[String]) -> AppResult<()> {
    if arguments.is_empty()
        || arguments.len() > 32
        || arguments.iter().any(|argument| {
            argument.is_empty() || argument.len() > 4096 || argument.chars().any(char::is_control)
        })
    {
        return Err(AppError::Blocked {
            reason: "Google Cloud CLI request is invalid".into(),
        });
    }
    Ok(())
}

fn safe_onboarding_error(kind: SdkExecutable, stderr: &[u8]) -> AppError {
    let text = String::from_utf8_lossy(stderr).to_ascii_lowercase();
    if text.contains("reauthentication failed")
        || text.contains("invalid_grant")
        || text.contains("login required")
        || text.contains("no credentialed accounts")
    {
        return AppError::Config(
            "Google Cloud authentication is unavailable; connect the account and retry".into(),
        );
    }
    if text.contains("access denied")
        || text.contains("permission denied")
        || text.contains("does not have") && text.contains("permission")
        || text.contains("accessdenied")
    {
        return AppError::Blocked {
            reason: "the connected Google Cloud account cannot list this BigQuery resource".into(),
        };
    }
    if text.contains("has not been used")
        || text.contains("accessnotconfigured")
        || text.contains("api is not enabled")
    {
        return AppError::Config(
            "the BigQuery API is not enabled for the selected Google Cloud project".into(),
        );
    }
    if text.contains("not found") || text.contains("notfound") {
        return AppError::NotFound(
            "the selected Google Cloud project or BigQuery resource was not found".into(),
        );
    }
    if text.contains("quota") || text.contains("rate limit") {
        return AppError::Config(
            "Google Cloud temporarily rejected resource discovery because of a quota limit".into(),
        );
    }
    if text.contains("timed out")
        || text.contains("connection reset")
        || text.contains("could not resolve")
        || text.contains("name resolution")
        || text.contains("network is unreachable")
    {
        return AppError::Network("Google Cloud resource discovery could not connect".into());
    }
    AppError::Config(format!(
        "{} rejected the request; verify the local Google Cloud login and permissions",
        kind.label()
    ))
}

fn onboarding_command_failure(error: CommandFailure) -> AppError {
    match error {
        CommandFailure::Unavailable | CommandFailure::Changed => AppError::Blocked {
            reason: "the verified Google Cloud CLI executable changed or became unavailable".into(),
        },
        CommandFailure::Spawn => {
            AppError::Config("the verified Google Cloud CLI could not be started".into())
        }
        CommandFailure::Isolation => AppError::Blocked {
            reason: "the Google Cloud CLI process could not be isolated safely".into(),
        },
        CommandFailure::Cleanup => AppError::OutcomeUnknown(
            "the Google Cloud CLI process tree could not be proven stopped".into(),
        ),
        CommandFailure::Output => AppError::Blocked {
            reason: "Google Cloud CLI output exceeded its local safety bound".into(),
        },
        CommandFailure::TimedOut => {
            AppError::Timeout("Google Cloud CLI authentication or discovery timed out".into())
        }
        CommandFailure::Cancelled => AppError::Safety("Google Cloud CLI request cancelled".into()),
    }
}

fn parse_auth_state(mode: BigQueryAuthMode, value: &Value) -> AppResult<BigQueryAuthState> {
    let rows = value
        .as_array()
        .filter(|rows| rows.len() <= 4)
        .ok_or_else(|| AppError::Config("Google Cloud returned an invalid account list".into()))?;
    let account = rows.iter().find_map(|row| {
        let account = row.get("account")?.as_str()?;
        let status = row
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("ACTIVE");
        (status.eq_ignore_ascii_case("ACTIVE") && valid_account(account))
            .then(|| account.to_owned())
    });
    Ok(BigQueryAuthState {
        mode,
        authenticated: account.is_some(),
        account,
    })
}

fn parse_projects(value: &Value) -> AppResult<Vec<BigQueryProjectSummary>> {
    let rows = value
        .as_array()
        .filter(|rows| rows.len() <= MAX_PROJECT_RESULTS)
        .ok_or_else(|| AppError::Config("Google Cloud returned an invalid project list".into()))?;
    let mut projects = Vec::with_capacity(rows.len());
    for row in rows {
        if row
            .get("lifecycleState")
            .and_then(Value::as_str)
            .is_some_and(|state| state != "ACTIVE")
        {
            continue;
        }
        let id = row
            .get("projectId")
            .and_then(Value::as_str)
            .filter(|id| super::valid_project_id(id))
            .ok_or_else(|| {
                AppError::Config("Google Cloud returned an invalid project ID".into())
            })?;
        let name = row
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| valid_label(name, 256))
            .unwrap_or(id);
        projects.push(BigQueryProjectSummary {
            id: id.into(),
            name: name.into(),
        });
    }
    projects.sort_by(|left, right| left.id.cmp(&right.id));
    projects.dedup_by(|left, right| left.id == right.id);
    Ok(projects)
}

fn parse_datasets(value: &Value, expected_project: &str) -> AppResult<Vec<BigQueryDatasetSummary>> {
    let rows = value
        .as_array()
        .filter(|rows| rows.len() <= MAX_LIST_RESULTS as usize)
        .ok_or_else(|| AppError::Config("BigQuery returned an invalid dataset list".into()))?;
    let mut datasets = Vec::with_capacity(rows.len());
    for row in rows {
        let reference = row
            .get("datasetReference")
            .and_then(Value::as_object)
            .ok_or_else(|| AppError::Config("BigQuery dataset reference is missing".into()))?;
        let project = reference
            .get("projectId")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::Config("BigQuery dataset project is missing".into()))?;
        if project != expected_project {
            return Err(AppError::Blocked {
                reason: "BigQuery returned a dataset outside the selected project".into(),
            });
        }
        let id = reference
            .get("datasetId")
            .and_then(Value::as_str)
            .filter(|id| super::valid_dataset_id(id))
            .ok_or_else(|| AppError::Config("BigQuery returned an invalid dataset ID".into()))?;
        datasets.push(BigQueryDatasetSummary { id: id.into() });
    }
    datasets.sort_by(|left, right| left.id.cmp(&right.id));
    datasets.dedup_by(|left, right| left.id == right.id);
    Ok(datasets)
}

fn valid_account(value: &str) -> bool {
    value.len() <= 512
        && value.is_ascii()
        && value.contains('@')
        && value.bytes().all(|byte| byte.is_ascii_graphic())
}

fn valid_label(value: &str, maximum: usize) -> bool {
    !value.is_empty() && value.chars().count() <= maximum && !value.chars().any(char::is_control)
}

#[cfg(test)]
pub(super) fn assert_onboarding_contract() {
    let mut profile = ConnectionProfile {
        id: uuid::Uuid::new_v4(),
        name: "BigQuery onboarding".into(),
        engine: Engine::Bigquery,
        provider: Provider::Generic,
        driver_id: Some("google-bq-cli".into()),
        host: "campfire-460003".into(),
        port: 443,
        database: "analytics_2026".into(),
        username: String::new(),
        sslmode: "require".into(),
        extra_params: Default::default(),
        readonly_default: true,
        allow_writes: false,
        secret_ref: None,
        env: None,
        schema_group: None,
        workspace_access: WorkspaceConnectionAccess::Local,
        credential_mode: crate::model::WorkspaceCredentialMode::Local,
        provider_target: None,
    };
    assert_eq!(
        auth_mode(&profile).unwrap(),
        BigQueryAuthMode::GoogleAccount
    );
    profile
        .extra_params
        .insert(AUTH_MODE_PARAMETER.into(), SERVICE_ACCOUNT_MODE.into());
    assert_eq!(
        auth_mode(&profile).unwrap(),
        BigQueryAuthMode::ServiceAccount
    );
    assert!(uses_service_account_auth(&profile).unwrap());

    let auth = parse_auth_state(
        BigQueryAuthMode::GoogleAccount,
        &serde_json::json!([{"account":"member@example.com","status":"ACTIVE"}]),
    )
    .unwrap();
    assert!(auth.authenticated);
    assert_eq!(auth.account.as_deref(), Some("member@example.com"));
    assert_eq!(
        parse_projects(&serde_json::json!([
            {"projectId":"campfire-460003","name":"Campfire","lifecycleState":"ACTIVE"}
        ]))
        .unwrap()[0]
            .id,
        "campfire-460003"
    );
    assert_eq!(
        parse_datasets(
            &serde_json::json!([
                {"datasetReference":{"projectId":"campfire-460003","datasetId":"analytics_2026"}}
            ]),
            "campfire-460003",
        )
        .unwrap()[0]
            .id,
        "analytics_2026"
    );
}
