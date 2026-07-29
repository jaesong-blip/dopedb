//! HTTP adapter that reads a local CLI's own OAuth token only to report remaining quota.
//! Tokens stay inside this adapter: the domain sees percentages and reset times only.

use std::path::PathBuf;
use std::time::Duration;

use chrono::{DateTime, TimeZone, Utc};
use reqwest::Client;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::super::domain::{AgentModelUsage, AgentProvider, AgentUsage};
use super::super::ports::AgentUsagePort;

const CLAUDE_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_OAUTH_BETA: &str = "oauth-2025-04-20";
const CLAUDE_USER_AGENT: &str = "claude-code/2.1.0";
const CLAUDE_KEYCHAIN_SERVICE: &str = "Claude Code-credentials";
const CODEX_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// Reports subscription quota for signed-in CLIs; a missing or stale token hides the readout.
#[derive(Clone)]
pub(crate) struct HttpAgentUsage {
    client: Client,
}

impl HttpAgentUsage {
    pub(crate) fn new() -> Self {
        Self {
            client: Client::builder()
                .timeout(REQUEST_TIMEOUT)
                .build()
                .expect("reqwest client configuration is valid"),
        }
    }

    async fn claude_usage(&self) -> Option<AgentUsage> {
        let token = tokio::task::spawn_blocking(claude_access_token).await.ok()??;
        let usage: ClaudeUsage = self
            .client
            .get(CLAUDE_USAGE_URL)
            .bearer_auth(token)
            .header("anthropic-beta", CLAUDE_OAUTH_BETA)
            .header("user-agent", CLAUDE_USER_AGENT)
            .send()
            .await
            .ok()?
            .error_for_status()
            .ok()?
            .json()
            .await
            .ok()?;
        let session = usage.five_hour?;
        Some(AgentUsage {
            provider: AgentProvider::Claude,
            session_percent_left: percent_left(session.utilization?),
            weekly_percent_left: usage
                .seven_day
                .and_then(|window| window.utilization)
                .map(percent_left),
            model_windows: model_windows(usage.limits),
            resets_at: session.resets_at.and_then(reset_time),
        })
    }

    async fn codex_usage(&self) -> Option<AgentUsage> {
        let tokens = tokio::task::spawn_blocking(codex_tokens).await.ok()??;
        let mut request = self
            .client
            .get(CODEX_USAGE_URL)
            .bearer_auth(tokens.access_token);
        if let Some(account_id) = tokens.account_id {
            request = request.header("chatgpt-account-id", account_id);
        }
        let usage: CodexUsage = request
            .send()
            .await
            .ok()?
            .error_for_status()
            .ok()?
            .json()
            .await
            .ok()?;
        let rate_limit = usage.rate_limit?;
        let session = rate_limit.primary_window?;
        Some(AgentUsage {
            provider: AgentProvider::Codex,
            session_percent_left: percent_left(session.used_percent?),
            weekly_percent_left: rate_limit
                .secondary_window
                .and_then(|window| window.used_percent)
                .map(percent_left),
            model_windows: Vec::new(),
            resets_at: session
                .reset_at
                .and_then(|seconds| Utc.timestamp_opt(seconds, 0).single()),
        })
    }
}

impl AgentUsagePort for HttpAgentUsage {
    async fn fetch(&self) -> Vec<AgentUsage> {
        let (claude, codex) = tokio::join!(self.claude_usage(), self.codex_usage());
        [claude, codex].into_iter().flatten().collect()
    }
}

/// Providers report consumption; the status bar shows what is left, rounded once.
fn percent_left(used_percent: f64) -> u8 {
    100 - used_percent.clamp(0.0, 100.0).round() as u8
}

fn reset_time(value: ResetTimestamp) -> Option<DateTime<Utc>> {
    match value {
        ResetTimestamp::Epoch(seconds) => Utc.timestamp_opt(seconds, 0).single(),
        ResetTimestamp::Text(text) => text.parse().ok(),
    }
}

