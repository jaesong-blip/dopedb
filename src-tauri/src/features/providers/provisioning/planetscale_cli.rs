//! Strict, read-only PlanetScale CLI inventory for the PlanetScale provisioner.
//!
//! Runtime credentials are never issued through this boundary. The official
//! `pscale` CLI is used only to prove that the user's local OAuth session can see
//! the exact hosted-authority target. Apply, cleanup, and credential issuance stay
//! behind the approved plan and server-owned Provider authority.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Map, Value};
use tokio_util::sync::CancellationToken;

use crate::error::{AppError, AppResult};
use crate::model::Engine;

use super::super::domain::LocalProvider;
use super::application::{
    ProvisioningDriverStatus, ProvisioningPrerequisiteKind, ProvisioningReadiness,
};
use super::process::{
    ProvisioningCliCommand, ProvisioningCliEnvironment, ProvisioningCliOutput,
    ProvisioningCliOutputSchema, ProvisioningExecutableIdentity, ProvisioningProcessFailure,
};
use super::ProvisioningReadAuthority;

pub(super) const PLANETSCALE_MANIFEST_SHA256: &str =
    "03ec80011995764e16563fefbe987608d08c27803fac7cfa49c68d79f455ec3b";
const MINIMUM_PSCALE_VERSION: &str = "0.308.0";
const OFFICIAL_API_URL: &str = "https://api.planetscale.com";
const MAX_TARGETS: usize = 256;
const MAX_OBJECT_FIELDS: usize = 96;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct PlanetScaleDatabaseTarget {
    pub(super) organization: String,
    pub(super) database: String,
    pub(super) branch: String,
    pub(super) branch_id: String,
    pub(super) engine: Engine,
    pub(super) production: bool,
    pub(super) safe_migrations: Option<bool>,
}

#[derive(Clone)]
pub(super) struct PlanetScaleInventory {
    executable: ProvisioningExecutableIdentity,
    environment: Vec<ProvisioningCliEnvironment>,
    config_file: Option<String>,
}

impl PlanetScaleInventory {
    pub(super) async fn locate() -> Result<Option<Self>, ProvisioningProcessFailure> {
        let Some((root, executable)) = pscale_candidates()
            .into_iter()
            .find(|(_, executable)| executable.is_file())
        else {
            return Ok(None);
        };
        let executable = ProvisioningExecutableIdentity::audit(
            LocalProvider::PlanetScale,
            &executable,
            &[root],
            if cfg!(windows) {
                &["pscale.exe"]
            } else {
                &["pscale"]
            },
        )
        .await?;
        let home = crate::app_paths::optional_home_dir()
            .ok_or(ProvisioningProcessFailure::ExecutableRejected)?;
        let config = home.join(".config/planetscale/pscale.yml");
        let home = safe_path_text(&home)?;
        let config_file = config
            .is_file()
            .then(|| safe_path_text(&config))
            .transpose()?;
        Ok(Some(Self {
            executable,
            environment: vec![
                ProvisioningCliEnvironment::SafePath,
                ProvisioningCliEnvironment::Home(home),
                ProvisioningCliEnvironment::PlanetScaleNoUpdateNotifier,
            ],
            config_file,
        }))
    }

    pub(super) async fn detect(
        authority: &ProvisioningReadAuthority,
        cancellation: &CancellationToken,
    ) -> AppResult<ProvisioningDriverStatus> {
        let Some(inventory) = Self::locate().await.map_err(process_error)? else {
            return Ok(status(None, None, ProvisioningReadiness::Missing));
        };
        inventory
            .detect_with_inventory(authority, cancellation)
            .await
    }

