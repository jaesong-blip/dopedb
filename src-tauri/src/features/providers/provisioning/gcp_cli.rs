//! Strict, read-only Google Cloud CLI inventory for the GCP provisioner.
//!
//! This module intentionally does not implement [`super::application::ProvisioningDriver`]
//! yet. A partial adapter must not enter the production registry: #100 registers GCP
//! only after apply, verify, issue, reconcile, and owned destroy are all available.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::error::{AppError, AppResult};
use crate::model::Engine;

use super::super::domain::LocalProvider;
use super::application::{
    ProvisioningDriverStatus, ProvisioningPrerequisiteKind, ProvisioningReadiness,
};
use super::process::{
    ProvisioningCliCommand, ProvisioningCliEnvironment, ProvisioningCliOutputSchema,
    ProvisioningExecutableIdentity, ProvisioningProcessFailure,
};
use super::ProvisioningReadAuthority;

pub(super) const GCP_MANIFEST_SHA256: &str =
    "22af4b301e8fc8ac93bc2ed511a73b64f7f15015d8b5128fa78e84f80bed2bff";
const MINIMUM_GCLOUD_VERSION: &str = "500.0.0";
const MAX_TARGETS: usize = 256;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct GcloudDatabaseTarget {
    pub(super) account: String,
    pub(super) project: String,
    pub(super) region: String,
    pub(super) instance: String,
    pub(super) database: String,
    pub(super) connection_name: String,
    pub(super) engine: Engine,
    pub(super) production: Option<bool>,
    pub(super) iam_authentication_enabled: bool,
}

pub(super) struct GcloudExactTarget<'a> {
    pub(super) project: &'a str,
    pub(super) instance: &'a str,
    pub(super) database: &'a str,
    pub(super) engine: Engine,
    pub(super) production: bool,
}

#[derive(Clone)]
pub(super) struct GcloudInventory {
    executable: ProvisioningExecutableIdentity,
    environment: Vec<ProvisioningCliEnvironment>,
}

impl GcloudInventory {
    pub(super) async fn locate() -> Result<Option<Self>, ProvisioningProcessFailure> {
        let Some((root, executable)) = gcloud_candidates()
            .into_iter()
            .find(|(_, executable)| executable.is_file())
        else {
            return Ok(None);
        };
        let executable = ProvisioningExecutableIdentity::audit(
            LocalProvider::GcpCloudSql,
            &executable,
            &[root],
            &["gcloud"],
        )
        .await?;
        let home = dirs::home_dir().ok_or(ProvisioningProcessFailure::ExecutableRejected)?;
        let config = home.join(".config/gcloud");
        let home = safe_path_text(&home)?;
        let config = safe_path_text(&config)?;
        Ok(Some(Self {
            executable,
            environment: vec![
                ProvisioningCliEnvironment::SafePath,
                ProvisioningCliEnvironment::Home(home),
                ProvisioningCliEnvironment::CloudSdkConfig(config),
                ProvisioningCliEnvironment::CloudSdkDisablePrompts,
                ProvisioningCliEnvironment::CloudSdkDisableUsageReporting,
                ProvisioningCliEnvironment::CloudSdkLogHttpOff,
            ],
        }))
    }

    pub(super) async fn detect(
        authority: &ProvisioningReadAuthority,
        expected_account: Option<&str>,
        cancellation: &CancellationToken,
    ) -> AppResult<ProvisioningDriverStatus> {
        let Some(inventory) = Self::locate().await.map_err(process_error)? else {
            return Ok(status(None, None, ProvisioningReadiness::Missing));
        };
        inventory
            .detect_with_inventory(authority, expected_account, cancellation)
            .await
    }

    async fn detect_with_inventory(
        &self,
        authority: &ProvisioningReadAuthority,
        expected_account: Option<&str>,
        cancellation: &CancellationToken,
    ) -> AppResult<ProvisioningDriverStatus> {
        ensure_authority(authority)?;
        let version = self
            .run(
                vec!["version".into(), "--format=json".into(), "--quiet".into()],
                ProvisioningCliOutputSchema::JsonObject,
                authority,
                cancellation,
            )
            .await?;
        let version = parse_version(version.value())?;
        if compare_versions(&version, MINIMUM_GCLOUD_VERSION)? == std::cmp::Ordering::Less {
            return Ok(status(Some(version), None, ProvisioningReadiness::Outdated));
        }
        let config = self
            .run(
                vec![
                    "config".into(),
                    "list".into(),
                    "--format=json(core.account,core.project)".into(),
                    "--quiet".into(),
                ],
                ProvisioningCliOutputSchema::JsonObject,
                authority,
                cancellation,
            )
            .await?;
        let config = parse_config(config.value())?;
        let Some(account) = config.account else {
            return Ok(status(
                Some(version),
                None,
                ProvisioningReadiness::LoggedOut,
            ));
        };
        let readiness = if expected_account.is_some_and(|expected| expected != account) {
            ProvisioningReadiness::WrongAccount
        } else {
            ProvisioningReadiness::Ready
        };
        Ok(status(Some(version), Some(account), readiness))
    }

