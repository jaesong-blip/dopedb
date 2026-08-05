//! In-memory Terminal session capabilities. Tokens never enter SQLite, discovery,
//! logs, argv, or serialized broker results.

use std::collections::BTreeSet;
use std::fmt;
use std::time::Duration;

use chrono::{DateTime, Utc};
use dashmap::DashMap;
use dopedb_protocol::{AgentSessionRegisterArguments, SessionAuthentication};
use subtle::ConstantTimeEq;
#[cfg(test)]
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::error::{AppError, AppResult};
use crate::kernel::identity::{
    AccountScopeId, ConnectionId, RuntimeId, TerminalSessionId, WorkspaceId,
};
use crate::store::PinnedConnection;

use super::peer::{process_is_descendant_or_same, PeerProcessIdentity};

const SESSION_TOKEN_BYTES: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum BrokerCapability {
    ConnectionRead,
    ConnectionTest,
    CatalogRead,
    DocumentRead,
    QueryPlan,
    QueryRun,
    DashboardCreate,
    ReportPropose,
    SqlPropose,
    OperationRead,
    OperationCancel,
}

impl BrokerCapability {
    pub(crate) const ALL: [Self; 11] = [
        Self::ConnectionRead,
        Self::ConnectionTest,
        Self::CatalogRead,
        Self::DocumentRead,
        Self::QueryPlan,
        Self::QueryRun,
        Self::DashboardCreate,
        Self::ReportPropose,
        Self::SqlPropose,
        Self::OperationRead,
        Self::OperationCancel,
    ];
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AuthenticatedSession {
    pub(crate) terminal_session_id: TerminalSessionId,
    pub(crate) runtime_id: RuntimeId,
    pub(crate) workspace_id: WorkspaceId,
    pub(crate) account_scope: AccountScopeId,
    pub(crate) scope_generation: i64,
    pub(crate) connection_id: ConnectionId,
    pub(crate) connection_revision: i64,
    pub(crate) capabilities: BTreeSet<BrokerCapability>,
    pub(crate) expires_at: DateTime<Utc>,
}

impl AuthenticatedSession {
    pub(crate) fn require(&self, capability: BrokerCapability) -> AppResult<()> {
        if self.capabilities.contains(&capability) {
            Ok(())
        } else {
            Err(AppError::Blocked {
                reason: "terminal session does not have the required broker capability".into(),
            })
        }
    }
}

struct SessionRecord {
    metadata: AuthenticatedSession,
    authorization: SessionAuthorization,
}

enum SessionAuthorization {
    Bearer(Zeroizing<[u8; SESSION_TOKEN_BYTES]>),
    AgentBootstrap {
        token: Zeroizing<[u8; SESSION_TOKEN_BYTES]>,
        registration: AgentSessionRegisterArguments,
    },
    AgentProcess(PeerProcessIdentity),
}

impl fmt::Debug for SessionRecord {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionRecord")
            .field("metadata", &self.metadata)
            .field(
                "authorization",
                &match &self.authorization {
                    SessionAuthorization::Bearer(_) => "bearer:<redacted>",
                    SessionAuthorization::AgentBootstrap { .. } => "agent_bootstrap:<redacted>",
                    SessionAuthorization::AgentProcess(_) => "agent_process",
                },
            )
            .finish()
    }
}

pub(crate) struct IssuedSessionCapability {
    pub(crate) terminal_session_id: TerminalSessionId,
    token: Zeroizing<String>,
    pub(crate) expires_at: DateTime<Utc>,
}

impl IssuedSessionCapability {
    pub(crate) fn token(&self) -> &str {
        &self.token
    }
}

impl fmt::Debug for IssuedSessionCapability {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("IssuedSessionCapability")
            .field("terminal_session_id", &self.terminal_session_id)
            .field("token", &"<redacted>")
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

#[derive(Clone)]
pub(crate) struct BrokerSessionRegistry {
    runtime_id: RuntimeId,
    sessions: std::sync::Arc<DashMap<TerminalSessionId, SessionRecord>>,
}

impl BrokerSessionRegistry {
    pub(crate) fn new(runtime_id: RuntimeId) -> Self {
        Self {
            runtime_id,
            sessions: std::sync::Arc::new(DashMap::new()),
        }
    }

