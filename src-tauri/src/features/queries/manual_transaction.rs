//! Connection-scoped manual SQL transactions.
//!
//! A session owns one physical SQLx connection plus the exact connection lease
//! that authorized it. Desktop SQL, table edits, and connection-pinned Agent
//! commands can therefore share one rollback boundary without exposing database
//! credentials or transaction handles to the renderer or CLI.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Instant;

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde::Serialize;
use sqlx::mysql::MySql;
use sqlx::pool::PoolConnection;
use sqlx::postgres::Postgres;
use sqlx::sqlite::Sqlite;
use sqlx::{AssertSqlSafe, Executor, SqlSafeStr};
use tokio::sync::{broadcast, Mutex};
use uuid::Uuid;

use crate::connection::{
    ConnectionAccess, ConnectionLease, ConnectionManager, ConnectionSessionRevocationPort, DbPool,
};
use crate::error::{AppError, AppResult};
use crate::executor;
use crate::model::{
    Classification, Engine, ExecOutcome, QueryKind, QueryResult, SafetySettings, ScriptStatement,
};
use crate::operations::ExecutionGrant;
use crate::store::Store;

const MANUAL_TRANSACTION_TTL: ChronoDuration = ChronoDuration::minutes(30);

fn database_mismatch() -> AppError {
    AppError::Blocked {
        reason: "the active manual transaction belongs to another database; commit or roll it back before switching".into(),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ManualTransactionPhase {
    Active,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManualTransactionStatus {
    pub(crate) transaction_id: Uuid,
    pub(crate) connection_id: Uuid,
    pub(crate) database: String,
    pub(crate) phase: ManualTransactionPhase,
    pub(crate) statement_count: u64,
    pub(crate) started_at: DateTime<Utc>,
    pub(crate) expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManualTransactionChanged {
    pub(crate) connection_id: Uuid,
    pub(crate) status: Option<ManualTransactionStatus>,
}

pub(crate) struct ManualScriptExecution {
    pub(crate) statements: Vec<ScriptStatement>,
}

pub(crate) struct ManualExecutionTarget<'a> {
    pub(crate) connection_id: Uuid,
    pub(crate) database: &'a str,
    pub(crate) namespace: Option<String>,
}

pub(crate) struct ManualScriptRequest<'a> {
    pub(crate) target: ManualExecutionTarget<'a>,
    pub(crate) statements: &'a [String],
    pub(crate) kinds: &'a [QueryKind],
    pub(crate) expected_affected: Option<&'a [u64]>,
    pub(crate) max_rows: u64,
    pub(crate) cancellation: &'a executor::cancel::CancelHandle,
    pub(crate) grant: &'a ExecutionGrant,
    pub(crate) contains_unsupported_kind: bool,
}

enum ManualConnection {
    Postgres(PoolConnection<Postgres>),
    Mysql(PoolConnection<MySql>),
    Sqlite(PoolConnection<Sqlite>),
}

impl ManualConnection {
    async fn begin(pool: &DbPool) -> AppResult<Self> {
        match pool {
            DbPool::Postgres(pool) => {
                let mut connection = pool.acquire().await?;
                sqlx::query("BEGIN").execute(&mut *connection).await?;
                Ok(Self::Postgres(connection))
            }
            DbPool::Mysql(pool) => {
                let mut connection = pool.acquire().await?;
                sqlx::query("START TRANSACTION")
                    .execute(&mut *connection)
                    .await?;
                Ok(Self::Mysql(connection))
            }
            DbPool::Sqlite(pool) => {
                let mut connection = pool.acquire().await?;
                sqlx::query("BEGIN").execute(&mut *connection).await?;
                Ok(Self::Sqlite(connection))
            }
        }
    }

    async fn finish(mut self, commit: bool) -> AppResult<()> {
        let statement = if commit { "COMMIT" } else { "ROLLBACK" };
        let result = match &mut self {
            Self::Postgres(connection) => sqlx::query(statement)
                .execute(&mut **connection)
                .await
                .map(|_| ()),
            Self::Mysql(connection) => sqlx::query(statement)
                .execute(&mut **connection)
                .await
                .map(|_| ()),
            Self::Sqlite(connection) => sqlx::query(statement)
                .execute(&mut **connection)
                .await
                .map(|_| ()),
        };
        if let Err(error) = result {
            self.close().await;
            return Err(if commit {
                AppError::OutcomeUnknown(format!(
                    "manual transaction commit acknowledgement failed: {error}"
                ))
            } else {
                AppError::OutcomeUnknown(format!(
                    "manual transaction rollback acknowledgement failed: {error}"
                ))
            });
        }
        Ok(())
    }

    async fn close(self) {
        match self {
            Self::Postgres(connection) => {
                let _ = connection.close().await;
            }
            Self::Mysql(connection) => {
                let _ = connection.close().await;
            }
            Self::Sqlite(connection) => {
                let _ = connection.close().await;
            }
        }
    }
}

struct ManualSessionState {
    phase: ManualTransactionPhase,
    statement_count: u64,
    connection: Option<ManualConnection>,
}

struct ManualSession {
    transaction_id: Uuid,
    connection_id: Uuid,
    database: String,
    engine: Engine,
    started_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    state: Mutex<ManualSessionState>,
    _lease: ConnectionLease,
}

impl ManualSession {
    async fn status(&self) -> ManualTransactionStatus {
        let state = self.state.lock().await;
        ManualTransactionStatus {
            transaction_id: self.transaction_id,
            connection_id: self.connection_id,
            database: self.database.clone(),
            phase: state.phase,
            statement_count: state.statement_count,
            started_at: self.started_at,
            expires_at: self.expires_at,
        }
    }

    async fn finish(&self, commit: bool) -> AppResult<ManualTransactionStatus> {
        let mut state = self.state.lock().await;
        let status = ManualTransactionStatus {
            transaction_id: self.transaction_id,
            connection_id: self.connection_id,
            database: self.database.clone(),
            phase: state.phase,
            statement_count: state.statement_count,
            started_at: self.started_at,
            expires_at: self.expires_at,
        };
        if commit && state.phase == ManualTransactionPhase::Failed {
            return Err(AppError::Blocked {
                reason: "the manual transaction is failed and can only be rolled back".into(),
            });
        }
        let connection = state.connection.take().ok_or_else(|| AppError::Blocked {
            reason: "the manual transaction is already closed".into(),
        })?;
        drop(state);
        connection.finish(commit).await?;
        Ok(status)
    }

    async fn force_rollback(&self, reason: &'static str) {
        let connection = self.state.lock().await.connection.take();
        let Some(connection) = connection else {
            return;
        };
        if let Err(error) = connection.finish(false).await {
            tracing::warn!(
                connection_id = %self.connection_id,
                transaction_id = %self.transaction_id,
                %reason,
                %error,
                "manual transaction forced rollback was not acknowledged"
            );
        }
    }

    async fn run_read(
        &self,
        sql: &str,
        namespace: Option<String>,
        max_rows: u64,
        cancellation: Option<&executor::cancel::CancelHandle>,
    ) -> AppResult<QueryResult> {
        let started = Instant::now();
        let mut state = self.state.lock().await;
        ensure_session_usable(&state, self.expires_at)?;
        let connection = state
            .connection
            .as_mut()
            .expect("usable manual transaction owns a connection");
        let execution = manual_read(connection, sql, namespace, max_rows);
        match executor::cancel::guard_registered(
            cancellation,
            executor::cancel::QUERY_TIMEOUT,
            execution,
        )
        .await
        {
            Ok(mut result) => {
                state.statement_count += 1;
                result.duration_ms = started.elapsed().as_millis() as u64;
                Ok(result)
            }
            Err(error) => {
                state.phase = ManualTransactionPhase::Failed;
                Err(error)
            }
        }
    }

    async fn run_read_streamed<F, Fut>(
        &self,
        sql: &str,
        namespace: Option<String>,
        max_rows: u64,
        batch_rows: usize,
        cancellation: Option<&executor::cancel::CancelHandle>,
        on_batch: &mut F,
    ) -> AppResult<executor::read::StreamedRead>
    where
        F: FnMut(executor::read::ReadBatch) -> Fut + Send,
        Fut: Future<Output = AppResult<()>> + Send,
    {
        let mut state = self.state.lock().await;
        ensure_session_usable(&state, self.expires_at)?;
        let connection = state
            .connection
            .as_mut()
            .expect("usable manual transaction owns a connection");
        let execution =
            manual_read_streamed(connection, sql, namespace, max_rows, batch_rows, on_batch);
        match executor::cancel::guard_registered(
            cancellation,
            executor::cancel::QUERY_TIMEOUT,
            execution,
        )
        .await
        {
            Ok(result) => {
                state.statement_count += 1;
                Ok(result)
            }
            Err(error) => {
                state.phase = ManualTransactionPhase::Failed;
                Err(error)
            }
        }
    }

    async fn run_write(
        &self,
        classification: &Classification,
        sql: &str,
        namespace: Option<String>,
        settings: &SafetySettings,
        grant: &ExecutionGrant,
        cancellation: &executor::cancel::CancelHandle,
    ) -> AppResult<ExecOutcome> {
        if cancellation.id() != grant.operation_id() {
            return Err(AppError::Blocked {
                reason:
                    "manual transaction cancellation scope does not match its approved operation"
                        .into(),
            });
        }
        if !settings.allow_writes {
            return Err(AppError::Blocked {
                reason: "writes are disabled for this connection (allow_writes = 0)".into(),
            });
        }
        if matches!(classification.kind, QueryKind::Ddl | QueryKind::Privilege) {
            return Err(AppError::Blocked {
                reason: "DDL and privilege statements are excluded from a manual rollback boundary"
                    .into(),
            });
        }
        let mut state = self.state.lock().await;
        ensure_session_usable(&state, self.expires_at)?;
        let connection = state
            .connection
            .as_mut()
            .expect("usable manual transaction owns a connection");
        let execution = manual_execute(connection, sql, namespace);
        match executor::cancel::guard_registered(
            Some(cancellation),
            executor::cancel::QUERY_TIMEOUT,
            execution,
        )
        .await
        {
            Ok(affected) => {
                state.statement_count += 1;
                Ok(ExecOutcome {
                    result: None,
                    affected: Some(affected),
                    committed: false,
                    manual_transaction: true,
                })
            }
            Err(error) => {
                state.phase = ManualTransactionPhase::Failed;
                Err(error)
            }
        }
    }

    async fn run_script(
        &self,
        statements: &[String],
        kinds: &[QueryKind],
        namespace: Option<String>,
        expected_affected: Option<&[u64]>,
        max_rows: u64,
        cancellation: &executor::cancel::CancelHandle,
    ) -> AppResult<ManualScriptExecution> {
        let mut state = self.state.lock().await;
        ensure_session_usable(&state, self.expires_at)?;
        let connection = state
            .connection
            .as_mut()
            .expect("usable manual transaction owns a connection");
        let execution = manual_script(
            connection,
            statements,
            kinds,
            namespace,
            expected_affected,
            max_rows,
        );
        match executor::cancel::guard_registered(
            Some(cancellation),
            executor::cancel::QUERY_TIMEOUT,
            execution,
        )
        .await
        {
            Ok(execution) => {
                state.statement_count += execution.statements.len() as u64;
                Ok(execution)
            }
            Err(error) => {
                state.phase = ManualTransactionPhase::Failed;
                Err(error)
            }
        }
    }
}

fn ensure_session_usable(state: &ManualSessionState, expires_at: DateTime<Utc>) -> AppResult<()> {
    if state.connection.is_none() {
        return Err(AppError::Blocked {
            reason: "the manual transaction is closed".into(),
        });
    }
    if state.phase == ManualTransactionPhase::Failed {
        return Err(AppError::Blocked {
            reason: "the manual transaction is failed and can only be rolled back".into(),
        });
    }
    if expires_at <= Utc::now() {
        return Err(AppError::Blocked {
            reason: "the manual transaction expired and must be rolled back".into(),
        });
    }
    Ok(())
}

#[derive(Clone)]
pub(crate) struct ManualTransactionRuntime {
    store: Store,
    connections: ConnectionManager,
    sessions: Arc<Mutex<HashMap<Uuid, Arc<ManualSession>>>>,
    events: broadcast::Sender<ManualTransactionChanged>,
}

impl ManualTransactionRuntime {
    pub(crate) fn new(store: Store, connections: ConnectionManager) -> Self {
        let (events, _) = broadcast::channel(64);
        Self {
            store,
            connections,
            sessions: Arc::new(Mutex::new(HashMap::new())),
            events,
        }
    }

    pub(crate) fn subscribe(&self) -> broadcast::Receiver<ManualTransactionChanged> {
        self.events.subscribe()
    }

    pub(crate) async fn snapshot(&self) -> Vec<ManualTransactionStatus> {
        let connection_ids = self
            .sessions
            .lock()
            .await
            .keys()
            .copied()
            .collect::<Vec<_>>();
        let mut statuses = Vec::with_capacity(connection_ids.len());
        for connection_id in connection_ids {
            if let Some(status) = self.status(connection_id).await {
                statuses.push(status);
            }
        }
        statuses.sort_by_key(|status| status.connection_id);
        statuses
    }

    pub(crate) async fn begin(
        &self,
        connection_id: Uuid,
        database: Option<String>,
    ) -> AppResult<ManualTransactionStatus> {
        let admission = self.connections.begin_session_admission().await;
        let mut sessions = self.sessions.lock().await;
        if let Some(session) = sessions.get(&connection_id) {
            if database
                .as_deref()
                .is_some_and(|database| database != session.database)
            {
                return Err(AppError::Blocked {
                    reason: "this connection already has a manual transaction in another database"
                        .into(),
                });
            }
            let status = session.status().await;
            self.publish(connection_id, Some(status.clone()));
            return Ok(status);
        }
        let pin = admission.pin_connection(connection_id).await?;
        if pin.profile.engine == Engine::Mongodb {
            return Err(AppError::Blocked {
                reason: "manual SQL transactions are unavailable for document connections".into(),
            });
        }
        if !pin.profile.workspace_access.can_write() {
            return Err(AppError::Blocked {
                reason: "your workspace role grants read-only database access".into(),
            });
        }
        let settings = self.store.get_safety(pin.connection_id).await?;
        if !settings.allow_writes {
            return Err(AppError::Blocked {
                reason: "enable writes for this connection before starting a manual transaction"
                    .into(),
            });
        }
        let engine = pin.profile.engine;
        let start = admission
            .connect_to_database(pin, ConnectionAccess::Write, database)
            .await?;
        let database = start.target_database().to_owned();
        let connection = ManualConnection::begin(&start.live().sql()?.write_pool).await?;
        let started_at = Utc::now();
        let session = Arc::new(ManualSession {
            transaction_id: Uuid::new_v4(),
            connection_id,
            database,
            engine,
            started_at,
            expires_at: started_at + MANUAL_TRANSACTION_TTL,
            state: Mutex::new(ManualSessionState {
                phase: ManualTransactionPhase::Active,
                statement_count: 0,
                connection: Some(connection),
            }),
            _lease: start.into_lease(),
        });
        let status = session.status().await;
        sessions.insert(connection_id, Arc::clone(&session));
        drop(sessions);
        self.schedule_expiry(session);
        self.publish(connection_id, Some(status.clone()));
        Ok(status)
    }

    pub(crate) async fn status(&self, connection_id: Uuid) -> Option<ManualTransactionStatus> {
        let session = self.sessions.lock().await.get(&connection_id).cloned();
        match session {
            Some(session) if session.expires_at <= Utc::now() => {
                self.remove_and_rollback(connection_id, Some(session), "transaction expired")
                    .await;
                None
            }
            Some(session) => Some(session.status().await),
            None => None,
        }
    }

    pub(crate) async fn commit(
        &self,
        connection_id: Uuid,
        transaction_id: Uuid,
    ) -> AppResult<ManualTransactionStatus> {
        let session = self.take_exact(connection_id, transaction_id).await?;
        let result = match session.finish(true).await {
            Ok(status) => {
                self.record_boundary(&session, "manual_transaction:commit", "COMMIT", None)
                    .await
                    .map_err(|error| {
                        AppError::OutcomeUnknown(format!(
                            "manual transaction committed but its audit receipt failed: {error}"
                        ))
                    })?;
                Ok(status)
            }
            Err(error) => {
                // A failed transaction cannot be returned to the pool merely
                // because commit raced its rollback-only transition.
                session.force_rollback("commit rejected").await;
                Err(error)
            }
        };
        self.publish(connection_id, None);
        result
    }

    pub(crate) async fn rollback(
        &self,
        connection_id: Uuid,
        transaction_id: Uuid,
    ) -> AppResult<ManualTransactionStatus> {
        let session = self.take_exact(connection_id, transaction_id).await?;
        let result = match session.finish(false).await {
            Ok(status) => {
                if let Err(error) = self
                    .record_boundary(&session, "manual_transaction:rollback", "ROLLBACK", None)
                    .await
                {
                    tracing::warn!(
                        %connection_id,
                        %transaction_id,
                        %error,
                        "manual transaction rollback audit receipt failed"
                    );
                }
                Ok(status)
            }
            Err(error) => Err(error),
        };
        self.publish(connection_id, None);
        result
    }

    pub(crate) async fn run_read(
        &self,
        target: ManualExecutionTarget<'_>,
        sql: &str,
        max_rows: u64,
        cancellation: Option<&executor::cancel::CancelHandle>,
    ) -> Option<AppResult<QueryResult>> {
        let session = self
            .sessions
            .lock()
            .await
            .get(&target.connection_id)
            .cloned()?;
        if session.database != target.database {
            return Some(Err(database_mismatch()));
        }
        let result = session
            .run_read(sql, target.namespace, max_rows, cancellation)
            .await;
        self.publish_current_if_mapped(target.connection_id, &session)
            .await;
        Some(result)
    }

    pub(crate) async fn run_write(
        &self,
        target: ManualExecutionTarget<'_>,
        classification: &Classification,
        sql: &str,
        settings: &SafetySettings,
        grant: &ExecutionGrant,
        cancellation: &executor::cancel::CancelHandle,
    ) -> Option<AppResult<ExecOutcome>> {
        let session = self
            .sessions
            .lock()
            .await
            .get(&target.connection_id)
            .cloned()?;
        if session.database != target.database {
            return Some(Err(database_mismatch()));
        }
        let result = session
            .run_write(
                classification,
                sql,
                target.namespace,
                settings,
                grant,
                cancellation,
            )
            .await;
        self.publish_current_if_mapped(target.connection_id, &session)
            .await;
        Some(result)
    }

    pub(crate) async fn run_read_streamed<F, Fut>(
        &self,
        target: ManualExecutionTarget<'_>,
        sql: &str,
        max_rows: u64,
        batch_rows: usize,
        cancellation: Option<&executor::cancel::CancelHandle>,
        on_batch: &mut F,
    ) -> Option<AppResult<executor::read::StreamedRead>>
    where
        F: FnMut(executor::read::ReadBatch) -> Fut + Send,
        Fut: Future<Output = AppResult<()>> + Send,
    {
        let session = self
            .sessions
            .lock()
            .await
            .get(&target.connection_id)
            .cloned()?;
        if session.database != target.database {
            return Some(Err(database_mismatch()));
        }
        let result = session
            .run_read_streamed(
                sql,
                target.namespace,
                max_rows,
                batch_rows,
                cancellation,
                on_batch,
            )
            .await;
        self.publish_current_if_mapped(target.connection_id, &session)
            .await;
        Some(result)
    }

    pub(crate) async fn run_script(
        &self,
        request: ManualScriptRequest<'_>,
    ) -> Option<AppResult<ManualScriptExecution>> {
        let session = self
            .sessions
            .lock()
            .await
            .get(&request.target.connection_id)
            .cloned()?;
        if session.database != request.target.database {
            return Some(Err(database_mismatch()));
        }
        if request.cancellation.id() != request.grant.operation_id() {
            return Some(Err(AppError::Blocked {
                reason: "manual script transaction scope does not match its approved operation"
                    .into(),
            }));
        }
        let _exact_payload = (
            request.grant.payload_sha256(),
            request.grant.connection_id(),
        );
        if request.contains_unsupported_kind {
            return Some(Err(AppError::Blocked {
                reason: "DDL and privilege statements are excluded from a manual rollback boundary"
                    .into(),
            }));
        }
        let result = session
            .run_script(
                request.statements,
                request.kinds,
                request.target.namespace,
                request.expected_affected,
                request.max_rows,
                request.cancellation,
            )
            .await;
        self.publish_current_if_mapped(request.target.connection_id, &session)
            .await;
        Some(result)
    }

    pub(crate) async fn shutdown(&self) {
        self.revoke(None, "application shutdown").await;
    }

    async fn record_boundary(
        &self,
        session: &ManualSession,
        action: &'static str,
        sql: &'static str,
        error: Option<String>,
    ) -> AppResult<()> {
        crate::audit::record(
            &self.store,
            crate::audit::RecordArgs {
                connection_id: session.connection_id,
                engine: session.engine,
                agent_prompt: None,
                sql: sql.into(),
                kind: QueryKind::Write,
                action: action.into(),
                approved_by: None,
                affected_estimate: None,
                error,
            },
        )
        .await?;
        Ok(())
    }

    async fn take_exact(
        &self,
        connection_id: Uuid,
        transaction_id: Uuid,
    ) -> AppResult<Arc<ManualSession>> {
        let mut sessions = self.sessions.lock().await;
        let Some(session) = sessions.get(&connection_id) else {
            return Err(AppError::NotFound("manual transaction".into()));
        };
        if session.transaction_id != transaction_id {
            return Err(AppError::Blocked {
                reason: "manual transaction identity is stale".into(),
            });
        }
        Ok(sessions
            .remove(&connection_id)
            .expect("checked manual transaction is still mapped"))
    }

    fn publish(&self, connection_id: Uuid, status: Option<ManualTransactionStatus>) {
        let _ = self.events.send(ManualTransactionChanged {
            connection_id,
            status,
        });
    }

    async fn publish_current_if_mapped(&self, connection_id: Uuid, expected: &Arc<ManualSession>) {
        let status = {
            let sessions = self.sessions.lock().await;
            match sessions.get(&connection_id) {
                Some(current) if Arc::ptr_eq(current, expected) => Some(expected.status().await),
                _ => None,
            }
        };
        if let Some(status) = status {
            self.publish(connection_id, Some(status));
        }
    }

    fn schedule_expiry(&self, session: Arc<ManualSession>) {
        let runtime = self.clone();
        let expires_at = session.expires_at;
        let connection_id = session.connection_id;
        let session = Arc::downgrade(&session);
        tokio::spawn(async move {
            let delay = (expires_at - Utc::now()).to_std().unwrap_or_default();
            tokio::time::sleep(delay).await;
            if let Some(session) = session.upgrade() {
                runtime
                    .remove_and_rollback(connection_id, Some(session), "transaction expired")
                    .await;
            }
        });
    }

    async fn remove_and_rollback(
        &self,
        connection_id: Uuid,
        expected: Option<Arc<ManualSession>>,
        reason: &'static str,
    ) {
        let session = {
            let mut sessions = self.sessions.lock().await;
            let matches = match (sessions.get(&connection_id), expected.as_ref()) {
                (Some(current), Some(expected)) => Arc::ptr_eq(current, expected),
                (Some(_), None) => true,
                _ => false,
            };
            matches.then(|| sessions.remove(&connection_id)).flatten()
        };
        if let Some(session) = session {
            self.publish(connection_id, None);
            session.force_rollback(reason).await;
            if let Err(error) = self
                .record_boundary(
                    &session,
                    "manual_transaction:forced_rollback",
                    "ROLLBACK",
                    Some(reason.into()),
                )
                .await
            {
                tracing::warn!(
                    connection_id = %session.connection_id,
                    transaction_id = %session.transaction_id,
                    %error,
                    "manual transaction forced rollback audit receipt failed"
                );
            }
        }
    }
}

impl ConnectionSessionRevocationPort for ManualTransactionRuntime {
    fn revoke<'a>(
        &'a self,
        connection_id: Option<Uuid>,
        reason: &'static str,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
        Box::pin(async move {
            let sessions = {
                let mut sessions = self.sessions.lock().await;
                match connection_id {
                    Some(connection_id) => sessions
                        .remove(&connection_id)
                        .into_iter()
                        .collect::<Vec<_>>(),
                    None => sessions.drain().map(|(_, session)| session).collect(),
                }
            };
            for session in sessions {
                self.publish(session.connection_id, None);
                session.force_rollback(reason).await;
                if let Err(error) = self
                    .record_boundary(
                        &session,
                        "manual_transaction:forced_rollback",
                        "ROLLBACK",
                        Some(reason.into()),
                    )
                    .await
                {
                    tracing::warn!(
                        connection_id = %session.connection_id,
                        transaction_id = %session.transaction_id,
                        %error,
                        "manual transaction forced rollback audit receipt failed"
                    );
                }
            }
        })
    }
}

async fn set_namespace(
    connection: &mut ManualConnection,
    namespace: Option<&str>,
) -> AppResult<()> {
    let Some(namespace) = namespace else {
        return Ok(());
    };
    if let ManualConnection::Postgres(connection) = connection {
        let statement = executor::namespace::postgres_search_path_statement(namespace);
        sqlx::query(AssertSqlSafe(statement))
            .execute(&mut **connection)
            .await?;
    }
    Ok(())
}

async fn manual_execute(
    connection: &mut ManualConnection,
    sql: &str,
    namespace: Option<String>,
) -> AppResult<u64> {
    set_namespace(connection, namespace.as_deref()).await?;
    let affected = match connection {
        ManualConnection::Postgres(connection) => sqlx::query(AssertSqlSafe(sql))
            .execute(&mut **connection)
            .await?
            .rows_affected(),
        ManualConnection::Mysql(connection) => sqlx::query(AssertSqlSafe(sql))
            .execute(&mut **connection)
            .await?
            .rows_affected(),
        ManualConnection::Sqlite(connection) => sqlx::query(AssertSqlSafe(sql))
            .execute(&mut **connection)
            .await?
            .rows_affected(),
    };
    Ok(affected)
}

async fn manual_read(
    connection: &mut ManualConnection,
    sql: &str,
    namespace: Option<String>,
    max_rows: u64,
) -> AppResult<QueryResult> {
    set_namespace(connection, namespace.as_deref()).await?;
    let max_rows = max_rows as usize;
    let (columns, rows, truncated) = match connection {
        ManualConnection::Postgres(connection) => {
            let (columns, rows, truncated) = executor::read::stream_capped(
                sqlx::query(AssertSqlSafe(sql)).fetch(&mut **connection),
                max_rows,
                executor::read::pg_value,
            )
            .await?;
            let columns = if columns.is_empty() {
                (&mut **connection)
                    .describe(AssertSqlSafe(sql).into_sql_str())
                    .await
                    .ok()
                    .map(executor::read::describe_cols)
                    .unwrap_or_default()
            } else {
                columns
            };
            (columns, rows, truncated)
        }
        ManualConnection::Mysql(connection) => {
            let (columns, rows, truncated) = executor::read::stream_capped(
                sqlx::query(AssertSqlSafe(sql)).fetch(&mut **connection),
                max_rows,
                executor::read::mysql_value,
            )
            .await?;
            let columns = if columns.is_empty() {
                (&mut **connection)
                    .describe(AssertSqlSafe(sql).into_sql_str())
                    .await
                    .ok()
                    .map(executor::read::describe_cols)
                    .unwrap_or_default()
            } else {
                columns
            };
            (columns, rows, truncated)
        }
        ManualConnection::Sqlite(connection) => {
            let (columns, rows, truncated) = executor::read::stream_capped(
                sqlx::query(AssertSqlSafe(sql)).fetch(&mut **connection),
                max_rows,
                executor::read::sqlite_value,
            )
            .await?;
            let columns = if columns.is_empty() {
                (&mut **connection)
                    .describe(AssertSqlSafe(sql).into_sql_str())
                    .await
                    .ok()
                    .map(executor::read::describe_cols)
                    .unwrap_or_default()
            } else {
                columns
            };
            (columns, rows, truncated)
        }
    };
    Ok(QueryResult {
        row_count: rows.len(),
        columns,
        rows,
        truncated,
        duration_ms: 0,
    })
}

async fn manual_read_streamed<F, Fut>(
    connection: &mut ManualConnection,
    sql: &str,
    namespace: Option<String>,
    max_rows: u64,
    batch_rows: usize,
    on_batch: &mut F,
) -> AppResult<executor::read::StreamedRead>
where
    F: FnMut(executor::read::ReadBatch) -> Fut + Send,
    Fut: Future<Output = AppResult<()>> + Send,
{
    let started = Instant::now();
    set_namespace(connection, namespace.as_deref()).await?;
    let (columns, row_count, truncated, first_row_ms) = match connection {
        ManualConnection::Postgres(connection) => {
            let (columns, row_count, truncated, first_row_ms) = executor::read::stream_batched(
                sqlx::query(AssertSqlSafe(sql)).fetch(&mut **connection),
                max_rows as usize,
                batch_rows,
                executor::read::pg_value,
                started,
                on_batch,
            )
            .await?;
            let columns = if columns.is_empty() {
                (&mut **connection)
                    .describe(AssertSqlSafe(sql).into_sql_str())
                    .await
                    .ok()
                    .map(executor::read::describe_cols)
                    .unwrap_or_default()
            } else {
                columns
            };
            (columns, row_count, truncated, first_row_ms)
        }
        ManualConnection::Mysql(connection) => {
            let (columns, row_count, truncated, first_row_ms) = executor::read::stream_batched(
                sqlx::query(AssertSqlSafe(sql)).fetch(&mut **connection),
                max_rows as usize,
                batch_rows,
                executor::read::mysql_value,
                started,
                on_batch,
            )
            .await?;
            let columns = if columns.is_empty() {
                (&mut **connection)
                    .describe(AssertSqlSafe(sql).into_sql_str())
                    .await
                    .ok()
                    .map(executor::read::describe_cols)
                    .unwrap_or_default()
            } else {
                columns
            };
            (columns, row_count, truncated, first_row_ms)
        }
        ManualConnection::Sqlite(connection) => {
            let (columns, row_count, truncated, first_row_ms) = executor::read::stream_batched(
                sqlx::query(AssertSqlSafe(sql)).fetch(&mut **connection),
                max_rows as usize,
                batch_rows,
                executor::read::sqlite_value,
                started,
                on_batch,
            )
            .await?;
            let columns = if columns.is_empty() {
                (&mut **connection)
                    .describe(AssertSqlSafe(sql).into_sql_str())
                    .await
                    .ok()
                    .map(executor::read::describe_cols)
                    .unwrap_or_default()
            } else {
                columns
            };
            (columns, row_count, truncated, first_row_ms)
        }
    };
    if row_count == 0 {
        on_batch(executor::read::ReadBatch {
            columns: columns.clone(),
            rows: Vec::new(),
        })
        .await?;
    }
    Ok(executor::read::StreamedRead {
        columns,
        row_count,
        truncated,
        duration_ms: started.elapsed().as_millis() as u64,
        first_row_ms,
    })
}

async fn manual_script(
    connection: &mut ManualConnection,
    statements: &[String],
    kinds: &[QueryKind],
    namespace: Option<String>,
    expected_affected: Option<&[u64]>,
    max_rows: u64,
) -> AppResult<ManualScriptExecution> {
    set_namespace(connection, namespace.as_deref()).await?;
    let mut outcomes = Vec::with_capacity(statements.len());
    for (index, statement) in statements.iter().enumerate() {
        if kinds.get(index) == Some(&QueryKind::Read) {
            let result = manual_read(connection, statement, None, max_rows).await?;
            outcomes.push(ScriptStatement {
                sql: statement.clone(),
                result: Some(result),
                affected: None,
                error: None,
            });
            continue;
        }
        let affected = manual_execute(connection, statement, None).await?;
        if let Some(expected) = expected_affected.and_then(|values| values.get(index)) {
            if affected != *expected {
                return Err(AppError::Blocked {
                    reason: format!(
                        "optimistic concurrency conflict: expected {expected} affected row, got {affected}"
                    ),
                });
            }
        }
        outcomes.push(ScriptStatement {
            sql: statement.clone(),
            result: None,
            affected: Some(affected as i64),
            error: None,
        });
    }
    Ok(ManualScriptExecution {
        statements: outcomes,
    })
}
