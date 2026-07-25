use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use uuid::Uuid;
use zeroize::Zeroizing;

use super::domain::DriverDescriptor;
use super::ports::{
    AdHocConnectionPort, AuthorizedConnectionPort, ConnectionCredentialVault,
    ConnectionMutationPort, ConnectionPermission, ConnectionRepositoryPort, ConnectionRuntimePort,
    DriverRegistryPort, ScopeMutationPort,
};
use super::ConnectionUseCases;
use crate::error::{AppError, AppResult};
use crate::kernel::identity::{AccountScopeId, ConnectionId, WorkspaceId};
use crate::kernel::TerminalAuthority;
use crate::model::{
    ConnectionProfile, Engine, Provider, WorkspaceConnectionAccess, WorkspaceCredentialMode,
};

#[derive(Clone)]
struct GuardCheckingRepository {
    guard_alive: Arc<AtomicBool>,
    profile: ConnectionProfile,
}

impl ConnectionRepositoryPort for GuardCheckingRepository {
    async fn list(&self) -> AppResult<Vec<ConnectionProfile>> {
        assert!(
            self.guard_alive.load(Ordering::SeqCst),
            "authority guard must cover the repository read"
        );
        Ok(vec![self.profile.clone()])
    }

    async fn ensure_write_scope(&self, _id: ConnectionId) -> AppResult<()> {
        unreachable!()
    }

    async fn upsert(&self, _profile: &ConnectionProfile) -> AppResult<ConnectionProfile> {
        unreachable!()
    }

    async fn clear_schema_cache(&self, _id: ConnectionId) -> AppResult<()> {
        unreachable!()
    }

    async fn set_schema_group(
        &self,
        _ids: &[ConnectionId],
        _schema_group: Option<String>,
    ) -> AppResult<()> {
        unreachable!()
    }

    async fn delete(&self, _id: ConnectionId) -> AppResult<()> {
        unreachable!()
    }

    async fn get(&self, _id: ConnectionId) -> AppResult<ConnectionProfile> {
        unreachable!()
    }
}

struct NoopScopeMutation;

impl ScopeMutationPort for NoopScopeMutation {
    async fn retire_connection(self, _id: ConnectionId) {}
    async fn retire_connections(self, _ids: &[ConnectionId]) {}
}

struct NoopConnectionMutation;

impl ConnectionMutationPort for NoopConnectionMutation {
    fn profile(&self) -> &ConnectionProfile {
        unreachable!()
    }

    async fn retire_connection(self, _id: ConnectionId) {}
}

struct GuardProbe {
    guard_alive: Arc<AtomicBool>,
    profile: ConnectionProfile,
}

impl Drop for GuardProbe {
    fn drop(&mut self) {
        self.guard_alive.store(false, Ordering::SeqCst);
    }
}

impl AuthorizedConnectionPort for GuardProbe {
    fn profile(&self) -> &ConnectionProfile {
        &self.profile
    }

    async fn test_fresh(self) -> AppResult<()> {
        Ok(())
    }
}

#[derive(Clone)]
struct GuardProbeRuntime {
    guard_alive: Arc<AtomicBool>,
    profile: ConnectionProfile,
}

impl ConnectionRuntimePort for GuardProbeRuntime {
    type ScopeMutation = NoopScopeMutation;
    type ConnectionMutation = NoopConnectionMutation;
    type AuthorizedConnection = GuardProbe;

    async fn begin_scope_mutation(&self) -> Self::ScopeMutation {
        unreachable!()
    }

    async fn begin_connection_mutation(
        &self,
        _id: ConnectionId,
        _permission: ConnectionPermission,
    ) -> AppResult<Self::ConnectionMutation> {
        unreachable!()
    }

    async fn authorize(
        &self,
        _id: ConnectionId,
        _permission: ConnectionPermission,
    ) -> AppResult<Self::AuthorizedConnection> {
        unreachable!()
    }

    async fn authorize_terminal(
        &self,
        _authority: &TerminalAuthority,
        _permission: ConnectionPermission,
    ) -> AppResult<Self::AuthorizedConnection> {
        self.guard_alive.store(true, Ordering::SeqCst);
        Ok(GuardProbe {
            guard_alive: Arc::clone(&self.guard_alive),
            profile: self.profile.clone(),
        })
    }
}

#[derive(Clone, Copy)]
struct NoopDrivers;

impl DriverRegistryPort for NoopDrivers {
    fn list(&self) -> Vec<DriverDescriptor> {
        Vec::new()
    }

    fn install(&self, _id: &str) -> AppResult<DriverDescriptor> {
        Err(AppError::Config("unused test port".into()))
    }

    fn validate(&self, _profile: &ConnectionProfile) -> AppResult<()> {
        Ok(())
    }
}

#[derive(Clone, Copy)]
struct NoopTester;

impl AdHocConnectionPort for NoopTester {
    async fn test(
        &self,
        _profile: &ConnectionProfile,
        _password: Zeroizing<String>,
    ) -> AppResult<()> {
        Ok(())
    }
}

struct NoopCredentials;

impl ConnectionCredentialVault for NoopCredentials {
    fn fetch_profile(&self, _profile: &ConnectionProfile) -> AppResult<Zeroizing<String>> {
        unreachable!()
    }

    fn store(&self, _id: &Uuid, _secret: &str) -> AppResult<()> {
        Ok(())
    }

    fn delete(&self, _id: &Uuid) -> AppResult<()> {
        Ok(())
    }
}

fn profile(id: Uuid) -> ConnectionProfile {
    ConnectionProfile {
        id,
        name: "alpha".into(),
        engine: Engine::Sqlite,
        provider: Provider::Generic,
        driver_id: Some("sqlx-sqlite".into()),
        host: String::new(),
        port: 0,
        database: ":memory:".into(),
        username: String::new(),
        sslmode: "disable".into(),
        extra_params: HashMap::new(),
        readonly_default: true,
        allow_writes: false,
        secret_ref: None,
        env: None,
        schema_group: None,
        workspace_access: WorkspaceConnectionAccess::Local,
        credential_mode: WorkspaceCredentialMode::Local,
    }
}

#[tokio::test]
async fn terminal_name_resolution_holds_authority_through_repository_read() {
    let id = Uuid::new_v4();
    let profile = profile(id);
    let guard_alive = Arc::new(AtomicBool::new(false));
    let use_cases = ConnectionUseCases::new(
        GuardCheckingRepository {
            guard_alive: Arc::clone(&guard_alive),
            profile: profile.clone(),
        },
        GuardProbeRuntime {
            guard_alive: Arc::clone(&guard_alive),
            profile,
        },
        NoopDrivers,
        NoopTester,
        Arc::new(NoopCredentials),
    );
    let authority = TerminalAuthority {
        terminal_session_id: Uuid::new_v4(),
        workspace_id: WorkspaceId::from(Uuid::new_v4()),
        account_scope: AccountScopeId::new("personal").unwrap(),
        scope_generation: 1,
        connection_id: ConnectionId::from(id),
        connection_revision: 1,
        client_protocol_version: dopedb_protocol::PROTOCOL_MAX,
    };

    let resolved = use_cases
        .resolve_terminal_cli(&authority, "alpha")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(resolved.id, ConnectionId::from(id));
    assert!(!guard_alive.load(Ordering::SeqCst));
}