    async fn detect_with_inventory(
        &self,
        authority: &ProvisioningReadAuthority,
        cancellation: &CancellationToken,
    ) -> AppResult<ProvisioningDriverStatus> {
        ensure_authority(authority)?;
        let version = self
            .run(
                vec!["version".into()],
                ProvisioningCliOutputSchema::JsonObject,
                authority,
                cancellation,
                false,
            )
            .await?;
        let version = parse_version(version.value())?;
        if compare_versions(&version, MINIMUM_PSCALE_VERSION)? == std::cmp::Ordering::Less {
            return Ok(status(Some(version), None, ProvisioningReadiness::Outdated));
        }

        let auth = self
            .run(
                vec!["auth".into(), "check".into()],
                ProvisioningCliOutputSchema::JsonObject,
                authority,
                cancellation,
                true,
            )
            .await?;
        let auth = parse_auth_check(auth.value())?;
        if !auth.authenticated {
            return Ok(status(
                Some(version),
                None,
                ProvisioningReadiness::LoggedOut,
            ));
        }
        if auth.auth_method != "oauth" {
            return Ok(status(
                Some(version),
                Some("PlanetScale service token".into()),
                ProvisioningReadiness::WrongAccount,
            ));
        }
        Ok(status(
            Some(version),
            Some(
                auth.organization
                    .unwrap_or_else(|| "PlanetScale OAuth".into()),
            ),
            ProvisioningReadiness::Ready,
        ))
    }

    pub(super) async fn discover_exact(
        &self,
        authority: &ProvisioningReadAuthority,
        expected_organization: &str,
        expected_database: &str,
        expected_branch: &str,
        expected_engine: Engine,
        expected_production: bool,
        cancellation: &CancellationToken,
    ) -> AppResult<PlanetScaleDatabaseTarget> {
        ensure_authority(authority)?;
        for value in [expected_organization, expected_database, expected_branch] {
            if !valid_segment(value) {
                return Err(blocked("PlanetScale target identifier is invalid"));
            }
        }
        if !matches!(expected_engine, Engine::Postgres | Engine::Mysql) {
            return Err(blocked("PlanetScale target engine is invalid"));
        }

        // Discovery is an independently callable boundary. Never rely on a
        // previous UI status check to enforce the audited CLI version or OAuth
        // authentication mode.
        let version = self
            .run(
                vec!["version".into()],
                ProvisioningCliOutputSchema::JsonObject,
                authority,
                cancellation,
                false,
            )
            .await?;
        let version = parse_version(version.value())?;
        if compare_versions(&version, MINIMUM_PSCALE_VERSION)? == std::cmp::Ordering::Less {
            return Err(blocked("PlanetScale CLI must be updated before discovery"));
        }
        let auth = self
            .run(
                vec!["auth".into(), "check".into()],
                ProvisioningCliOutputSchema::JsonObject,
                authority,
                cancellation,
                true,
            )
            .await?;
        let auth = parse_auth_check(auth.value())?;
        if !auth.authenticated || auth.auth_method != "oauth" {
            return Err(blocked(
                "PlanetScale discovery requires the user's local OAuth login",
            ));
        }

        let organizations = self
            .run(
                vec!["org".into(), "list".into()],
                ProvisioningCliOutputSchema::JsonArray,
                authority,
                cancellation,
                false,
            )
            .await?;
        let organizations = parse_organizations(organizations.value())?;
        if !organizations
            .iter()
            .any(|organization| organization.name == expected_organization)
        {
            return Err(blocked(
                "PlanetScale CLI OAuth account cannot see the managed organization",
            ));
        }

        let database = self
            .run(
                vec![
                    "database".into(),
                    "show".into(),
                    expected_database.into(),
                    "--org".into(),
                    expected_organization.into(),
                ],
                ProvisioningCliOutputSchema::JsonObject,
                authority,
                cancellation,
                false,
            )
            .await?;
        let database = parse_database(database.value())?;
        if database.name != expected_database
            || database.engine != expected_engine
            || database.state != "ready"
        {
            return Err(blocked(
                "PlanetScale CLI database does not match the managed target",
            ));
        }

        let branch = self
            .run(
                vec![
                    "branch".into(),
                    "show".into(),
                    expected_database.into(),
                    expected_branch.into(),
                    "--org".into(),
                    expected_organization.into(),
                ],
                ProvisioningCliOutputSchema::JsonObject,
                authority,
                cancellation,
                false,
            )
            .await?;
        let branch = parse_branch(branch.value(), expected_engine)?;
        if branch.name != expected_branch
            || !branch.ready
            || branch.production != expected_production
        {
            return Err(blocked(
                "PlanetScale CLI branch does not match the managed target",
            ));
        }
        Ok(PlanetScaleDatabaseTarget {
            organization: expected_organization.into(),
            database: expected_database.into(),
            branch: expected_branch.into(),
            branch_id: branch.id.clone(),
            engine: expected_engine,
            production: expected_production,
            safe_migrations: branch.safe_migrations,
        })
    }

