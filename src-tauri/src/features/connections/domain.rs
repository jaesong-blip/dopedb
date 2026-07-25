//! Connection domain values and invariants.
//!
//! This module deliberately has no knowledge of Tauri, SQLite, the keychain, live
//! pools, or the driver installer. It owns the rules that every transport must use.

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::kernel::identity::ConnectionId;
use crate::model::{ConnectionProfile, Engine};

pub(crate) const MAX_CONNECTION_CREDENTIAL_BYTES: usize = 1 << 16;

/// How a driver reaches the local installation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DriverInstallMode {
    Bundled,
    Managed,
}

/// Current local availability of a driver.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DriverInstallState {
    Installed,
    Available,
    Planned,
}

/// Capabilities exposed by a driver adapter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DriverCapability {
    Sql,
    DocumentQuery,
    Transactions,
    Introspection,
    Collections,
    SchemaDiff,
    Monitoring,
}

/// Serializable driver metadata used by the connection form and runtime resolver.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DriverDescriptor {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) engine: Engine,
    pub(crate) version: String,
    pub(crate) install_mode: DriverInstallMode,
    pub(crate) install_state: DriverInstallState,
    pub(crate) supported_providers: Vec<crate::model::Provider>,
    pub(crate) capabilities: Vec<DriverCapability>,
    pub(crate) recommended: bool,
}

/// A connection projection safe to serialize for an agent transport.
///
/// The allowlist intentionally has no provider, driver, network host/port, user,
/// credential reference, workspace/account authority, or provider parameters.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentConnectionSummary {
    pub(crate) id: ConnectionId,
    pub(crate) name: String,
    pub(crate) engine: Engine,
    pub(crate) database: String,
    pub(crate) environment: Option<String>,
    pub(crate) readonly: bool,
    pub(crate) allow_writes: bool,
}

impl From<&ConnectionProfile> for AgentConnectionSummary {
    fn from(profile: &ConnectionProfile) -> Self {
        Self {
            id: profile.id.into(),
            name: profile.name.clone(),
            engine: profile.engine,
            database: profile.database.clone(),
            environment: profile.env.clone(),
            readonly: profile.readonly_default,
            allow_writes: profile.allow_writes,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CliConnectionResolutionError {
    NoMatch,
    Ambiguous {
        candidates: Vec<AgentConnectionSummary>,
    },
}

impl fmt::Display for CliConnectionResolutionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoMatch => formatter.write_str("no connection matches the exact selector"),
            Self::Ambiguous { .. } => {
                formatter.write_str("the exact connection name matches more than one connection")
            }
        }
    }
}

impl std::error::Error for CliConnectionResolutionError {}

pub(crate) fn normalize_schema_group(schema_group: Option<String>) -> Option<String> {
    schema_group.and_then(|value| {
        let trimmed = value.trim().to_string();
        (!trimmed.is_empty()).then_some(trimmed)
    })
}

pub(crate) fn validate_schema_group_engine(
    profile: &ConnectionProfile,
    connections: &[ConnectionProfile],
) -> AppResult<()> {
    let Some(group) = profile.schema_group.as_deref() else {
        return Ok(());
    };
    let incompatible = connections.iter().any(|connection| {
        connection.id != profile.id
            && connection
                .schema_group
                .as_deref()
                .is_some_and(|candidate| candidate.trim().eq_ignore_ascii_case(group))
            && connection.engine != profile.engine
    });
    if incompatible {
        return Err(AppError::Config(format!(
            "schema group '{group}' already contains a different database engine"
        )));
    }
    Ok(())
}