    pub(crate) fn issue(
        &self,
        terminal_session_id: TerminalSessionId,
        pin: &PinnedConnection,
        capabilities: impl IntoIterator<Item = BrokerCapability>,
        ttl: Duration,
    ) -> AppResult<IssuedSessionCapability> {
        self.issue_with_authorization(terminal_session_id, pin, capabilities, ttl, None)
    }

    pub(crate) fn issue_agent(
        &self,
        terminal_session_id: TerminalSessionId,
        pin: &PinnedConnection,
        capabilities: impl IntoIterator<Item = BrokerCapability>,
        ttl: Duration,
        registration: AgentSessionRegisterArguments,
    ) -> AppResult<IssuedSessionCapability> {
        if !registration.validate()
            || !std::path::Path::new(&registration.launcher_executable).is_absolute()
        {
            return Err(AppError::Config(
                "the ACP launcher registration descriptor is invalid".into(),
            ));
        }
        self.issue_with_authorization(
            terminal_session_id,
            pin,
            capabilities,
            ttl,
            Some(registration),
        )
    }

    fn issue_with_authorization(
        &self,
        terminal_session_id: TerminalSessionId,
        pin: &PinnedConnection,
        capabilities: impl IntoIterator<Item = BrokerCapability>,
        ttl: Duration,
        agent_registration: Option<AgentSessionRegisterArguments>,
    ) -> AppResult<IssuedSessionCapability> {
        if ttl.is_zero() {
            return Err(AppError::Config(
                "terminal session capability TTL must be positive".into(),
            ));
        }
        let mut token = Zeroizing::new([0u8; SESSION_TOKEN_BYTES]);
        getrandom::fill(token.as_mut()).map_err(|_| {
            AppError::Config("operating system random source is unavailable".into())
        })?;
        let expires_at = Utc::now()
            + chrono::Duration::from_std(ttl)
                .map_err(|_| AppError::Config("terminal session TTL is too large".into()))?;
        let metadata = AuthenticatedSession {
            terminal_session_id,
            runtime_id: self.runtime_id,
            workspace_id: pin.scope.workspace_id.into(),
            account_scope: AccountScopeId::new(pin.scope.account_scope.storage_key())
                .expect("active resource scope has a non-empty account partition"),
            scope_generation: pin.scope.generation,
            connection_id: pin.connection_id.into(),
            connection_revision: pin.connection_revision,
            capabilities: capabilities.into_iter().collect(),
            expires_at,
        };
        self.sessions.insert(
            terminal_session_id,
            SessionRecord {
                metadata,
                authorization: match agent_registration {
                    Some(registration) => SessionAuthorization::AgentBootstrap {
                        token: token.clone(),
                        registration,
                    },
                    None => SessionAuthorization::Bearer(token.clone()),
                },
            },
        );
        Ok(IssuedSessionCapability {
            terminal_session_id,
            token: Zeroizing::new(hex::encode(token.as_ref())),
            expires_at,
        })
    }

    pub(crate) fn authenticate(
        &self,
        authentication: &SessionAuthentication,
        peer: Option<&PeerProcessIdentity>,
    ) -> AppResult<AuthenticatedSession> {
        if authentication.token().is_some() {
            return self.authenticate_bearer(authentication);
        }
        let terminal_session_id = TerminalSessionId::from(authentication.terminal_session_id);
        let Some(record) = self.sessions.get(&terminal_session_id) else {
            return Err(authentication_denied());
        };
        if record.metadata.runtime_id != self.runtime_id || record.metadata.expires_at <= Utc::now()
        {
            drop(record);
            self.sessions.remove(&terminal_session_id);
            return Err(authentication_denied());
        }
        let SessionAuthorization::AgentProcess(root) = &record.authorization else {
            return Err(authentication_denied());
        };
        let Some(peer) = peer.copied() else {
            return Err(authentication_denied());
        };
        if !process_is_descendant_or_same(peer, *root) {
            return Err(authentication_denied());
        }
        Ok(record.metadata.clone())
    }

