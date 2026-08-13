//! Exact Cloud SQL target proof for a local GCP WIF receipt.

use std::{net::IpAddr, str::FromStr};

use serde_json::Value;
use x509_parser::{parse_x509_certificate, pem::Pem};

use crate::connection::GcpCloudSqlNetworkMode;
use crate::error::{AppError, AppResult};
use crate::model::Engine;

use super::super::super::domain::{
    GcpCloudSqlVerificationTarget, ProviderBindingScope, ProviderVerification,
    ProviderVerificationTarget, RedactedProviderPrincipal,
};

/// Redacted Cloud SQL network material returned to the provider-local resolver.
/// Provider traffic is executed by the official gcloud binary.
pub(crate) struct GcpConnectSettings {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) sslmode: String,
    pub(crate) server_ca_pem: String,
    pub(crate) instance_connection_name: String,
}

fn blocked() -> AppError {
    AppError::Blocked {
        reason: "GCP target authority verification failed".into(),
    }
}

pub(super) async fn verify_cloud_sql_target(
    binding: &ProviderBindingScope,
) -> AppResult<ProviderVerification> {
    let Some(ProviderVerificationTarget::GcpCloudSql(target)) = &binding.verification_target else {
        return Err(blocked());
    };
    if binding.provider != super::super::super::domain::LocalProvider::GcpCloudSql {
        return Err(blocked());
    }
    let value = describe_instance(&target.project_id, &target.instance_id).await?;
    validate_cloud_sql_value(target, &value)?;
    Ok(ProviderVerification::Verified(RedactedProviderPrincipal {
        display: "GCP Cloud SQL local credential".into(),
    }))
}

/// Fetches and validates only the connection metadata for a server-authorized
/// Cloud SQL target.  It accepts no provider resource or database identity from
/// the renderer; callers pass the exact already-authorized values.
pub(crate) async fn resolve_connect_settings(
    project: &str,
    instance: &str,
    database: &str,
    engine: Engine,
    network_mode: GcpCloudSqlNetworkMode,
) -> AppResult<GcpConnectSettings> {
    if !valid_project_id(project)
        || !valid_identifier(instance, 99)
        || !valid_database_name(database)
        || !matches!(engine, Engine::Postgres | Engine::Mysql)
    {
        return Err(blocked());
    }
    let target = GcpCloudSqlVerificationTarget {
        project_id: project.to_owned(),
        instance_id: instance.to_owned(),
    };
    let value = describe_instance(project, instance).await?;
    validate_cloud_sql_value(&target, &value)?;
    let instance_connection_name = instance_connection_name_value(&target, &value)?;
    parse_connect_settings_value(engine, network_mode, &value, instance_connection_name)
}

async fn describe_instance(project: &str, instance: &str) -> AppResult<Value> {
    if !valid_project_id(project) || !valid_identifier(instance, 99) {
        return Err(blocked());
    }
    super::run_gcloud_json(&[
        "--quiet".into(),
        "sql".into(),
        "instances".into(),
        "describe".into(),
        instance.into(),
        format!("--project={project}"),
        "--format=json(name,project,state,databaseVersion,connectionName,ipAddresses,serverCaCert.cert,settings.ipConfiguration.pscConfig.pscEnabled,dnsName)".into(),
    ])
    .await
}

fn validate_cloud_sql_value(
    target: &GcpCloudSqlVerificationTarget,
    value: &Value,
) -> AppResult<()> {
    let object = value.as_object().ok_or_else(blocked)?;
    if object.get("project").and_then(Value::as_str) != Some(target.project_id.as_str())
        || object.get("name").and_then(Value::as_str) != Some(target.instance_id.as_str())
        || object.get("state").and_then(Value::as_str) != Some("RUNNABLE")
        || !matches!(object.get("databaseVersion").and_then(Value::as_str), Some(value) if value.starts_with("POSTGRES_") || value.starts_with("MYSQL_"))
    {
        return Err(blocked());
    }
    Ok(())
}

