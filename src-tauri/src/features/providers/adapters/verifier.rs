//! Fail-closed hosted credential verification adapters.
//!
//! Neon validation performs a real scoped-key request in production. GCP local
//! access is deliberately keyless: a platform-specific ADC/WIF adapter must be
//! supplied before it can become ready, so environment and service-account JSON
//! are never accepted as a desktop credential fallback.

use std::time::Duration;

use reqwest::{redirect::Policy, Client};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::error::{AppError, AppResult};

use super::super::domain::{
    LocalProvider, ProviderBindingScope, ProviderVerification, RedactedProviderPrincipal,
};
use super::super::ports::ProviderVerifier;

#[derive(Clone)]
pub(crate) struct HostedProviderVerifier {
    client: Client,
}

impl HostedProviderVerifier {
    pub(crate) fn new() -> Self {
        Self {
            client: Client::builder()
                .redirect(Policy::none())
                .timeout(Duration::from_secs(10))
                .build()
                .expect("reqwest client configuration is valid"),
        }
    }

    async fn verify_neon(
        &self,
        binding: &ProviderBindingScope,
        key: Zeroizing<String>,
    ) -> AppResult<ProviderVerification> {
        if key.is_empty() || key.len() > 16 * 1024 {
            return Err(AppError::Blocked {
                reason: "Neon API key is invalid".into(),
            });
        }
        let response = self
            .client
            .get("https://console.neon.tech/api/v2/projects")
            .bearer_auth(&*key)
            .send()
            .await
            .map_err(|_| AppError::Blocked {
                reason: "Neon credential verification is unavailable".into(),
            })?;
        if !response.status().is_success() {
            return Err(AppError::Blocked {
                reason: "Neon scoped API key was rejected".into(),
            });
        }
        let projects: serde_json::Value = response.json().await.map_err(|_| AppError::Blocked {
            reason: "Neon credential verification response is invalid".into(),
        })?;
        let values = projects
            .get("projects")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| AppError::Blocked {
                reason: "Neon credential verification response is invalid".into(),
            })?;
        let expected = neon_scope(values)?;
        if !valid_neon_scope_syntax(&binding.granted_scope)
            || !constant_time_eq(expected.as_bytes(), binding.granted_scope.as_bytes())
        {
            return Err(AppError::Blocked {
                reason: "Neon credential scope does not match this integration".into(),
            });
        }
        Ok(ProviderVerification::Verified(RedactedProviderPrincipal {
            display: "Neon local credential".into(),
        }))
    }
}

fn neon_scope(values: &[serde_json::Value]) -> AppResult<String> {
    if values.is_empty() || values.len() > 256 {
        return Err(AppError::Blocked {
            reason: "Neon credential scope is invalid".into(),
        });
    }
    let mut ids = values
        .iter()
        .map(|project| {
            project
                .get("id")
                .and_then(serde_json::Value::as_str)
                .filter(valid_project_id)
                .map(str::to_owned)
                .ok_or_else(|| AppError::Blocked {
                    reason: "Neon credential verification response is invalid".into(),
                })
        })
        .collect::<AppResult<Vec<_>>>()?;
    ids.sort_unstable();
    if ids.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(AppError::Blocked {
            reason: "Neon credential verification response is invalid".into(),
        });
    }
    let digest = Sha256::digest(ids.join("\n").as_bytes());
    let encoded = base64url(&digest);
    Ok(format!("projects:{}:{}", ids.len(), &encoded[..16]))
}

fn valid_project_id(id: &&str) -> bool {
    id.len() >= 16
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn valid_neon_scope_syntax(scope: &str) -> bool {
    let mut parts = scope.split(':');
    let (Some("projects"), Some(count), Some(prefix), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    matches!(count.parse::<usize>(), Ok(1..=256))
        && prefix.len() == 16
        && prefix
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

impl ProviderVerifier for HostedProviderVerifier {
    async fn verify(
        &self,
        binding: &ProviderBindingScope,
        secret: Zeroizing<String>,
    ) -> AppResult<ProviderVerification> {
        match binding.provider {
            LocalProvider::Neon => self.verify_neon(binding, secret).await,
            LocalProvider::GcpCloudSql => Err(AppError::Blocked {
                reason: "GCP verifier requires keyless ADC/WIF".into(),
            }),
            LocalProvider::PlanetScale => Ok(ProviderVerification::Unsupported),
        }
    }
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    let max = left.len().max(right.len());
    let mut diff = left.len() ^ right.len();
    for index in 0..max {
        diff |= usize::from(*left.get(index).unwrap_or(&0) ^ *right.get(index).unwrap_or(&0));
    }
    diff == 0
}

fn base64url(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut output = String::with_capacity((bytes.len() * 4).div_ceil(3));
    for chunk in bytes.chunks(3) {
        let value = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        output.push(TABLE[((value >> 18) & 63) as usize] as char);
        output.push(TABLE[((value >> 12) & 63) as usize] as char);
        if chunk.len() > 1 {
            output.push(TABLE[((value >> 6) & 63) as usize] as char);
        }
        if chunk.len() > 2 {
            output.push(TABLE[(value & 63) as usize] as char);
        }
    }
    output
}
