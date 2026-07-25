use std::collections::HashMap;
use std::str::FromStr;
use std::sync::{Arc, Mutex};

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use uuid::Uuid;
use zeroize::Zeroizing;

use super::adapters::{
    RuntimeConnectionAuthority, SqliteConnectionRepository, SystemAdHocConnection,
    SystemDriverRegistry,
};
use super::{
    ConnectionCredentialVault, ConnectionProfileTestRequest, ConnectionUpsertRequest,
    ConnectionUseCases, MAX_CONNECTION_CREDENTIAL_BYTES,
};
use crate::connection::{ConnectionAccess, ConnectionManager};
use crate::error::{AppError, AppResult};
use crate::kernel::identity::{AccountScopeId, ConnectionId, WorkspaceId};
use crate::kernel::TerminalAuthority;
use crate::model::{
    ConnectionProfile, Engine, Provider, WorkspaceConnectionAccess, WorkspaceCredentialMode,
};
use crate::store::{Store, TEST_SCHEMA};

#[derive(Default)]
struct MemoryCredentials {
    items: Mutex<HashMap<Uuid, String>>,
}

impl MemoryCredentials {
    fn snapshot(&self) -> HashMap<Uuid, String> {
        self.items.lock().unwrap().clone()
    }
}

impl ConnectionCredentialVault for MemoryCredentials {
    fn fetch_profile(&self, profile: &ConnectionProfile) -> AppResult<Zeroizing<String>> {
        let secret_ref = profile
            .secret_ref
            .as_deref()
            .ok_or_else(|| AppError::NotFound("missing test credential reference".into()))?;
        let id = Uuid::parse_str(secret_ref)
            .map_err(|_| AppError::Config("invalid test credential reference".into()))?;
        self.items
            .lock()
            .unwrap()
            .get(&id)
            .cloned()
            .map(Zeroizing::new)
            .ok_or_else(|| AppError::NotFound(format!("test credential {id}")))
    }

    fn store(&self, id: &Uuid, secret: &str) -> AppResult<()> {
        self.items.lock().unwrap().insert(*id, secret.to_string());
        Ok(())
    }

    fn delete(&self, id: &Uuid) -> AppResult<()> {
        self.items.lock().unwrap().remove(id);
        Ok(())
    }
}

type TestConnections = ConnectionUseCases<
    SqliteConnectionRepository,
    RuntimeConnectionAuthority,
    SystemDriverRegistry,
    SystemAdHocConnection,
    MemoryCredentials,
>;

async fn harness() -> (
    TestConnections,
    Store,
    ConnectionManager,
    Arc<MemoryCredentials>,
) {
    let options = SqliteConnectOptions::from_str("sqlite::memory:")
        .unwrap()
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap();
    sqlx::raw_sql(TEST_SCHEMA).execute(&pool).await.unwrap();
    let store = Store::from_pool_for_test(pool);
    let manager = ConnectionManager::new(store.clone());
    let credentials = Arc::new(MemoryCredentials::default());
    let feature = ConnectionUseCases::new(
        SqliteConnectionRepository::new(store.clone()),
        RuntimeConnectionAuthority::new(manager.clone()),
        SystemDriverRegistry,
        SystemAdHocConnection,
        Arc::clone(&credentials),
    );
    (feature, store, manager, credentials)
}

fn local_profile(id: Uuid, name: &str, engine: Engine) -> ConnectionProfile {
    let (driver_id, port, database) = match engine {
        Engine::Postgres => ("sqlx-postgres", 5432, "postgres"),
        Engine::Mysql => ("sqlx-mysql", 3306, "mysql"),
        Engine::Sqlite => ("sqlx-sqlite", 0, ":memory:"),
        Engine::Mongodb => ("mongodb-rust", 27017, "admin"),
    };
    ConnectionProfile {
        id,
        name: name.into(),
        engine,
        provider: Provider::Generic,
        driver_id: Some(driver_id.into()),
        host: "localhost".into(),
        port,
        database: database.into(),
        username: "tester".into(),
        sslmode: "disable".into(),
        extra_params: HashMap::new(),
        readonly_default: true,
        allow_writes: false,
        secret_ref: None,
        env: Some("test".into()),
        schema_group: None,
        workspace_access: WorkspaceConnectionAccess::Local,
        credential_mode: WorkspaceCredentialMode::Local,
    }
}