/// The usage endpoint accepts a stored token even past its local expiry, so the
/// CLI stays the only writer of these credentials and no refresh happens here.
fn claude_access_token() -> Option<String> {
    claude_keychain_services()
        .into_iter()
        .filter_map(|service| claude_keychain_credentials(&service))
        .chain(claude_credentials_file())
        .find_map(|raw| {
            serde_json::from_str::<ClaudeCredentials>(&raw)
                .ok()?
                .claude_ai_oauth?
                .access_token
        })
}

fn claude_config_dir() -> Option<PathBuf> {
    std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from)
}

/// Claude Code 2.1+ scopes its keychain item by config dir, falling back to the
/// unsuffixed service older builds wrote.
fn claude_keychain_services() -> Vec<String> {
    let Some(dir) = claude_config_dir() else {
        return vec![CLAUDE_KEYCHAIN_SERVICE.to_owned()];
    };
    let digest = hex::encode(Sha256::digest(dir.to_string_lossy().as_bytes()));
    vec![
        format!("{CLAUDE_KEYCHAIN_SERVICE}-{}", &digest[..8]),
        CLAUDE_KEYCHAIN_SERVICE.to_owned(),
    ]
}

fn claude_keychain_credentials(service: &str) -> Option<String> {
    let account = std::env::var("USER").ok()?;
    keyring::Entry::new(service, &account)
        .ok()?
        .get_password()
        .ok()
}

fn claude_credentials_file() -> Option<String> {
    let dir = claude_config_dir()
        .or_else(|| dirs::home_dir().map(|home| home.join(".claude")))?;
    std::fs::read_to_string(dir.join(".credentials.json")).ok()
}

/// Per-model weekly caps the provider reports alongside the account-wide windows.
fn model_windows(limits: Option<Vec<ClaudeLimit>>) -> Vec<AgentModelUsage> {
    limits
        .unwrap_or_default()
        .into_iter()
        .filter(|limit| limit.kind.as_deref() == Some("weekly_scoped"))
        .filter_map(|limit| {
            Some(AgentModelUsage {
                model: limit.scope?.model?.display_name?,
                percent_left: percent_left(limit.percent?),
            })
        })
        .collect()
}

fn codex_tokens() -> Option<CodexTokens> {
    let dir = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".codex")))?;
    let raw = std::fs::read_to_string(dir.join("auth.json")).ok()?;
    serde_json::from_str::<CodexAuth>(&raw).ok()?.tokens
}

#[derive(Deserialize)]
#[serde(untagged)]
enum ResetTimestamp {
    Epoch(i64),
    Text(String),
}

#[derive(Deserialize)]
struct ClaudeCredentials {
    #[serde(rename = "claudeAiOauth")]
    claude_ai_oauth: Option<ClaudeOauth>,
}

#[derive(Deserialize)]
struct ClaudeOauth {
    #[serde(rename = "accessToken")]
    access_token: Option<String>,
}

#[derive(Deserialize)]
struct ClaudeUsage {
    five_hour: Option<ClaudeWindow>,
    seven_day: Option<ClaudeWindow>,
    limits: Option<Vec<ClaudeLimit>>,
}

#[derive(Deserialize)]
struct ClaudeLimit {
    kind: Option<String>,
    percent: Option<f64>,
    scope: Option<ClaudeLimitScope>,
}

#[derive(Deserialize)]
struct ClaudeLimitScope {
    model: Option<ClaudeLimitModel>,
}

#[derive(Deserialize)]
struct ClaudeLimitModel {
    display_name: Option<String>,
}

#[derive(Deserialize)]
struct ClaudeWindow {
    utilization: Option<f64>,
    resets_at: Option<ResetTimestamp>,
}

#[derive(Deserialize)]
struct CodexAuth {
    tokens: Option<CodexTokens>,
}

#[derive(Deserialize)]
struct CodexTokens {
    access_token: String,
    account_id: Option<String>,
}

#[derive(Deserialize)]
struct CodexUsage {
    rate_limit: Option<CodexRateLimit>,
}

#[derive(Deserialize)]
struct CodexRateLimit {
    primary_window: Option<CodexWindow>,
    secondary_window: Option<CodexWindow>,
}

#[derive(Deserialize)]
struct CodexWindow {
    used_percent: Option<f64>,
    reset_at: Option<i64>,
}
