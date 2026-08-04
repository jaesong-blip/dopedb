//! Redacted shared-connection and short-lived provider-lease HTTP exchanges.

use super::*;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ProviderLocalTargetResponse {
    pub(super) target: RemoteProviderLocalTarget,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RemoteProviderLocalTarget {
    pub(super) connection_id: String,
    pub(super) connection_revision: String,
    pub(super) integration_id: String,
    pub(super) integration_generation: String,
    pub(super) provider: String,
    pub(super) resource_fingerprint: String,
    pub(super) target: serde_json::Value,
    pub(super) authority_expires_at: String,
}

const PROVIDER_LOCAL_TARGET_MIN_SECONDS: i64 = 30;
const PROVIDER_LOCAL_TARGET_MAX_SECONDS: i64 = 5 * 60 + 5;
pub(super) const PROVIDER_LOCAL_TARGET_MAX_BODY_BYTES: usize = 64 * 1024;

pub(super) fn bounded_target_body_capacity(content_length: Option<u64>) -> AppResult<usize> {
    if content_length.is_some_and(|length| length > PROVIDER_LOCAL_TARGET_MAX_BODY_BYTES as u64) {
        return Err(AppError::Network(
            "provider-local target authority returned invalid metadata".into(),
        ));
    }
    Ok(content_length
        .unwrap_or_default()
        .min(PROVIDER_LOCAL_TARGET_MAX_BODY_BYTES as u64) as usize)
}

pub(super) fn append_bounded_target_body(body: &mut Vec<u8>, chunk: &[u8]) -> AppResult<()> {
    let next_len = body.len().checked_add(chunk.len()).ok_or_else(|| {
        AppError::Network("provider-local target authority returned invalid metadata".into())
    })?;
    if next_len > PROVIDER_LOCAL_TARGET_MAX_BODY_BYTES {
        return Err(AppError::Network(
            "provider-local target authority returned invalid metadata".into(),
        ));
    }
    body.extend_from_slice(chunk);
    Ok(())
}

/// Read the capability-sensitive response before deserializing it. Content-Length
/// is only an early rejection hint; every streamed chunk is independently capped.
async fn bounded_target_response_body(response: reqwest::Response) -> AppResult<Vec<u8>> {
    let mut response = response;
    let mut body = Vec::with_capacity(bounded_target_body_capacity(response.content_length())?);
    while let Some(chunk) = response.chunk().await.map_err(|_| {
        AppError::Network("provider-local target authority returned invalid metadata".into())
    })? {
        append_bounded_target_body(&mut body, &chunk)?;
    }
    Ok(body)
}

pub(super) fn provider_local_target_response(
    value: ProviderLocalTargetResponse,
    expected_connection: ConnectionId,
) -> AppResult<RuntimeProviderLocalTarget> {
    let target = value.target;
    let connection_id = Uuid::parse_str(&target.connection_id)
        .map(ConnectionId::from)
        .map_err(|_| {
            AppError::Network("provider-local target authority returned invalid metadata".into())
        })?;
    let integration_id = Uuid::parse_str(&target.integration_id)
        .map(ProviderIntegrationId::from)
        .map_err(|_| {
            AppError::Network("provider-local target authority returned invalid metadata".into())
        })?;
    let parse_decimal = |value: &str| -> AppResult<i64> {
        if value.is_empty()
            || !value.bytes().all(|byte| byte.is_ascii_digit())
            || value.starts_with('0')
        {
            return Err(AppError::Network(
                "provider-local target authority returned invalid metadata".into(),
            ));
        }
        let parsed = value.parse::<i64>().ok();
        match parsed.filter(|value| (1..=9_007_199_254_740_991).contains(value)) {
            Some(value) => Ok(value),
            None => Err(AppError::Network(
                "provider-local target authority returned invalid metadata".into(),
            )),
        }
    };
    let connection_revision = parse_decimal(&target.connection_revision)?;
    let integration_generation = parse_decimal(&target.integration_generation)?;
    if Uuid::from(connection_id).is_nil()
        || Uuid::from(integration_id).is_nil()
        || connection_id != expected_connection
        || target.resource_fingerprint.len() != 64
        || !target
            .resource_fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(AppError::Network(
            "provider-local target authority returned invalid metadata".into(),
        ));
    }
    let expires_at = chrono::DateTime::parse_from_rfc3339(&target.authority_expires_at)
        .map_err(|_| {
            AppError::Network("provider-local target authority returned invalid metadata".into())
        })?
        .with_timezone(&chrono::Utc);
    let valid_seconds = expires_at
        .signed_duration_since(chrono::Utc::now())
        .num_seconds();
    if !(PROVIDER_LOCAL_TARGET_MIN_SECONDS..=PROVIDER_LOCAL_TARGET_MAX_SECONDS)
        .contains(&valid_seconds)
    {
        return Err(AppError::Network(
            "provider-local target authority returned unsafe expiry".into(),
        ));
    }
    let exact_object = |value: serde_json::Value,
                        fields: &[&str]|
     -> Option<serde_json::Map<String, serde_json::Value>> {
        let object = value.as_object()?.clone();
        (object.len() == fields.len() && fields.iter().all(|field| object.contains_key(*field)))
            .then_some(object)
    };
    let bounded = |value: &str, max: usize| {
        !value.is_empty()
            && value.len() <= max
            && !value.chars().any(|character| character.is_control())
    };
    let target_component = |value: &str, max: usize| {
        bounded(value, max)
            && !value.contains("://")
            && !value.chars().any(char::is_whitespace)
            && value.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'$')
            })
    };
    let (provider, resource) = match target.provider.as_str() {
        "neon" => {
            let object = exact_object(
                target.target,
                &[
                    "project",
                    "branch",
                    "databaseId",
                    "database",
                    "engine",
                    "schemas",
                ],
            )
            .ok_or_else(|| {
                AppError::Network(
                    "provider-local target authority returned invalid metadata".into(),
                )
            })?;
            let project = object
                .get("project")
                .and_then(serde_json::Value::as_str)
                .filter(|value| target_component(value, 255))
                .ok_or_else(|| {
                    AppError::Network(
                        "provider-local target authority returned invalid metadata".into(),
                    )
                })?
                .to_owned();
            let branch = object
                .get("branch")
                .and_then(serde_json::Value::as_str)
                .filter(|value| target_component(value, 255))
                .ok_or_else(|| {
                    AppError::Network(
                        "provider-local target authority returned invalid metadata".into(),
                    )
                })?
                .to_owned();
            let database = object
                .get("database")
                .and_then(serde_json::Value::as_str)
                .filter(|value| target_component(value, 512))
                .ok_or_else(|| {
                    AppError::Network(
                        "provider-local target authority returned invalid metadata".into(),
                    )
                })?
                .to_owned();
            let database_id = object
                .get("databaseId")
                .and_then(serde_json::Value::as_str)
                .filter(|value| target_component(value, 512))
                .ok_or_else(|| {
                    AppError::Network(
                        "provider-local target authority returned invalid metadata".into(),
                    )
                })?
                .to_owned();
            if object.get("engine").and_then(serde_json::Value::as_str) != Some("postgres") {
                return Err(AppError::Network(
                    "provider-local target authority returned invalid metadata".into(),
                ));
            }
            let schemas = object
                .get("schemas")
                .and_then(serde_json::Value::as_array)
                .filter(|values| values.len() <= 128)
                .ok_or_else(|| {
                    AppError::Network(
                        "provider-local target authority returned invalid metadata".into(),
                    )
                })?
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .filter(|value| target_component(value, 255))
                        .map(str::to_owned)
                })
                .collect::<Option<Vec<_>>>()
                .ok_or_else(|| {
                    AppError::Network(
                        "provider-local target authority returned invalid metadata".into(),
                    )
                })?;
            (
                Provider::Neon,
                ProviderLocalResource::Neon {
                    project,
                    branch,
                    database_id,
                    database,
                    schemas,
                },
            )
        }
        "gcpCloudSql" => {
            let object = exact_object(
                target.target,
                &["project", "instance", "database", "engine", "networkMode"],
            )
            .ok_or_else(|| {
                AppError::Network(
                    "provider-local target authority returned invalid metadata".into(),
                )
            })?;
            let project = object
                .get("project")
                .and_then(serde_json::Value::as_str)
                .filter(|value| target_component(value, 255))
                .ok_or_else(|| {
                    AppError::Network(
                        "provider-local target authority returned invalid metadata".into(),
                    )
                })?
                .to_owned();
            let instance = object
                .get("instance")
                .and_then(serde_json::Value::as_str)
                .filter(|value| target_component(value, 255))
                .ok_or_else(|| {
                    AppError::Network(
                        "provider-local target authority returned invalid metadata".into(),
                    )
                })?
                .to_owned();
            let database = object
                .get("database")
                .and_then(serde_json::Value::as_str)
                .filter(|value| target_component(value, 512))
                .ok_or_else(|| {
                    AppError::Network(
                        "provider-local target authority returned invalid metadata".into(),
                    )
                })?
                .to_owned();
            let engine = match object.get("engine").and_then(serde_json::Value::as_str) {
                Some("postgres") => crate::model::Engine::Postgres,
                Some("mysql") => crate::model::Engine::Mysql,
                _ => {
                    return Err(AppError::Network(
                        "provider-local target authority returned invalid metadata".into(),
                    ))
                }
            };
            let network_mode = match object
                .get("networkMode")
                .and_then(serde_json::Value::as_str)
            {
                Some("PRIVATE_SERVICES_ACCESS") => GcpCloudSqlNetworkMode::PrivateServicesAccess,
                Some("PUBLIC") => GcpCloudSqlNetworkMode::Public,
                Some("PRIVATE_SERVICE_CONNECT") => GcpCloudSqlNetworkMode::PrivateServiceConnect,
                _ => {
                    return Err(AppError::Network(
                        "provider-local target authority returned invalid metadata".into(),
                    ))
                }
            };
            (
                Provider::GcpCloudSql,
                ProviderLocalResource::GcpCloudSql {
                    project,
                    instance,
                    database,
                    engine,
                    network_mode,
                },
            )
        }
        _ => {
            return Err(AppError::Network(
                "provider-local target authority returned invalid metadata".into(),
            ))
        }
    };
    Ok(RuntimeProviderLocalTarget {
        connection_id,
        connection_revision,
        integration_id,
        integration_generation,
        provider,
        resource_fingerprint: target.resource_fingerprint,
        resource,
        expires_at,
    })
}