#[tokio::test]
async fn terminal_list_discloses_only_the_pinned_connection() {
    let (feature, store, manager, _) = harness().await;
    let pinned_id = Uuid::new_v4();
    let sibling_id = Uuid::new_v4();
    for profile in [
        local_profile(pinned_id, "pinned", Engine::Sqlite),
        local_profile(sibling_id, "sibling", Engine::Sqlite),
    ] {
        feature
            .upsert(ConnectionUpsertRequest {
                profile,
                password: None,
            })
            .await
            .unwrap();
    }
    let context = manager
        .pin(pinned_id, ConnectionAccess::Read)
        .await
        .unwrap();
    let pin = context.pin();
    let authority = TerminalAuthority {
        terminal_session_id: Uuid::new_v4(),
        workspace_id: WorkspaceId::from(pin.scope.workspace_id),
        account_scope: AccountScopeId::new(pin.scope.account_scope.storage_key()).unwrap(),
        scope_generation: pin.scope.generation,
        connection_id: ConnectionId::from(pin.connection_id),
        connection_revision: pin.connection_revision,
        client_protocol_version: dopedb_protocol::PROTOCOL_MAX,
    };

    let listed = feature.list_terminal_summaries(&authority).await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(Uuid::from(listed[0].id), pinned_id);
    assert!(listed
        .iter()
        .all(|summary| Uuid::from(summary.id) != sibling_id));
    store.pool().close().await;
}

#[tokio::test]
async fn upsert_normalizes_metadata_and_ignores_an_ipc_secret_reference() {
    let (feature, store, _, credentials) = harness().await;
    let id = Uuid::new_v4();
    let mut draft = local_profile(id, "local", Engine::Sqlite);
    draft.schema_group = Some("  Core  ".into());
    draft.secret_ref = Some(Uuid::new_v4().to_string());

    let saved = feature
        .upsert(ConnectionUpsertRequest {
            profile: draft,
            password: None,
        })
        .await
        .unwrap();

    assert_eq!(saved.schema_group.as_deref(), Some("Core"));
    assert_eq!(saved.secret_ref, None);
    assert!(credentials.snapshot().is_empty());
    assert_eq!(store.get_connection(id).await.unwrap().secret_ref, None);
    store.pool().close().await;
}

#[tokio::test]
async fn credential_rotation_publishes_the_pointer_before_retiring_old_material() {
    let (feature, store, _, credentials) = harness().await;
    let id = Uuid::new_v4();
    let saved = feature
        .upsert(ConnectionUpsertRequest {
            profile: local_profile(id, "local", Engine::Sqlite),
            password: Some(Zeroizing::new("old-secret".into())),
        })
        .await
        .unwrap();
    let old_id = Uuid::parse_str(saved.secret_ref.as_deref().unwrap()).unwrap();

    let rotated = feature
        .upsert(ConnectionUpsertRequest {
            profile: saved,
            password: Some(Zeroizing::new("new-secret".into())),
        })
        .await
        .unwrap();
    let new_id = Uuid::parse_str(rotated.secret_ref.as_deref().unwrap()).unwrap();
    let snapshot = credentials.snapshot();
    assert_eq!(snapshot.len(), 1);
    assert_eq!(
        snapshot.get(&new_id).map(String::as_str),
        Some("new-secret")
    );
    assert!(!snapshot.contains_key(&old_id));
    assert_eq!(
        store
            .get_connection(id)
            .await
            .unwrap()
            .secret_ref
            .as_deref(),
        Some(new_id.to_string().as_str())
    );

    feature.delete(ConnectionId::from(id)).await.unwrap();
    assert!(credentials.snapshot().is_empty());
    assert!(matches!(
        store.get_connection(id).await,
        Err(AppError::NotFound(message)) if message == format!("connection {id}")
    ));
    store.pool().close().await;
}