    async fn run(
        &self,
        mut argv: Vec<String>,
        schema: ProvisioningCliOutputSchema,
        authority: &ProvisioningReadAuthority,
        cancellation: &CancellationToken,
        accepts_action_required: bool,
    ) -> AppResult<ProvisioningCliOutput> {
        let mut prefix = Vec::with_capacity(3 + argv.len());
        if let Some(config_file) = &self.config_file {
            prefix.push(format!("--config={config_file}"));
        }
        prefix.push("--format=json".into());
        prefix.push("--no-color".into());
        prefix.append(&mut argv);
        let command = ProvisioningCliCommand::new(
            LocalProvider::PlanetScale,
            self.executable.clone(),
            prefix,
            self.environment.clone(),
            schema,
            COMMAND_TIMEOUT,
        )
        .and_then(|command| {
            if accepts_action_required {
                command.with_accepted_exit_codes([0, 1])
            } else {
                Ok(command)
            }
        })
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
        provider: LocalProvider::PlanetScale,
        prerequisite_kind: ProvisioningPrerequisiteKind::OfficialCli,
        prerequisite_name: "PlanetScale CLI".into(),
        minimum_version: Some(MINIMUM_PSCALE_VERSION.into()),
        installed_version,
        active_identity: active_account,
        readiness,
    }
}

fn ensure_authority(authority: &ProvisioningReadAuthority) -> AppResult<()> {
    if authority.provider != LocalProvider::PlanetScale
        || authority.manifest_sha256 != PLANETSCALE_MANIFEST_SHA256
    {
        return Err(blocked("PlanetScale discovery authority is invalid"));
    }
    Ok(())
}

fn pscale_candidates() -> Vec<(PathBuf, PathBuf)> {
    let mut candidates = Vec::new();
    if let Some(home) = crate::app_paths::optional_home_dir() {
        let local = home.join(".local");
        candidates.push((local.clone(), local.join("bin/pscale")));
        let bin = home.join("bin");
        candidates.push((bin.clone(), bin.join("pscale")));
    }
    #[cfg(all(windows, feature = "packaged-benchmark"))]
    if let Ok(local) = crate::app_paths::data_root() {
        let root = local.join("programs-planetscale");
        candidates.push((root.clone(), root.join("pscale.exe")));
    }
    #[cfg(all(windows, not(feature = "packaged-benchmark")))]
    if let Some(local) = dirs::data_local_dir() {
        let root = local.join("Programs/PlanetScale");
        candidates.push((root.clone(), root.join("pscale.exe")));
    }
    #[cfg(not(windows))]
    candidates.extend([
        (
            PathBuf::from("/opt/homebrew"),
            PathBuf::from("/opt/homebrew/bin/pscale"),
        ),
        (
            PathBuf::from("/usr/local"),
            PathBuf::from("/usr/local/bin/pscale"),
        ),
        (PathBuf::from("/usr"), PathBuf::from("/usr/bin/pscale")),
    ]);
    candidates
}

