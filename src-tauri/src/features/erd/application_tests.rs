use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use crate::error::AppResult;
use crate::kernel::identity::{
    AccountScopeId, ConnectionErdLayoutId, ConnectionId, ErdLayoutId, WorkspaceConnectionId,
    WorkspaceId,
};

use super::application::{ErdUseCases, SaveErdLayoutRequest};
use super::domain::{ErdCanvasLayout, ErdLayout, ErdLayoutMode, ErdViewport};
use super::ports::{
    ErdAuthority, ErdAuthorityGuard, ErdAuthorityPort, ErdGeneratorPort, ErdRepositoryPort,
    SaveErdLayoutCommand, SaveErdRepositoryOutcome,
};

#[derive(Clone)]
struct FakeAuthority {
    value: ErdAuthority,
    calls: Arc<AtomicUsize>,
}

struct FakeGuard {
    value: ErdAuthority,
}

impl ErdAuthorityGuard for FakeGuard {
    fn authority(&self) -> &ErdAuthority {
        &self.value
    }
}

impl ErdAuthorityPort for FakeAuthority {
    type Guard = FakeGuard;

    async fn authorize(&self, connection_id: ConnectionId) -> AppResult<Self::Guard> {
        assert_eq!(connection_id, self.value.resource.connection_id);
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(FakeGuard {
            value: self.value.clone(),
        })
    }
}

#[derive(Default)]
struct FakeRepositoryState {
    command: Option<SaveErdLayoutCommand>,
    save_outcome: Option<SaveErdRepositoryOutcome>,
    delete_result: bool,
}

#[derive(Clone, Default)]
struct FakeRepository {
    state: Arc<Mutex<FakeRepositoryState>>,
}

impl ErdRepositoryPort for FakeRepository {
    async fn list(&self, _authority: &ErdAuthority) -> AppResult<Vec<ErdLayout>> {
        Ok(Vec::new())
    }

    async fn save(
        &self,
        _authority: &ErdAuthority,
        command: SaveErdLayoutCommand,
    ) -> AppResult<SaveErdRepositoryOutcome> {
        let mut state = self.state.lock().unwrap();
        state.command = Some(command);
        Ok(state.save_outcome.clone().unwrap())
    }

    async fn delete(
        &self,
        _authority: &ErdAuthority,
        _id: ErdLayoutId,
        _expected_revision: i64,
        _deleted_at: String,
    ) -> AppResult<bool> {
        Ok(self.state.lock().unwrap().delete_result)
    }
}

#[derive(Clone, Copy)]
struct FakeGenerator {
    id: ErdLayoutId,
}

impl ErdGeneratorPort for FakeGenerator {
    fn next_id(&self) -> ErdLayoutId {
        self.id
    }

    fn now(&self) -> String {
        "2026-07-25T00:00:00Z".into()
    }
}

fn ids() -> (ConnectionId, ErdLayoutId) {
    (
        ConnectionId::from(uuid::Uuid::from_u128(1)),
        ErdLayoutId::from(uuid::Uuid::from_u128(2)),
    )
}

fn authority(connection_id: ConnectionId) -> ErdAuthority {
    ErdAuthority {
        resource: WorkspaceConnectionId {
            workspace_id: WorkspaceId::from(uuid::Uuid::from_u128(3)),
            connection_id,
        },
        account_scope: AccountScopeId::new("personal").unwrap(),
    }
}

fn request(connection_id: ConnectionId) -> SaveErdLayoutRequest {
    SaveErdLayoutRequest {
        id: None,
        connection_id,
        name: " Main ".into(),
        mode: ErdLayoutMode::Physical,
        catalog_fingerprint: "a".repeat(64),
        layout: ErdCanvasLayout {
            nodes: Vec::new(),
            viewport: ErdViewport {
                x: 0.0,
                y: 0.0,
                zoom: 1.0,
            },
            compact: false,
            hidden_relation_keys: Vec::new(),
        },
        virtual_relations: Vec::new(),
        expected_revision: None,
    }
}

fn layout(connection_id: ConnectionId, id: ErdLayoutId) -> ErdLayout {
    ErdLayout {
        id,
        connection_id,
        name: "Main".into(),
        mode: ErdLayoutMode::Physical,
        catalog_fingerprint: "a".repeat(64),
        layout: request(connection_id).layout,
        virtual_relations: Vec::new(),
        revision: 1,
        remote_id: None,
        remote_revision: None,
        sync_status: "local".into(),
        created_at: "2026-07-25T00:00:00Z".into(),
        updated_at: "2026-07-25T00:00:00Z".into(),
    }
}

#[tokio::test]
async fn create_validates_before_authorizing_and_normalizes_name() {
    let (connection_id, layout_id) = ids();
    let calls = Arc::new(AtomicUsize::new(0));
    let repository = FakeRepository::default();
    repository.state.lock().unwrap().save_outcome = Some(SaveErdRepositoryOutcome::Saved(layout(
        connection_id,
        layout_id,
    )));
    let use_cases = ErdUseCases::new(
        repository.clone(),
        FakeAuthority {
            value: authority(connection_id),
            calls: calls.clone(),
        },
        FakeGenerator { id: layout_id },
    );

    let outcome = use_cases.save(request(connection_id)).await.unwrap();

    assert!(outcome.saved);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let state = repository.state.lock().unwrap();
    let Some(SaveErdLayoutCommand::Create { id, payload, .. }) = &state.command else {
        panic!("expected a create command");
    };
    assert_eq!(*id, layout_id);
    assert_eq!(payload.name, "Main");
}

#[tokio::test]
async fn invalid_existing_revision_never_crosses_the_authority_boundary() {
    let (connection_id, layout_id) = ids();
    let calls = Arc::new(AtomicUsize::new(0));
    let use_cases = ErdUseCases::new(
        FakeRepository::default(),
        FakeAuthority {
            value: authority(connection_id),
            calls: calls.clone(),
        },
        FakeGenerator { id: layout_id },
    );
    let mut invalid = request(connection_id);
    invalid.id = Some(layout_id);
    invalid.expected_revision = None;

    assert!(use_cases.save(invalid).await.is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn repository_conflicts_are_returned_without_overwriting_the_current_layout() {
    let (connection_id, layout_id) = ids();
    let repository = FakeRepository::default();
    repository.state.lock().unwrap().save_outcome = Some(SaveErdRepositoryOutcome::Conflict(
        layout(connection_id, layout_id),
    ));
    let use_cases = ErdUseCases::new(
        repository,
        FakeAuthority {
            value: authority(connection_id),
            calls: Arc::new(AtomicUsize::new(0)),
        },
        FakeGenerator { id: layout_id },
    );
    let mut update = request(connection_id);
    update.id = Some(layout_id);
    update.expected_revision = Some(1);

    let outcome = use_cases.save(update).await.unwrap();
    assert!(!outcome.saved);
    assert_eq!(outcome.layout.id, layout_id);
}

#[tokio::test]
async fn delete_requires_the_connection_scoped_layout_identity() {
    let (connection_id, layout_id) = ids();
    let repository = FakeRepository::default();
    repository.state.lock().unwrap().delete_result = true;
    let use_cases = ErdUseCases::new(
        repository,
        FakeAuthority {
            value: authority(connection_id),
            calls: Arc::new(AtomicUsize::new(0)),
        },
        FakeGenerator { id: layout_id },
    );

    use_cases
        .delete(
            ConnectionErdLayoutId {
                connection_id,
                layout_id,
            },
            1,
        )
        .await
        .unwrap();
}