/// Fetch a narrow, expiring provider target.  Errors intentionally never parse
/// a provider/DB response body because this endpoint is capability-sensitive.
pub(super) async fn provider_local_target(
    user_id: &str,
    workspace_id: Uuid,
    connection_id: ConnectionId,
) -> AppResult<RuntimeProviderLocalTarget> {
    let token = fetch_workspace_session(user_id)?
        .map(Zeroizing::new)
        .ok_or_else(|| {
            AppError::Config(
                "provider-local target access requires an authenticated session".into(),
            )
        })?;
    let origin = origin()?;
    let response = client()?
        .get(format!(
            "{origin}/api/v1/workspaces/{workspace_id}/connections/{}/provider-local-target",
            Uuid::from(connection_id)
        ))
        .bearer_auth(token.as_str())
        .send()
        .await
        .map_err(|error| request_error("reading provider-local target", error))?;
    if response.status() == StatusCode::UNAUTHORIZED {
        delete_workspace_session(user_id)?;
    }
    if !response.status().is_success() {
        return Err(AppError::Network(
            "provider-local target authority is unavailable".into(),
        ));
    }
    let body = bounded_target_response_body(response).await?;
    let response = serde_json::from_slice::<ProviderLocalTargetResponse>(&body).map_err(|_| {
        AppError::Network("provider-local target authority returned invalid metadata".into())
    })?;
    provider_local_target_response(response, connection_id)
}