fn safe_path_text(path: &Path) -> Result<String, ProvisioningProcessFailure> {
    path.to_str()
        .filter(|value| path.is_absolute() && !value.chars().any(char::is_control))
        .map(str::to_owned)
        .ok_or(ProvisioningProcessFailure::ExecutableRejected)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawVersion {
    version: String,
    commit: String,
    build_date: String,
}

fn parse_version(value: &Value) -> AppResult<String> {
    let value: RawVersion = serde_json::from_value(value.clone())
        .map_err(|_| blocked("PlanetScale version output is invalid"))?;
    let version = value.version.strip_prefix('v').unwrap_or(&value.version);
    parse_version_parts(version)?;
    if !safe_text(&value.commit, 128) || !safe_text(&value.build_date, 128) {
        return Err(blocked("PlanetScale version output is invalid"));
    }
    Ok(version.into())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawAuthIssue {
    code: String,
    message: String,
    remediation: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawAuthCheck {
    status: String,
    authenticated: bool,
    #[serde(default)]
    auth_method: String,
    organization: Option<String>,
    api_url: Option<String>,
    agent_guide_command: Option<String>,
    #[serde(default)]
    issues: Vec<RawAuthIssue>,
    #[serde(default)]
    next_steps: Vec<String>,
}

struct ParsedAuthCheck {
    authenticated: bool,
    auth_method: String,
    organization: Option<String>,
}

fn parse_auth_check(value: &Value) -> AppResult<ParsedAuthCheck> {
    let value: RawAuthCheck = serde_json::from_value(value.clone())
        .map_err(|_| blocked("PlanetScale authentication output is invalid"))?;
    if !matches!(value.status.as_str(), "ok" | "action_required")
        || !matches!(
            value.auth_method.as_str(),
            "oauth" | "service_token" | "none"
        )
        || value.api_url.as_deref() != Some(OFFICIAL_API_URL)
        || value.agent_guide_command.as_deref() != Some("pscale agent-guide --format json")
        || value.issues.len() > 16
        || value.next_steps.len() > 16
        || value.issues.iter().any(|issue| {
            !safe_text(&issue.code, 64)
                || !safe_text(&issue.message, 512)
                || issue
                    .remediation
                    .as_deref()
                    .is_some_and(|text| !safe_text(text, 512))
        })
        || value.next_steps.iter().any(|step| !safe_text(step, 512))
        || value
            .organization
            .as_deref()
            .is_some_and(|organization| !valid_segment(organization))
        || (value.authenticated && (value.status != "ok" && value.organization.is_some()))
        || (value.authenticated && value.auth_method == "none")
        || (!value.authenticated && value.status == "ok")
    {
        return Err(blocked("PlanetScale authentication output is invalid"));
    }
    Ok(ParsedAuthCheck {
        authenticated: value.authenticated,
        auth_method: value.auth_method,
        organization: value.organization,
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawOrganization {
    name: String,
    created_at: i64,
    updated_at: i64,
    current: bool,
}

fn parse_organizations(value: &Value) -> AppResult<Vec<RawOrganization>> {
    let values: Vec<RawOrganization> = serde_json::from_value(value.clone())
        .map_err(|_| blocked("PlanetScale organization output is invalid"))?;
    if values.is_empty()
        || values.len() > MAX_TARGETS
        || values.iter().any(|organization| {
            !valid_segment(&organization.name)
                || organization.created_at < 0
                || organization.updated_at < organization.created_at
        })
        || values
            .iter()
            .filter(|organization| organization.current)
            .count()
            > 1
    {
        return Err(blocked("PlanetScale organization output is invalid"));
    }
    Ok(values)
}

struct ParsedDatabase {
    name: String,
    engine: Engine,
    state: String,
}

fn parse_database(value: &Value) -> AppResult<ParsedDatabase> {
    let object = bounded_provider_object(value, "PlanetScale database output is invalid")?;
    let name = required_segment(object, "name", "PlanetScale database output is invalid")?;
    let engine = match required_text(object, "kind", 32)? {
        "postgresql" | "postgres" => Engine::Postgres,
        "mysql" => Engine::Mysql,
        _ => return Err(blocked("PlanetScale database engine is unsupported")),
    };
    let state = required_text(object, "state", 32)?;
    if !matches!(
        state,
        "ready" | "pending" | "importing" | "awakening" | "sleep_in_progress" | "sleeping"
    ) {
        return Err(blocked("PlanetScale database output is invalid"));
    }
    Ok(ParsedDatabase {
        name: name.into(),
        engine,
        state: state.into(),
    })
}

struct ParsedBranch {
    id: String,
    name: String,
    production: bool,
    ready: bool,
    safe_migrations: Option<bool>,
}

fn parse_branch(value: &Value, engine: Engine) -> AppResult<ParsedBranch> {
    let object = bounded_provider_object(value, "PlanetScale branch output is invalid")?;
    let id = required_segment(object, "id", "PlanetScale branch output is invalid")?;
    let name = required_segment(object, "name", "PlanetScale branch output is invalid")?;
    let production = required_bool(object, "production")?;
    let ready = required_bool(object, "ready")?;
    let safe_migrations = object
        .get("safe_migrations")
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| blocked("PlanetScale branch output is invalid"))
        })
        .transpose()?;
    if (engine == Engine::Mysql && safe_migrations.is_none())
        || (engine == Engine::Postgres && safe_migrations.is_some())
    {
        return Err(blocked("PlanetScale branch engine output is invalid"));
    }
    Ok(ParsedBranch {
        id: id.into(),
        name: name.into(),
        production,
        ready,
        safe_migrations,
    })
}

fn bounded_provider_object<'a>(
    value: &'a Value,
    reason: &'static str,
) -> AppResult<&'a Map<String, Value>> {
    let object = value.as_object().ok_or_else(|| blocked(reason))?;
    if object.is_empty()
        || object.len() > MAX_OBJECT_FIELDS
        || object.keys().any(|key| {
            key.is_empty()
                || key.len() > 128
                || key.chars().any(char::is_control)
                || sensitive_key(key)
        })
    {
        return Err(blocked(reason));
    }
    Ok(object)
}

fn sensitive_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    [
        "token",
        "secret",
        "password",
        "credential",
        "private_key",
        "access_key",
    ]
    .iter()
    .any(|part| key.contains(part))
}