    pub(super) async fn discover_current_project(
        &self,
        authority: &ProvisioningReadAuthority,
        expected_account: Option<&str>,
        cancellation: &CancellationToken,
    ) -> AppResult<Vec<GcloudDatabaseTarget>> {
        ensure_authority(authority)?;
        let config = self
            .run(
                vec![
                    "config".into(),
                    "list".into(),
                    "--format=json(core.account,core.project)".into(),
                    "--quiet".into(),
                ],
                ProvisioningCliOutputSchema::JsonObject,
                authority,
                cancellation,
            )
            .await?;
        let config = parse_config(config.value())?;
        let account = config
            .account
            .filter(|account| expected_account.is_none_or(|expected| expected == account))
            .ok_or_else(|| {
                blocked("gcloud active account does not match the provisioning account")
            })?;
        let project = config
            .project
            .ok_or_else(|| blocked("gcloud has no active project"))?;
        let instances = self
            .run(
                vec![
                    "sql".into(),
                    "instances".into(),
                    "list".into(),
                    format!("--project={project}"),
                    format!("--limit={}", MAX_TARGETS + 1),
                    "--format=json(name,project,region,databaseVersion,state,settings.databaseFlags,settings.userLabels,connectionName)".into(),
                    "--quiet".into(),
                ],
                ProvisioningCliOutputSchema::JsonArray,
                authority,
                cancellation,
            )
            .await?;
        let instances = parse_instances(instances.value(), &project)?;
        let mut targets = Vec::new();
        for instance in instances {
            let databases = self
                .run(
                    vec![
                        "sql".into(),
                        "databases".into(),
                        "list".into(),
                        format!("--project={project}"),
                        format!("--instance={}", instance.name),
                        format!("--limit={}", MAX_TARGETS + 1),
                        "--format=json(name,instance,project)".into(),
                        "--quiet".into(),
                    ],
                    ProvisioningCliOutputSchema::JsonArray,
                    authority,
                    cancellation,
                )
                .await?;
            for database in parse_databases(databases.value(), &project, &instance.name)? {
                if targets.len() == MAX_TARGETS {
                    return Err(blocked("gcloud target inventory is too large"));
                }
                targets.push(GcloudDatabaseTarget {
                    account: account.clone(),
                    project: project.clone(),
                    region: instance.region.clone(),
                    instance: instance.name.clone(),
                    database,
                    connection_name: instance.connection_name.clone(),
                    engine: instance.engine,
                    production: instance.production,
                    iam_authentication_enabled: instance.iam_authentication_enabled,
                });
            }
        }
        Ok(targets)
    }

    pub(super) async fn discover_exact(
        &self,
        authority: &ProvisioningReadAuthority,
        expected: GcloudExactTarget<'_>,
        cancellation: &CancellationToken,
    ) -> AppResult<GcloudDatabaseTarget> {
        let status = self
            .detect_with_inventory(authority, None, cancellation)
            .await?;
        if status.readiness != ProvisioningReadiness::Ready {
            return Err(blocked("Google Cloud CLI is not ready for discovery"));
        }
        let targets = self
            .discover_current_project(authority, None, cancellation)
            .await?;
        let mut exact = targets.into_iter().filter(|target| {
            target.project == expected.project
                && target.instance == expected.instance
                && target.database == expected.database
                && target.engine == expected.engine
        });
        let target = exact
            .next()
            .ok_or_else(|| blocked("gcloud target does not match the workspace authority"))?;
        if exact.next().is_some()
            || target.production != Some(expected.production)
            || !target.iam_authentication_enabled
        {
            return Err(blocked(
                "gcloud target policy does not match the workspace authority",
            ));
        }
        Ok(target)
    }

    async fn run(
        &self,
        argv: Vec<String>,
        schema: ProvisioningCliOutputSchema,
        authority: &ProvisioningReadAuthority,
        cancellation: &CancellationToken,
    ) -> AppResult<super::process::ProvisioningCliOutput> {
        let command = ProvisioningCliCommand::new(
            LocalProvider::GcpCloudSql,
            self.executable.clone(),
            argv,
            self.environment.clone(),
            schema,
            COMMAND_TIMEOUT,
        )
        .map_err(process_error)?;
        command
            .run_read_only(authority, cancellation)
            .await
            .map_err(process_error)
    }
}