#[tokio::test]
async fn a_failed_profile_commit_removes_the_unpublished_secret() {
    let (feature, store, _, credentials) = harness().await;
    let mut incompatible = local_profile(Uuid::new_v4(), "invalid", Engine::Sqlite);
    incompatible.credential_mode = WorkspaceCredentialMode::MemberLocal;

    let error = feature
        .upsert(ConnectionUpsertRequest {
            profile: incompatible,
            password: Some(Zeroizing::new("must-be-removed".into())),
        })
        .await
        .unwrap_err();

    assert!(matches!(
        error,
        AppError::Config(message)
            if message == "local connections must use local credential mode"
    ));
    assert!(credentials.snapshot().is_empty());
    assert!(feature.list_profiles().await.unwrap().is_empty());
    store.pool().close().await;
}

#[tokio::test]
async fn schema_group_batch_is_deduplicated_and_atomic() {
    let (feature, store, _, _) = harness().await;
    let alpha_id = Uuid::new_v4();
    let beta_id = Uuid::new_v4();
    let mysql_id = Uuid::new_v4();
    for profile in [
        local_profile(alpha_id, "alpha", Engine::Sqlite),
        local_profile(beta_id, "beta", Engine::Sqlite),
        local_profile(mysql_id, "mysql", Engine::Mysql),
    ] {
        feature
            .upsert(ConnectionUpsertRequest {
                profile,
                password: None,
            })
            .await
            .unwrap();
    }

    let updated = feature
        .set_schema_group(
            vec![
                ConnectionId::from(alpha_id),
                ConnectionId::from(alpha_id),
                ConnectionId::from(beta_id),
            ],
            Some("  Core  ".into()),
        )
        .await
        .unwrap();
    assert_eq!(updated.len(), 2);
    assert!(updated
        .iter()
        .all(|profile| profile.schema_group.as_deref() == Some("Core")));

    let error = feature
        .set_schema_group(vec![ConnectionId::from(mysql_id)], Some("core".into()))
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        AppError::Config(message)
            if message == "schema group 'core' already contains a different database engine"
    ));
    assert_eq!(
        store.get_connection(mysql_id).await.unwrap().schema_group,
        None
    );
    store.pool().close().await;
}

#[tokio::test]
async fn profile_test_rejects_shared_and_oversized_credentials_before_dialing() {
    let (feature, store, _, _) = harness().await;
    let mut shared = local_profile(Uuid::new_v4(), "shared", Engine::Sqlite);
    shared.workspace_access = WorkspaceConnectionAccess::Read;
    shared.credential_mode = WorkspaceCredentialMode::MemberLocal;
    assert!(matches!(
        feature
            .test_profile(ConnectionProfileTestRequest {
                profile: shared,
                password: None,
            })
            .await,
        Err(AppError::Blocked { reason })
            if reason == "shared connections must be tested through workspace authorization"
    ));

    let oversized = "x".repeat(MAX_CONNECTION_CREDENTIAL_BYTES + 1);
    assert!(matches!(
        feature
            .test_profile(ConnectionProfileTestRequest {
                profile: local_profile(Uuid::new_v4(), "local", Engine::Sqlite),
                password: Some(Zeroizing::new(oversized)),
            })
            .await,
        Err(AppError::Config(message))
            if message == "connection credential exceeds the size limit"
    ));
    assert!(feature.list_profiles().await.unwrap().is_empty());
    store.pool().close().await;
}

#[tokio::test]
async fn saved_test_preserves_the_workspace_view_only_error() {
    let (feature, store, _, _) = harness().await;
    let id = Uuid::new_v4();
    feature
        .upsert(ConnectionUpsertRequest {
            profile: local_profile(id, "view-only", Engine::Sqlite),
            password: None,
        })
        .await
        .unwrap();
    sqlx::query(
        "UPDATE connections
         SET workspace_access = 'view', revision = revision + 1
         WHERE id = ?1",
    )
    .bind(id.to_string())
    .execute(store.pool())
    .await
    .unwrap();

    assert!(matches!(
        feature.test(ConnectionId::from(id)).await,
        Err(AppError::Blocked { reason })
            if reason == "your workspace role cannot test this shared connection"
    ));
    store.pool().close().await;
}