fn required_segment<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    reason: &'static str,
) -> AppResult<&'a str> {
    let value = required_text(object, field, 128)?;
    valid_segment(value)
        .then_some(value)
        .ok_or_else(|| blocked(reason))
}

fn required_text<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    max: usize,
) -> AppResult<&'a str> {
    object
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| safe_text(value, max))
        .ok_or_else(|| blocked("PlanetScale CLI output is invalid"))
}

fn required_bool(object: &Map<String, Value>, field: &str) -> AppResult<bool> {
    object
        .get(field)
        .and_then(Value::as_bool)
        .ok_or_else(|| blocked("PlanetScale CLI output is invalid"))
}

fn valid_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.is_ascii()
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'_' | b'-'))
        })
}

fn safe_text(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}

fn compare_versions(left: &str, right: &str) -> AppResult<std::cmp::Ordering> {
    Ok(parse_version_parts(left)?.cmp(&parse_version_parts(right)?))
}

fn parse_version_parts(value: &str) -> AppResult<[u32; 3]> {
    let mut parts = value.split('.');
    let parsed = [
        parts.next().and_then(|part| part.parse().ok()),
        parts.next().and_then(|part| part.parse().ok()),
        parts.next().and_then(|part| part.parse().ok()),
    ];
    if parts.next().is_some() || parsed.iter().any(Option::is_none) {
        return Err(blocked("PlanetScale CLI version is invalid"));
    }
    Ok(parsed.map(Option::unwrap))
}

fn process_error(error: ProvisioningProcessFailure) -> AppError {
    match error {
        ProvisioningProcessFailure::AuthenticationRequired => {
            blocked("PlanetScale CLI authentication is required")
        }
        ProvisioningProcessFailure::MultiFactorRequired => {
            blocked("PlanetScale CLI requires multi-factor authentication")
        }
        ProvisioningProcessFailure::PermissionDenied => {
            blocked("PlanetScale CLI permission was denied")
        }
        ProvisioningProcessFailure::RateLimited => {
            blocked("PlanetScale CLI rate limit was reached")
        }
        ProvisioningProcessFailure::NetworkUnavailable | ProvisioningProcessFailure::TimedOut => {
            AppError::Network("PlanetScale CLI network is unavailable".into())
        }
        _ => blocked("PlanetScale command failed its audited execution boundary"),
    }
}