fn status(
    installed_version: Option<String>,
    active_account: Option<String>,
    readiness: ProvisioningReadiness,
) -> ProvisioningDriverStatus {
    ProvisioningDriverStatus {
        provider: LocalProvider::GcpCloudSql,
        prerequisite_kind: ProvisioningPrerequisiteKind::OfficialCli,
        prerequisite_name: "Google Cloud CLI".into(),
        minimum_version: Some(MINIMUM_GCLOUD_VERSION.into()),
        installed_version,
        active_identity: active_account,
        readiness,
    }
}

fn ensure_authority(authority: &ProvisioningReadAuthority) -> AppResult<()> {
    if authority.provider != LocalProvider::GcpCloudSql
        || authority.manifest_sha256 != GCP_MANIFEST_SHA256
    {
        return Err(blocked("gcloud discovery authority is invalid"));
    }
    Ok(())
}

fn gcloud_candidates() -> Vec<(PathBuf, PathBuf)> {
    let mut roots = Vec::new();
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join("google-cloud-sdk"));
    }
    roots.extend([
        PathBuf::from("/usr/lib/google-cloud-sdk"),
        PathBuf::from("/opt/google-cloud-sdk"),
        PathBuf::from("/usr/local/google-cloud-sdk"),
        PathBuf::from("/opt/homebrew/share/google-cloud-sdk"),
        PathBuf::from("/opt/homebrew/Caskroom/google-cloud-sdk/latest/google-cloud-sdk"),
        PathBuf::from("/usr/local/Caskroom/google-cloud-sdk/latest/google-cloud-sdk"),
    ]);
    roots
        .into_iter()
        .map(|root| {
            let executable = root.join("bin/gcloud");
            (root, executable)
        })
        .collect()
}

fn safe_path_text(path: &Path) -> Result<String, ProvisioningProcessFailure> {
    path.to_str()
        .filter(|value| path.is_absolute() && !value.chars().any(char::is_control))
        .map(str::to_owned)
        .ok_or(ProvisioningProcessFailure::ExecutableRejected)
}