    pub(crate) fn bind_agent_process(
        &self,
        authentication: &SessionAuthentication,
        peer: PeerProcessIdentity,
        registration: &AgentSessionRegisterArguments,
    ) -> AppResult<AuthenticatedSession> {
        if !registration.validate()
            || !std::path::Path::new(&registration.launcher_executable).is_absolute()
        {
            return Err(authentication_denied());
        }
        let terminal_session_id = TerminalSessionId::from(authentication.terminal_session_id);
        let mut record = self
            .sessions
            .get_mut(&terminal_session_id)
            .ok_or_else(authentication_denied)?;
        if record.metadata.runtime_id != self.runtime_id {
            return Err(authentication_denied());
        }
        if record.metadata.expires_at <= Utc::now() {
            drop(record);
            self.sessions.remove(&terminal_session_id);
            return Err(authentication_denied());
        }
        let supplied_token = authentication.token().ok_or_else(authentication_denied)?;
        let mut supplied = Zeroizing::new([0u8; SESSION_TOKEN_BYTES]);
        if hex::decode_to_slice(supplied_token, supplied.as_mut()).is_err() {
            return Err(authentication_denied());
        }
        let authorized = matches!(
            &record.authorization,
            SessionAuthorization::AgentBootstrap {
                token,
                registration: expected,
            } if expected == registration
                && bool::from(token.as_ref().ct_eq(supplied.as_ref()))
        );
        if !authorized {
            return Err(authentication_denied());
        }
        let authenticated = record.metadata.clone();
        // Replacing the bootstrap state drops and zeroizes the only Broker-held
        // bearer allocation while the map entry remains locked. A second
        // registration therefore cannot race or reuse the capability.
        record.authorization = SessionAuthorization::AgentProcess(peer);
        Ok(authenticated)
    }

    fn authenticate_bearer(
        &self,
        authentication: &SessionAuthentication,
    ) -> AppResult<AuthenticatedSession> {
        let terminal_session_id = TerminalSessionId::from(authentication.terminal_session_id);
        let Some(record) = self.sessions.get(&terminal_session_id) else {
            return Err(authentication_denied());
        };
        if record.metadata.runtime_id != self.runtime_id || record.metadata.expires_at <= Utc::now()
        {
            drop(record);
            self.sessions.remove(&terminal_session_id);
            return Err(authentication_denied());
        }
        let SessionAuthorization::Bearer(expected) = &record.authorization else {
            return Err(authentication_denied());
        };
        let token = authentication.token().ok_or_else(authentication_denied)?;
        let mut supplied = Zeroizing::new([0u8; SESSION_TOKEN_BYTES]);
        if hex::decode_to_slice(token, supplied.as_mut()).is_err()
            || !bool::from(expected.as_ref().ct_eq(supplied.as_ref()))
        {
            return Err(authentication_denied());
        }
        Ok(record.metadata.clone())
    }

    pub(crate) fn revoke(&self, terminal_session_id: TerminalSessionId) -> bool {
        self.sessions.remove(&terminal_session_id).is_some()
    }

    pub(crate) fn revoke_connection(&self, connection_id: ConnectionId) -> usize {
        let ids = self
            .sessions
            .iter()
            .filter_map(|entry| {
                (entry.metadata.connection_id == connection_id).then_some(*entry.key())
            })
            .collect::<Vec<_>>();
        let count = ids.len();
        for id in ids {
            self.sessions.remove(&id);
        }
        count
    }