fn blocked(reason: &'static str) -> AppError {
    AppError::Blocked {
        reason: reason.into(),
    }
}

#[cfg(test)]
pub(crate) fn assert_planetscale_cli_contract() {
    let classified = [
        ProvisioningProcessFailure::AuthenticationRequired,
        ProvisioningProcessFailure::MultiFactorRequired,
        ProvisioningProcessFailure::PermissionDenied,
        ProvisioningProcessFailure::RateLimited,
        ProvisioningProcessFailure::NetworkUnavailable,
    ]
    .map(|failure| process_error(failure).to_string());
    assert_eq!(
        classified
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        classified.len()
    );
    assert_eq!(
        parse_version(&serde_json::json!({
            "version": "v0.308.0",
            "commit": "855a3174d5c61abc4363b34bf966ed5032a416a5",
            "build_date": "2026-07-31T00:00:00Z"
        }))
        .unwrap(),
        MINIMUM_PSCALE_VERSION,
    );
    assert_eq!(
        compare_versions("0.307.0", MINIMUM_PSCALE_VERSION).unwrap(),
        std::cmp::Ordering::Less,
    );
    assert!(parse_version(&serde_json::json!({
        "version": "v0.308.0", "commit": "x", "build_date": "x", "token": "secret"
    }))
    .is_err());

    let auth = parse_auth_check(&serde_json::json!({
        "status": "ok",
        "authenticated": true,
        "auth_method": "oauth",
        "organization": "acme",
        "api_url": OFFICIAL_API_URL,
        "agent_guide_command": "pscale agent-guide --format json",
        "next_steps": ["pscale database list --org acme --format json"]
    }))
    .unwrap();
    assert!(auth.authenticated);
    assert_eq!(auth.organization.as_deref(), Some("acme"));
    assert!(parse_auth_check(&serde_json::json!({
        "status": "ok",
        "authenticated": true,
        "auth_method": "oauth",
        "api_url": "https://attacker.invalid",
        "agent_guide_command": "pscale agent-guide --format json"
    }))
    .is_err());

    let organizations = parse_organizations(&serde_json::json!([{
        "name": "acme", "created_at": 1, "updated_at": 2, "current": true
    }]))
    .unwrap();
    assert_eq!(organizations[0].name, "acme");

    let database = parse_database(&serde_json::json!({
        "name": "app", "kind": "postgresql", "state": "ready",
        "notes": "", "region": {"slug": "us-east"},
        "html_url": "https://app.planetscale.com/acme/app",
        "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z"
    }))
    .unwrap();
    assert_eq!(database.engine, Engine::Postgres);
    assert!(parse_database(&serde_json::json!({
        "name": "app", "kind": "mysql", "state": "ready", "password": "must-not-project"
    }))
    .is_err());

    let mysql = parse_branch(
        &serde_json::json!({
            "id": "br-main-123", "name": "main", "ready": true,
            "production": true, "safe_migrations": true,
            "actor": {"id": "user-1"}, "region": {"slug": "us-east"}
        }),
        Engine::Mysql,
    )
    .unwrap();
    assert_eq!(mysql.safe_migrations, Some(true));
    let postgres = parse_branch(
        &serde_json::json!({
            "id": "br-main-456", "name": "main", "ready": true,
            "production": false, "state": "ready"
        }),
        Engine::Postgres,
    )
    .unwrap();
    assert_eq!(postgres.safe_migrations, None);
    assert!(parse_branch(
        &serde_json::json!({
            "id": "br-main-456", "name": "main", "ready": true,
            "production": false, "access_token": "must-not-project"
        }),
        Engine::Postgres
    )
    .is_err());
}