fn parse_version(value: &Value) -> AppResult<String> {
    let object = value
        .as_object()
        .ok_or_else(|| blocked("gcloud version output is invalid"))?;
    if object.len() > 32
        || object.values().any(|value| {
            !value.as_str().is_some_and(|text| {
                !text.is_empty() && text.len() <= 128 && !text.chars().any(char::is_control)
            })
        })
    {
        return Err(blocked("gcloud version output is invalid"));
    }
    let version = object
        .get("Google Cloud SDK")
        .and_then(Value::as_str)
        .ok_or_else(|| blocked("gcloud version output is invalid"))?;
    parse_version_parts(version)?;
    Ok(version.into())
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawConfig {
    core: Option<RawCoreConfig>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawCoreConfig {
    account: Option<String>,
    project: Option<String>,
}

struct ParsedConfig {
    account: Option<String>,
    project: Option<String>,
}

fn parse_config(value: &Value) -> AppResult<ParsedConfig> {
    let raw: RawConfig = serde_json::from_value(value.clone())
        .map_err(|_| blocked("gcloud configuration output is invalid"))?;
    let core = raw.core.unwrap_or(RawCoreConfig {
        account: None,
        project: None,
    });
    if core
        .account
        .as_deref()
        .is_some_and(|value| !valid_account(value))
        || core
            .project
            .as_deref()
            .is_some_and(|value| !valid_project(value))
    {
        return Err(blocked("gcloud configuration output is invalid"));
    }
    Ok(ParsedConfig {
        account: core.account,
        project: core.project,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawInstance {
    connection_name: String,
    database_version: String,
    name: String,
    project: String,
    region: String,
    settings: Option<RawInstanceSettings>,
    state: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawInstanceSettings {
    #[serde(default)]
    database_flags: Vec<RawDatabaseFlag>,
    #[serde(default)]
    user_labels: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawDatabaseFlag {
    name: String,
    value: String,
}

struct ParsedInstance {
    name: String,
    region: String,
    connection_name: String,
    engine: Engine,
    production: Option<bool>,
    iam_authentication_enabled: bool,
}

fn parse_instances(value: &Value, expected_project: &str) -> AppResult<Vec<ParsedInstance>> {
    let raw: Vec<RawInstance> = serde_json::from_value(value.clone())
        .map_err(|_| blocked("gcloud instance output is invalid"))?;
    if raw.len() > MAX_TARGETS {
        return Err(blocked("gcloud instance inventory is too large"));
    }
    raw.into_iter()
        .filter(|instance| instance.state == "RUNNABLE")
        .map(|instance| {
            if instance.project != expected_project
                || !valid_identifier(&instance.name, 98)
                || !valid_region(&instance.region)
                || instance.connection_name
                    != format!("{}:{}:{}", instance.project, instance.region, instance.name)
            {
                return Err(blocked("gcloud instance output is invalid"));
            }
            let engine = if instance.database_version.starts_with("POSTGRES_") {
                Engine::Postgres
            } else if instance.database_version.starts_with("MYSQL_") {
                Engine::Mysql
            } else {
                return Err(blocked("gcloud instance engine is unsupported"));
            };
            let settings = instance.settings.unwrap_or_default();
            if settings.database_flags.len() > 256
                || settings.user_labels.len() > 64
                || settings
                    .database_flags
                    .iter()
                    .any(|flag| !valid_label(&flag.name, 128) || !valid_label(&flag.value, 128))
                || settings
                    .user_labels
                    .iter()
                    .any(|(key, value)| !valid_label(key, 63) || !valid_label(value, 63))
            {
                return Err(blocked("gcloud instance settings are invalid"));
            }
            let environment = settings
                .user_labels
                .get("environment")
                .or_else(|| settings.user_labels.get("env"))
                .map(|value| value.to_ascii_lowercase());
            let production = match environment.as_deref() {
                Some("production" | "prod") => Some(true),
                Some("development" | "dev" | "staging" | "stage" | "test") => Some(false),
                _ => None,
            };
            let iam_flag = match engine {
                Engine::Postgres => "cloudsql.iam_authentication",
                Engine::Mysql => "cloudsql_iam_authentication",
                _ => return Err(blocked("gcloud instance engine is unsupported")),
            };
            let iam_authentication_enabled = settings.database_flags.iter().any(|flag| {
                flag.name == iam_flag
                    && matches!(
                        flag.value.to_ascii_lowercase().as_str(),
                        "on" | "true" | "1"
                    )
            });
            Ok(ParsedInstance {
                name: instance.name,
                region: instance.region,
                connection_name: instance.connection_name,
                engine,
                production,
                iam_authentication_enabled,
            })
        })
        .collect()
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawDatabase {
    instance: String,
    name: String,
    project: String,
}

fn parse_databases(value: &Value, project: &str, instance: &str) -> AppResult<Vec<String>> {
    let raw: Vec<RawDatabase> = serde_json::from_value(value.clone())
        .map_err(|_| blocked("gcloud database output is invalid"))?;
    if raw.len() > MAX_TARGETS {
        return Err(blocked("gcloud database inventory is too large"));
    }
    raw.into_iter()
        .filter(|database| !system_database(&database.name))
        .map(|database| {
            if database.project != project
                || database.instance != instance
                || !valid_database(&database.name)
            {
                return Err(blocked("gcloud database output is invalid"));
            }
            Ok(database.name)
        })
        .collect()
}

fn compare_versions(left: &str, right: &str) -> AppResult<std::cmp::Ordering> {
    Ok(parse_version_parts(left)?.cmp(&parse_version_parts(right)?))
}

fn parse_version_parts(value: &str) -> AppResult<[u32; 3]> {
    let mut parts = value.split('.');
    let parsed = [
        parts.next().and_then(|value| value.parse().ok()),
        parts.next().and_then(|value| value.parse().ok()),
        parts.next().and_then(|value| value.parse().ok()),
    ];
    if parts.next().is_some() || parsed.iter().any(Option::is_none) {
        return Err(blocked("gcloud version output is invalid"));
    }
    Ok(parsed.map(Option::unwrap))
}

fn valid_account(value: &str) -> bool {
    value.len() <= 320
        && value.contains('@')
        && value.is_ascii()
        && !value.chars().any(char::is_whitespace)
}

fn valid_project(value: &str) -> bool {
    (6..=30).contains(&value.len())
        && value.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && value
            .as_bytes()
            .last()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn valid_region(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn valid_identifier(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn valid_database(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.is_ascii()
        && !value.chars().any(char::is_control)
        && !value.chars().any(char::is_whitespace)
}

fn valid_label(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value.is_ascii()
        && !value.chars().any(char::is_control)
}

fn system_database(value: &str) -> bool {
    matches!(
        value,
        "postgres"
            | "template0"
            | "template1"
            | "mysql"
            | "information_schema"
            | "performance_schema"
            | "sys"
    )
}

fn process_error(_: ProvisioningProcessFailure) -> AppError {
    blocked("gcloud command failed its audited execution boundary")
}

fn blocked(reason: &'static str) -> AppError {
    AppError::Blocked {
        reason: reason.into(),
    }
}

#[cfg(test)]
pub(crate) fn assert_gcloud_cli_contract() {
    let version = serde_json::json!({
        "Google Cloud SDK": "562.0.0",
        "core": "2026.03.23"
    });
    assert_eq!(parse_version(&version).unwrap(), "562.0.0");
    assert_eq!(
        compare_versions("499.0.0", MINIMUM_GCLOUD_VERSION).unwrap(),
        std::cmp::Ordering::Less
    );
    assert!(parse_version(&serde_json::json!({
        "Google Cloud SDK": "562.0.0",
        "unexpected": {"secret": "value"}
    }))
    .is_err());

    let config = parse_config(&serde_json::json!({
        "core": {
            "account": "owner@example.com",
            "project": "sample-project-123"
        }
    }))
    .unwrap();
    assert_eq!(config.account.as_deref(), Some("owner@example.com"));
    assert_eq!(config.project.as_deref(), Some("sample-project-123"));
    assert!(parse_config(&serde_json::json!({
        "core": {"account": "owner@example.com", "project": "sample-project-123"},
        "credential": "must-not-project"
    }))
    .is_err());

    let instances = parse_instances(
        &serde_json::json!([{
            "connectionName": "sample-project-123:asia-northeast3:app-db",
            "databaseVersion": "POSTGRES_17",
            "name": "app-db",
            "project": "sample-project-123",
            "region": "asia-northeast3",
            "settings": {
                "databaseFlags": [{"name": "cloudsql.iam_authentication", "value": "on"}],
                "userLabels": {"environment": "production"}
            },
            "state": "RUNNABLE"
        }]),
        "sample-project-123",
    )
    .unwrap();
    assert_eq!(instances.len(), 1);
    assert_eq!(instances[0].engine, Engine::Postgres);
    assert_eq!(instances[0].production, Some(true));
    assert!(instances[0].iam_authentication_enabled);
    let mysql = parse_instances(
        &serde_json::json!([{
            "connectionName": "sample-project-123:us-central1:mysql-db",
            "databaseVersion": "MYSQL_8_0",
            "name": "mysql-db",
            "project": "sample-project-123",
            "region": "us-central1",
            "settings": {
                "databaseFlags": [{"name": "cloudsql_iam_authentication", "value": "on"}],
                "userLabels": {"environment": "development"}
            },
            "state": "RUNNABLE"
        }]),
        "sample-project-123",
    )
    .unwrap();
    assert_eq!(mysql[0].engine, Engine::Mysql);
    assert_eq!(mysql[0].production, Some(false));
    assert!(mysql[0].iam_authentication_enabled);

    let databases = parse_databases(
        &serde_json::json!([
            {"instance": "app-db", "name": "app", "project": "sample-project-123"},
            {"instance": "app-db", "name": "postgres", "project": "sample-project-123"}
        ]),
        "sample-project-123",
        "app-db",
    )
    .unwrap();
    assert_eq!(databases, vec!["app"]);
    assert!(parse_databases(
        &serde_json::json!([{
            "instance": "other-db",
            "name": "app",
            "project": "sample-project-123"
        }]),
        "sample-project-123",
        "app-db",
    )
    .is_err());
}

#[cfg(test)]
pub(crate) async fn assert_live_gcloud_inventory() {
    if std::env::var_os("DOPEDB_LIVE_GCLOUD_INVENTORY").is_none() {
        return;
    }
    let authority =
        ProvisioningReadAuthority::issue(LocalProvider::GcpCloudSql, GCP_MANIFEST_SHA256.into());
    let cancellation = CancellationToken::new();
    let inventory = GcloudInventory::locate()
        .await
        .expect("audit local gcloud")
        .expect("local gcloud is installed");
    let status = inventory
        .detect_with_inventory(&authority, None, &cancellation)
        .await
        .expect("detect local gcloud account");
    assert_eq!(status.readiness, ProvisioningReadiness::Ready);
    assert!(status.active_identity.is_some());
    let targets = inventory
        .discover_current_project(&authority, status.active_identity.as_deref(), &cancellation)
        .await
        .expect("discover strict local Cloud SQL inventory");
    assert!(!targets.is_empty());
    assert!(targets.iter().all(|target| {
        valid_project(&target.project)
            && !target.account.is_empty()
            && !target.region.is_empty()
            && !target.instance.is_empty()
            && !target.database.is_empty()
            && !target.connection_name.is_empty()
    }));
}