pub(crate) fn resolve_cli_name(
    summaries: &[AgentConnectionSummary],
    name: &str,
) -> Result<AgentConnectionSummary, CliConnectionResolutionError> {
    let mut candidates = summaries
        .iter()
        .filter(|summary| summary.name == name)
        .cloned()
        .collect::<Vec<_>>();
    candidates.sort_by_key(|summary| summary.id);
    match candidates.as_slice() {
        [only] => Ok(only.clone()),
        [] => Err(CliConnectionResolutionError::NoMatch),
        _ => Err(CliConnectionResolutionError::Ambiguous { candidates }),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use serde_json::json;
    use uuid::Uuid;

    use super::*;
    use crate::model::{Provider, WorkspaceConnectionAccess, WorkspaceCredentialMode};

    const ALPHA_ID: &str = "018f9999-8888-7777-8666-555544443331";
    const BETA_ID: &str = "018f9999-8888-7777-8666-555544443332";

    fn profile(id: &str, name: &str) -> ConnectionProfile {
        ConnectionProfile {
            id: Uuid::parse_str(id).unwrap(),
            name: name.into(),
            engine: Engine::Postgres,
            provider: Provider::Neon,
            driver_id: Some("secret-driver".into()),
            host: "secret-host.example".into(),
            port: 5432,
            database: "analytics".into(),
            username: "secret-user".into(),
            sslmode: "require".into(),
            extra_params: HashMap::from([("secret-param".into(), "secret-value".into())]),
            readonly_default: true,
            allow_writes: false,
            secret_ref: Some("secret-reference".into()),
            env: Some("prod".into()),
            schema_group: Some("secret-schema-group".into()),
            workspace_access: WorkspaceConnectionAccess::Manage,
            credential_mode: WorkspaceCredentialMode::Managed,
        }
    }

    #[test]
    fn normalizes_empty_and_padded_group_names() {
        assert_eq!(
            normalize_schema_group(Some("  Core  ".into())).as_deref(),
            Some("Core")
        );
        assert_eq!(normalize_schema_group(Some("   ".into())), None);
    }

    #[test]
    fn rejects_a_different_engine_in_the_same_case_insensitive_group() {
        let mut postgres = profile(ALPHA_ID, "postgres");
        postgres.schema_group = Some("Core".into());
        let mut mysql = profile(BETA_ID, "mysql");
        mysql.engine = Engine::Mysql;
        mysql.schema_group = Some(" core ".into());

        assert!(validate_schema_group_engine(&postgres, &[mysql]).is_err());
        let mut sibling = profile(BETA_ID, "sibling");
        sibling.schema_group = Some("CORE".into());
        assert!(validate_schema_group_engine(&postgres, &[sibling]).is_ok());
    }

    #[test]
    fn agent_summary_serializes_only_the_allowlisted_shape() {
        let value = serde_json::to_value(AgentConnectionSummary::from(&profile(ALPHA_ID, "alpha")))
            .unwrap();

        assert_eq!(
            value,
            json!({
                "id": ALPHA_ID,
                "name": "alpha",
                "engine": "postgres",
                "database": "analytics",
                "environment": "prod",
                "readonly": true,
                "allowWrites": false,
            })
        );
        assert_eq!(value.as_object().map(serde_json::Map::len), Some(7));

        let serialized = value.to_string();
        for forbidden in [
            "secret-host",
            "secret-user",
            "secret-driver",
            "secret-param",
            "secret-value",
            "secret-reference",
            "secret-schema-group",
            "provider",
            "driverId",
            "host",
            "port",
            "username",
            "extraParams",
            "secretRef",
            "workspaceAccess",
            "credentialMode",
        ] {
            assert!(
                !serialized.contains(forbidden),
                "agent summary leaked {forbidden}"
            );
        }
    }

    #[test]
    fn cli_selector_never_picks_the_first_duplicate_name() {
        let alpha = AgentConnectionSummary::from(&profile(ALPHA_ID, "duplicate"));
        let beta = AgentConnectionSummary::from(&profile(BETA_ID, "duplicate"));
        let summaries = vec![beta.clone(), alpha.clone()];
        assert!(matches!(
            resolve_cli_name(&summaries, "duplicate"),
            Err(CliConnectionResolutionError::Ambiguous { candidates })
                if candidates == vec![
                    AgentConnectionSummary::from(&profile(ALPHA_ID, "duplicate")),
                    AgentConnectionSummary::from(&profile(BETA_ID, "duplicate")),
                ]
        ));
        assert_eq!(
            resolve_cli_name(std::slice::from_ref(&alpha), "duplicate"),
            Ok(alpha)
        );
        assert_eq!(
            resolve_cli_name(&[beta], "missing"),
            Err(CliConnectionResolutionError::NoMatch)
        );
    }
}
