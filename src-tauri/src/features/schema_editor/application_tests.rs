use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use chrono::{TimeZone, Utc};
use dopedb_protocol::{
    CatalogContents, CatalogSnapshot, DatabaseEngine, DdlPlan, ObjectKind, ObjectRef,
    OperationState, SchemaChange, SchemaChangeRequest,
};
use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::kernel::identity::{ConnectionId, OperationId};

use super::application::SchemaEditorUseCases;
use super::domain::{SchemaChangeCommand, SchemaScriptProposal, SchemaScriptProposalCommand};
use super::ports::{SchemaCatalogPort, SchemaPlannerPort, SchemaScriptPort};

#[derive(Clone)]
struct FakeCatalog {
    snapshot: CatalogSnapshot,
    calls: Arc<AtomicUsize>,
}

impl SchemaCatalogPort for FakeCatalog {
    async fn refresh(&self, connection_id: ConnectionId) -> AppResult<CatalogSnapshot> {
        assert_eq!(
            connection_id,
            ConnectionId::from(self.snapshot.connection_id())
        );
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(self.snapshot.clone())
    }
}

#[derive(Clone)]
struct FakePlanner {
    plan: DdlPlan,
    fail: bool,
    calls: Arc<AtomicUsize>,
}

impl SchemaPlannerPort for FakePlanner {
    fn render(
        &self,
        snapshot: &CatalogSnapshot,
        request: &SchemaChangeRequest,
    ) -> AppResult<DdlPlan> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        assert_eq!(snapshot.fingerprint(), request.catalog_fingerprint);
        if self.fail {
            Err(AppError::Blocked {
                reason: "stale catalog".into(),
            })
        } else {
            Ok(self.plan.clone())
        }
    }
}

#[derive(Debug, Clone, Serialize)]
struct FakeRunReceipt;

#[derive(Clone)]
struct FakeScript {
    command: Arc<Mutex<Option<SchemaScriptProposalCommand>>>,
    calls: Arc<AtomicUsize>,
}

impl SchemaScriptPort for FakeScript {
    type RunReceipt = FakeRunReceipt;

    async fn propose(
        &self,
        command: SchemaScriptProposalCommand,
    ) -> AppResult<SchemaScriptProposal> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        *self.command.lock().unwrap() = Some(command);
        Ok(SchemaScriptProposal {
            operation_id: OperationId::from(uuid::Uuid::from_u128(9)),
            payload_hash: "hash".into(),
            state: OperationState::PendingApproval,
            confirmation_phrase: Some("APPLY".into()),
            statement_count: 1,
            expires_at: Utc.with_ymd_and_hms(2026, 7, 25, 1, 0, 0).unwrap(),
        })
    }

    async fn run(&self, _operation_id: OperationId) -> AppResult<Self::RunReceipt> {
        Ok(FakeRunReceipt)
    }
}

fn fixture() -> (SchemaChangeCommand, DdlPlan) {
    let raw_id = uuid::Uuid::from_u128(7);
    let snapshot = CatalogSnapshot::capture(
        raw_id,
        DatabaseEngine::Postgres,
        "app",
        Utc.with_ymd_and_hms(2026, 7, 25, 0, 0, 0).unwrap(),
        CatalogContents::default(),
    )
    .unwrap();
    let request = SchemaChangeRequest::new(
        snapshot.fingerprint(),
        SchemaChange::DropTable {
            relation: ObjectRef {
                catalog: None,
                namespace: Some("public".into()),
                name: "users".into(),
                kind: ObjectKind::Table,
                native_id: None,
            },
        },
    );
    let plan = DdlPlan {
        schema_version: 1,
        engine: DatabaseEngine::Postgres,
        catalog_fingerprint: snapshot.fingerprint().into(),
        statements: vec!["DROP TABLE \"public\".\"users\";".into()],
        transactional: true,
        requires_rebuild: false,
        warnings: Vec::new(),
    };
    (
        SchemaChangeCommand {
            connection_id: ConnectionId::from(raw_id),
            request,
        },
        plan,
    )
}

type FakeUseCases = SchemaEditorUseCases<FakeCatalog, FakePlanner, FakeScript>;

struct Harness {
    use_cases: FakeUseCases,
    catalog_calls: Arc<AtomicUsize>,
    planner_calls: Arc<AtomicUsize>,
    script_calls: Arc<AtomicUsize>,
    captured: Arc<Mutex<Option<SchemaScriptProposalCommand>>>,
}

fn use_cases(command: &SchemaChangeCommand, plan: DdlPlan, planner_fails: bool) -> Harness {
    let snapshot = CatalogSnapshot::capture(
        command.connection_id.into(),
        plan.engine,
        "app",
        Utc.with_ymd_and_hms(2026, 7, 25, 0, 0, 0).unwrap(),
        CatalogContents::default(),
    )
    .unwrap();
    assert_eq!(snapshot.fingerprint(), command.request.catalog_fingerprint);
    let catalog_calls = Arc::new(AtomicUsize::new(0));
    let planner_calls = Arc::new(AtomicUsize::new(0));
    let script_calls = Arc::new(AtomicUsize::new(0));
    let captured = Arc::new(Mutex::new(None));
    Harness {
        use_cases: SchemaEditorUseCases::new(
            FakeCatalog {
                snapshot,
                calls: catalog_calls.clone(),
            },
            FakePlanner {
                plan,
                fail: planner_fails,
                calls: planner_calls.clone(),
            },
            FakeScript {
                command: captured.clone(),
                calls: script_calls.clone(),
            },
        ),
        catalog_calls,
        planner_calls,
        script_calls,
        captured,
    }
}

#[tokio::test]
async fn proposal_refreshes_catalog_and_persists_the_exact_rendered_plan() {
    let (command, plan) = fixture();
    let harness = use_cases(&command, plan.clone(), false);

    let proposal = harness.use_cases.propose(command.clone()).await.unwrap();

    assert_eq!(harness.catalog_calls.load(Ordering::SeqCst), 1);
    assert_eq!(harness.planner_calls.load(Ordering::SeqCst), 1);
    assert_eq!(harness.script_calls.load(Ordering::SeqCst), 1);
    assert_eq!(proposal.plan, plan);
    let captured = harness.captured.lock().unwrap();
    let captured = captured.as_ref().unwrap();
    assert_eq!(captured.connection_id, command.connection_id);
    assert_eq!(captured.request, command.request);
    assert_eq!(captured.plan, proposal.plan);
}

#[tokio::test]
async fn planning_failure_never_reaches_the_script_operation_boundary() {
    let (command, plan) = fixture();
    let harness = use_cases(&command, plan, true);

    assert!(harness.use_cases.propose(command).await.is_err());
    assert_eq!(harness.catalog_calls.load(Ordering::SeqCst), 1);
    assert_eq!(harness.planner_calls.load(Ordering::SeqCst), 1);
    assert_eq!(harness.script_calls.load(Ordering::SeqCst), 0);
}