fn parse_connect_settings_value(
    engine: Engine,
    network_mode: GcpCloudSqlNetworkMode,
    value: &Value,
    instance_connection_name: String,
) -> AppResult<GcpConnectSettings> {
    let object = value.as_object().ok_or_else(blocked)?;
    if object.len() > 16
        || !matches_engine(
            object.get("databaseVersion").and_then(Value::as_str),
            engine,
        )
    {
        return Err(blocked());
    }
    let ca = object
        .get("serverCaCert")
        .and_then(Value::as_object)
        .and_then(|certificate| certificate.get("cert"))
        .and_then(Value::as_str)
        .filter(|pem| valid_ca_pem(pem))
        .ok_or_else(blocked)?
        .to_owned();
    let host = match network_mode {
        GcpCloudSqlNetworkMode::Public => {
            exact_ip_address(object, "PRIMARY", AddressClass::Public)?
        }
        GcpCloudSqlNetworkMode::PrivateServicesAccess => {
            exact_ip_address(object, "PRIVATE", AddressClass::Private)?
        }
        GcpCloudSqlNetworkMode::PrivateServiceConnect => {
            let psc_enabled = object
                .get("settings")
                .and_then(Value::as_object)
                .and_then(|settings| settings.get("ipConfiguration"))
                .and_then(Value::as_object)
                .and_then(|configuration| configuration.get("pscConfig"))
                .and_then(Value::as_object)
                .and_then(|psc| psc.get("pscEnabled"))
                .and_then(Value::as_bool);
            if psc_enabled != Some(true) {
                return Err(blocked());
            }
            normalize_psc_dns_name(
                object
                    .get("dnsName")
                    .and_then(Value::as_str)
                    .ok_or_else(blocked)?,
            )?
        }
    };
    Ok(GcpConnectSettings {
        host,
        port: match engine {
            Engine::Postgres => 5432,
            Engine::Mysql => 3306,
            Engine::Sqlite | Engine::Mongodb => return Err(blocked()),
        },
        sslmode: match network_mode {
            GcpCloudSqlNetworkMode::PrivateServiceConnect => "verify-full".into(),
            GcpCloudSqlNetworkMode::Public | GcpCloudSqlNetworkMode::PrivateServicesAccess => {
                "verify-ca".into()
            }
        },
        server_ca_pem: ca,
        instance_connection_name,
    })
}

fn instance_connection_name_value(
    target: &GcpCloudSqlVerificationTarget,
    value: &Value,
) -> AppResult<String> {
    let connection_name = value
        .as_object()
        .and_then(|object| object.get("connectionName"))
        .and_then(Value::as_str)
        .ok_or_else(blocked)?;
    let mut segments = connection_name.split(':');
    let (Some(project), Some(region), Some(instance), None) = (
        segments.next(),
        segments.next(),
        segments.next(),
        segments.next(),
    ) else {
        return Err(blocked());
    };
    if project != target.project_id
        || instance != target.instance_id
        || region.is_empty()
        || region.len() > 100
        || !region
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(blocked());
    }
    Ok(connection_name.to_owned())
}

fn matches_engine(value: Option<&str>, engine: Engine) -> bool {
    match (value, engine) {
        (Some(value), Engine::Postgres) => value.starts_with("POSTGRES_"),
        (Some(value), Engine::Mysql) => value.starts_with("MYSQL_"),
        _ => false,
    }
}

#[derive(Clone, Copy)]
enum AddressClass {
    Public,
    Private,
}

fn exact_ip_address(
    object: &serde_json::Map<String, Value>,
    expected: &str,
    class: AddressClass,
) -> AppResult<String> {
    let addresses = object
        .get("ipAddresses")
        .and_then(Value::as_array)
        .filter(|addresses| !addresses.is_empty() && addresses.len() <= 16)
        .ok_or_else(blocked)?;
    let values = addresses
        .iter()
        .filter_map(|item| {
            let object = item.as_object()?;
            (object.len() <= 3 && object.get("type").and_then(Value::as_str) == Some(expected))
                .then(|| object.get("ipAddress").and_then(Value::as_str))
                .flatten()
        })
        .collect::<Vec<_>>();
    let [value] = values.as_slice() else {
        return Err(blocked());
    };
    let address = IpAddr::from_str(value).map_err(|_| blocked())?;
    let accepted = match class {
        AddressClass::Public => is_public_global(address),
        AddressClass::Private => is_private_internal(address),
    };
    accepted.then(|| (*value).to_owned()).ok_or_else(blocked)
}