    pub(crate) fn revoke_all(&self) {
        self.sessions.clear();
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.sessions.len()
    }
}

fn authentication_denied() -> AppError {
    AppError::Blocked {
        reason: "terminal session authentication was denied".into(),
    }
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use std::collections::HashMap;

    use crate::features::workspaces::WorkspaceKind;
    use crate::model::{
        ConnectionProfile, Engine, Provider, WorkspaceConnectionAccess, WorkspaceCredentialMode,
    };
    use crate::store::{AccountScope, ActiveResourceScope, CatalogCachePolicy};

    use super::*;

    fn registration(adapter: dopedb_protocol::OfficialAcpAdapter) -> AgentSessionRegisterArguments {
        AgentSessionRegisterArguments {
            adapter,
            launcher_executable: if cfg!(windows) {
                r"C:\Program Files\nodejs\npx.cmd".into()
            } else {
                "/usr/bin/npx".into()
            },
            launcher_resolved_executable: if cfg!(windows) {
                r"C:\Program Files\nodejs\npx.cmd".into()
            } else {
                "/usr/bin/npx".into()
            },
            launcher_sha256: "ab".repeat(32),
        }
    }

    fn pin(connection_id: Uuid) -> PinnedConnection {
        PinnedConnection {
            scope: ActiveResourceScope {
                workspace_id: Uuid::nil(),
                workspace_kind: WorkspaceKind::Personal,
                selected_account_id: None,
                account_scope: AccountScope::Personal,
                generation: 7,
            },
            connection_id,
            connection_revision: 11,
            binding_revision: 3,
            binding_updated_at: Utc::now().to_rfc3339(),
            profile: ConnectionProfile {
                id: connection_id,
                name: "fixture".into(),
                engine: Engine::Sqlite,
                provider: Provider::Auto,
                driver_id: None,
                host: String::new(),
                port: 0,
                database: ":memory:".into(),
                username: String::new(),
                sslmode: "disable".into(),
                extra_params: HashMap::new(),
                readonly_default: true,
                allow_writes: false,
                secret_ref: None,
                env: Some("dev".into()),
                schema_group: None,
                workspace_access: WorkspaceConnectionAccess::Local,
                credential_mode: WorkspaceCredentialMode::Local,
                provider_target: None,
            },
            requires_remote_rbac: false,
            catalog_cache_policy: CatalogCachePolicy::Persistent,
        }
    }

    #[test]
    fn capability_is_256_bit_redacted_and_memory_only() {
        let runtime_id = RuntimeId::from(Uuid::new_v4());
        let registry = BrokerSessionRegistry::new(runtime_id);
        let session_id = TerminalSessionId::from(Uuid::new_v4());
        let issued = registry
            .issue(
                session_id,
                &pin(Uuid::new_v4()),
                [BrokerCapability::QueryPlan],
                Duration::from_secs(60),
            )
            .unwrap();
        assert_eq!(issued.token().len(), SESSION_TOKEN_BYTES * 2);
        assert!(hex::decode(issued.token()).is_ok());
        let debug = format!("{issued:?}");
        assert!(debug.contains("<redacted>"));
        assert!(!debug.contains(issued.token()));
        assert_eq!(issued.terminal_session_id, session_id);
        assert_eq!(registry.len(), 1);
    }

    #[test]
    fn authentication_is_exact_scope_capability_and_revocation_bound() {
        let runtime_id =
            RuntimeId::from(Uuid::from_str("018f0000-1111-7222-8333-444455556666").unwrap());
        let connection_id = ConnectionId::from(Uuid::new_v4());
        let terminal_session_id = TerminalSessionId::from(Uuid::new_v4());
        let registry = BrokerSessionRegistry::new(runtime_id);
        let issued = registry
            .issue(
                terminal_session_id,
                &pin(connection_id.into()),
                [BrokerCapability::QueryPlan],
                Duration::from_secs(60),
            )
            .unwrap();
        let authentication = SessionAuthentication::new(
            issued.terminal_session_id.into(),
            issued.token().to_owned(),
        );
        let authenticated = registry.authenticate(&authentication, None).unwrap();
        assert_eq!(authenticated.terminal_session_id, terminal_session_id);
        assert_eq!(authenticated.runtime_id, runtime_id);
        assert_eq!(authenticated.connection_id, connection_id);
        assert_eq!(authenticated.connection_revision, 11);
        assert_eq!(authenticated.scope_generation, 7);
        assert!(authenticated.require(BrokerCapability::QueryPlan).is_ok());
        assert!(authenticated.require(BrokerCapability::SqlPropose).is_err());

        let wrong = SessionAuthentication::new(issued.terminal_session_id.into(), "00".repeat(32));
        assert!(registry.authenticate(&wrong, None).is_err());

        let root = super::super::peer::current_process_identity_for_test().unwrap();
        let descriptor = registration(dopedb_protocol::OfficialAcpAdapter::Claude);
        assert!(registry
            .bind_agent_process(&authentication, root, &descriptor)
            .is_err());

        let agent_session_id = TerminalSessionId::from(Uuid::new_v4());
        let agent = registry
            .issue_agent(
                agent_session_id,
                &pin(connection_id.into()),
                [BrokerCapability::QueryPlan],
                Duration::from_secs(60),
                descriptor.clone(),
            )
            .unwrap();
        let agent_authentication =
            SessionAuthentication::new(agent.terminal_session_id.into(), agent.token().to_owned());
        // Bootstrap capabilities are command-specific and cannot authorize a
        // normal Broker command before registration.
        assert!(registry.authenticate(&agent_authentication, None).is_err());
        let mut wrong_descriptor = descriptor.clone();
        wrong_descriptor.adapter = dopedb_protocol::OfficialAcpAdapter::Codex;
        assert!(registry
            .bind_agent_process(&agent_authentication, root, &wrong_descriptor)
            .is_err());
        registry
            .bind_agent_process(&agent_authentication, root, &descriptor)
            .unwrap();
        // Registration consumes the bearer atomically; neither ordinary use
        // nor a second registration may reuse it.
        assert!(registry.authenticate(&agent_authentication, None).is_err());
        assert!(registry
            .bind_agent_process(&agent_authentication, root, &descriptor)
            .is_err());

        let process_bound = SessionAuthentication::process_bound(agent_session_id.into());
        assert!(registry.authenticate(&process_bound, Some(&root)).is_ok());
        let reused_pid = super::super::peer::PeerProcessIdentity::for_test(
            root.pid(),
            root.started_at().saturating_add(1),
        );
        assert!(registry
            .authenticate(&process_bound, Some(&reused_pid))
            .is_err());
        let unrelated =
            super::super::peer::PeerProcessIdentity::for_test(root.pid().saturating_add(1), 0);
        assert!(registry
            .authenticate(&process_bound, Some(&unrelated))
            .is_err());
        assert!(registry.revoke(agent_session_id));
        assert!(registry.authenticate(&process_bound, Some(&root)).is_err());
        assert!(registry.revoke(terminal_session_id));
        assert!(registry.authenticate(&authentication, None).is_err());
    }

    #[test]
    fn connection_revocation_removes_only_matching_sessions() {
        let registry = BrokerSessionRegistry::new(RuntimeId::from(Uuid::new_v4()));
        let first_connection = ConnectionId::from(Uuid::new_v4());
        let second_connection = ConnectionId::from(Uuid::new_v4());
        registry
            .issue(
                TerminalSessionId::from(Uuid::new_v4()),
                &pin(first_connection.into()),
                [BrokerCapability::ConnectionRead],
                Duration::from_secs(60),
            )
            .unwrap();
        registry
            .issue(
                TerminalSessionId::from(Uuid::new_v4()),
                &pin(second_connection.into()),
                [BrokerCapability::ConnectionRead],
                Duration::from_secs(60),
            )
            .unwrap();
        assert_eq!(registry.revoke_connection(first_connection), 1);
        assert_eq!(registry.len(), 1);
    }

    #[test]
    fn expired_capability_is_rejected_and_eagerly_removed() {
        let registry = BrokerSessionRegistry::new(RuntimeId::from(Uuid::new_v4()));
        let issued = registry
            .issue(
                TerminalSessionId::from(Uuid::new_v4()),
                &pin(Uuid::new_v4()),
                [BrokerCapability::ConnectionRead],
                Duration::from_millis(1),
            )
            .unwrap();
        let authentication = SessionAuthentication::new(
            issued.terminal_session_id.into(),
            issued.token().to_owned(),
        );
        std::thread::sleep(Duration::from_millis(5));
        assert!(registry.authenticate(&authentication, None).is_err());
        assert_eq!(registry.len(), 0);
    }
}
