//! Hardened ADC token hand-off for one immediately bounded Cloud SQL request.
//!
//! This module owns the short-lived bearer token while it verifies the exact
//! target. It can then move that token into the non-serializable connector
//! carrier; provider bindings and persistent profiles can never observe it.

use zeroize::Zeroizing;

use crate::connection::GcpCloudSqlNetworkMode;
use crate::error::AppResult;
use crate::model::Engine;

use super::super::super::domain::ProviderVerification;
#[cfg(not(windows))]
use super::{
    adc_source, command_spec, external_subject_token_guard, find_gcloud, read_token_output,
    spawn_gcloud, validate_adc, AdcSource, GcloudSnapshot,
};

pub(crate) struct ResolvedCloudSqlConnectSettings {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) sslmode: String,
    pub(crate) server_ca_pem: String,
    pub(crate) instance_connection_name: String,
    pub(crate) access_token: Zeroizing<String>,
}

/// Resolves narrow network metadata using the same ADC path as verification.
pub(crate) async fn resolve_cloud_sql_connect_settings(
    project: &str,
    instance: &str,
    database: &str,
    engine: Engine,
    network_mode: GcpCloudSqlNetworkMode,
) -> AppResult<ResolvedCloudSqlConnectSettings> {
    #[cfg(windows)]
    {
        let _ = (project, instance, database, engine, network_mode);
        Err(super::blocked("GCP ADC verification is unavailable"))
    }
    #[cfg(not(windows))]
    {
        let mut token = access_token().await?;
        let settings = super::gcp_target::resolve_connect_settings(
            project,
            instance,
            database,
            engine,
            network_mode,
            &token,
        )
        .await?;
        let access_token = String::from_utf8(std::mem::take(&mut *token))
            .map(Zeroizing::new)
            .map_err(|_| super::blocked("GCP ADC credential returned an invalid access token"))?;
        Ok(ResolvedCloudSqlConnectSettings {
            host: settings.host,
            port: settings.port,
            sslmode: settings.sslmode,
            server_ca_pem: settings.server_ca_pem,
            instance_connection_name: settings.instance_connection_name,
            access_token,
        })
    }
}

/// Verifies the initial Cloud SQL authority with an ephemeral token.
pub(super) async fn verify_cloud_sql_target(
    binding: &super::super::super::domain::ProviderBindingScope,
) -> AppResult<ProviderVerification> {
    #[cfg(windows)]
    {
        let _ = binding;
        Err(super::blocked("GCP ADC verification is unavailable"))
    }
    #[cfg(not(windows))]
    {
        let token = access_token().await?;
        let result = super::gcp_target::verify_cloud_sql_target(binding, &token).await;
        drop(token);
        result
    }
}

#[cfg(not(windows))]
async fn access_token() -> AppResult<Zeroizing<Vec<u8>>> {
    let source = adc_source()?;
    let document = super::read_adc_document(&source.path)?;
    validate_adc(&document)?;
    let subject_token = external_subject_token_guard(&document)?;
    let mut snapshot =
        GcloudSnapshot::materialize(&source.path, &document, subject_token.as_ref())?;
    let spec = command_spec(
        find_gcloud()?,
        AdcSource {
            path: snapshot.adc_path().to_path_buf(),
            config_directory: snapshot.config_directory().to_path_buf(),
        },
    )?;
    let mut child = spawn_gcloud(&spec)?;
    let token = read_token_output(&mut child).await;
    // Always attempt descriptor-rooted overwrite/unlink, even after an
    // unproven process-group fence. A live inherited FD then observes the
    // zeroized inode rather than a permanently retained credential file.
    let cleanup = snapshot.cleanup();
    match (token, cleanup) {
        (Ok(token), Ok(())) => Ok(token),
        (Ok(_), Err(error)) | (Err(_), Err(error)) => Err(error),
        (Err(error), Ok(())) => Err(error),
    }
}