fn valid_ca_pem(value: &str) -> bool {
    if value.is_empty()
        || value.len() > 64 * 1024
        || value.contains('\0')
        || value
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r'))
    {
        return false;
    }
    const BEGIN: &str = "-----BEGIN CERTIFICATE-----";
    const END: &str = "-----END CERTIFICATE-----";
    let Some(end) = value.rfind(END) else {
        return false;
    };
    if !value.starts_with(BEGIN)
        || value.matches(BEGIN).count() != 1
        || value.matches(END).count() != 1
        || !value[end + END.len()..].trim().is_empty()
    {
        return false;
    }
    let mut certificates = Pem::iter_from_buffer(value.as_bytes());
    let Some(Ok(pem_certificate)) = certificates.next() else {
        return false;
    };
    if pem_certificate.label != "CERTIFICATE" {
        return false;
    }
    let Ok((remainder, certificate)) = parse_x509_certificate(&pem_certificate.contents) else {
        return false;
    };
    if !remainder.is_empty() || certificates.next().is_some() {
        return false;
    }
    // Cloud SQL supplies a trust anchor, not merely any parseable X.509 object.
    // Accepting a leaf here would let a hostile metadata response replace the
    // root of trust for the subsequently opened database connection.
    certificate
        .basic_constraints()
        .ok()
        .flatten()
        .is_some_and(|extension| extension.value.ca)
        && certificate
            .key_usage()
            .ok()
            .flatten()
            .is_some_and(|extension| extension.value.key_cert_sign())
}

fn normalize_psc_dns_name(value: &str) -> AppResult<String> {
    let value = value.strip_suffix('.').unwrap_or(value);
    if value.is_empty() || value.ends_with('.') || !valid_dns_name(value) {
        return Err(blocked());
    }
    (value.ends_with(".sql.goog") || value.ends_with(".sql-psc.goog"))
        .then(|| value.to_owned())
        .ok_or_else(blocked)
}

fn valid_dns_name(value: &str) -> bool {
    value.len() <= 253
        && value.contains('.')
        && !value.ends_with('.')
        && !value.contains(['/', '\\', '@', ':', '?', '#'])
        && value.bytes().all(|byte| !byte.is_ascii_uppercase())
        && value.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
}

fn is_public_global(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            let [a, b, c, _] = address.octets();
            !address.is_private()
                && !address.is_loopback()
                && !address.is_link_local()
                && !address.is_multicast()
                && !address.is_unspecified()
                && address != std::net::Ipv4Addr::BROADCAST
                && !(a == 0
                    || (a == 100 && (64..=127).contains(&b))
                    || (a == 192 && b == 0 && c == 0)
                    || (a == 192 && b == 0 && c == 2)
                    || (a == 198 && (b == 18 || b == 19))
                    || (a == 198 && b == 51 && c == 100)
                    || (a == 203 && b == 0 && c == 113)
                    || a >= 224)
        }
        IpAddr::V6(address) => {
            let segments = address.segments();
            !address.is_loopback()
                && !address.is_unspecified()
                && !address.is_multicast()
                && !address.is_unicast_link_local()
                && (segments[0] & 0xfe00) != 0xfc00
                && !(segments[0] == 0x2001 && segments[1] == 0x0db8)
        }
    }
}

fn is_private_internal(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => address.is_private(),
        IpAddr::V6(address) => (address.segments()[0] & 0xfe00) == 0xfc00,
    }
}

fn valid_database_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

pub(crate) fn validate_impersonation_url(value: &Value) -> AppResult<()> {
    let value = value.as_str().ok_or_else(blocked)?;
    let url = reqwest::Url::parse(value).map_err(|_| blocked())?;
    if url.scheme() != "https"
        || url.host_str() != Some("iamcredentials.googleapis.com")
        || url.port().is_some_and(|port| port != 443)
        || url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(blocked());
    }
    let Some(segments) = url.path_segments() else {
        return Err(blocked());
    };
    let segments = segments.collect::<Vec<_>>();
    let ["v1", "projects", "-", "serviceAccounts", account] = segments.as_slice() else {
        return Err(blocked());
    };
    let Some(account) = account.strip_suffix(":generateAccessToken") else {
        return Err(blocked());
    };
    if value.contains('%') || !valid_service_account_email(account) {
        return Err(blocked());
    }
    Ok(())
}

fn valid_service_account_email(value: &str) -> bool {
    let Some((local, domain)) = value.split_once('@') else {
        return false;
    };
    if value.matches('@').count() != 1
        || local.len() < 6
        || local.len() > 30
        || !local.starts_with(|character: char| character.is_ascii_lowercase())
        || !local.ends_with(|character: char| {
            character.is_ascii_lowercase() || character.is_ascii_digit()
        })
        || !local
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return false;
    }
    domain
        .strip_suffix(".iam.gserviceaccount.com")
        .is_some_and(valid_project_id)
}

fn valid_project_id(value: &str) -> bool {
    value.len() >= 6
        && value.len() <= 30
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_lowercase())
        && value
            .bytes()
            .last()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn valid_identifier(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}
