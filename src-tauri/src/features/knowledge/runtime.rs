//! Process-local source watcher lifecycle.
//!
//! Only Local Folder sources are watched here. GitHub changes arrive through
//! the GitHub App webhook and are incrementally indexed by the control plane.

use std::sync::Arc;
use std::time::Duration;

use dashmap::mapref::entry::Entry;
use dashmap::DashMap;
use dopedb_protocol::KnowledgeSourceProvider;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

use crate::connection::keychain::fetch_knowledge_source_root;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

use super::ports::{KnowledgeScopeRepositoryPort, LocalKnowledgeSourcePort};
use super::transport::sync_knowledge_source_inner;

const SOURCE_CHANGED_EVENT: &str = "knowledge-source:changed";
const WATCH_DEBOUNCE: Duration = Duration::from_millis(750);

#[derive(Clone, Default)]
pub(crate) struct KnowledgeWatchRuntime {
    tasks: Arc<DashMap<Uuid, tokio::task::JoinHandle<()>>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeSourceChanged {
    source_id: Uuid,
    state: &'static str,
    error_kind: Option<String>,
}

impl KnowledgeWatchRuntime {
    pub(crate) fn start(&self, app: AppHandle, source_id: Uuid) {
        let Entry::Vacant(entry) = self.tasks.entry(source_id) else {
            return;
        };
        let runtime = self.clone();
        let (start_tx, start_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let _ = start_rx.await;
            if let Err(error) = watch_source(app.clone(), source_id).await {
                emit_state(&app, source_id, "failed", Some(error.kind()));
            }
            runtime.tasks.remove(&source_id);
        });
        entry.insert(task);
        let _ = start_tx.send(());
    }

    pub(crate) fn stop(&self, source_id: Uuid) {
        if let Some((_, task)) = self.tasks.remove(&source_id) {
            task.abort();
        }
    }

    pub(crate) async fn start_workspace(&self, app: AppHandle) -> AppResult<()> {
        let state = app.state::<AppState>();
        let scope = state.knowledge_store().active_resource_scope().await?;
        let source_ids = state
            .knowledge_store()
            .scopes(scope.workspace_id)
            .await?
            .into_iter()
            .filter(|source| source.binding.provider == KnowledgeSourceProvider::LocalFolder)
            .map(|source| source.binding.source_id)
            .collect::<Vec<_>>();
        drop(state);
        for source_id in source_ids {
            self.start(app.clone(), source_id);
        }
        Ok(())
    }
}

async fn watch_source(app: AppHandle, source_id: Uuid) -> AppResult<()> {
    let state = app.state::<AppState>();
    let active_scope = state.knowledge_store().active_resource_scope().await?;
    let stored = state
        .knowledge_store()
        .scopes(active_scope.workspace_id)
        .await?
        .into_iter()
        .find(|source| source.binding.source_id == source_id)
        .ok_or_else(|| AppError::NotFound("the Project Knowledge source".into()))?;
    match stored.binding.provider {
        KnowledgeSourceProvider::Github => return Ok(()),
        KnowledgeSourceProvider::LocalFolder => {
            let root = fetch_knowledge_source_root(source_id)?.ok_or_else(|| {
                AppError::NotFound("the Local Folder capability on this device".into())
            })?;
            state.local_knowledge_sources.restore(
                stored.binding.clone(),
                stored.environment.revision,
                root,
            )?;
            let mut watch = state.local_knowledge_sources.watch(&stored.binding).await?;
            drop(state);
            drive_changes(&app, source_id, &mut watch.changes).await;
        }
    }
    Ok(())
}

async fn drive_changes(
    app: &AppHandle,
    source_id: Uuid,
    changes: &mut tokio::sync::mpsc::Receiver<Vec<String>>,
) {
    while changes.recv().await.is_some() {
        tokio::time::sleep(WATCH_DEBOUNCE).await;
        while changes.try_recv().is_ok() {}
        emit_state(app, source_id, "syncing", None);
        let state = app.state::<AppState>();
        match sync_knowledge_source_inner(&state, source_id).await {
            Ok(_) => emit_state(app, source_id, "ready", None),
            Err(error) => emit_state(app, source_id, "failed", Some(error.kind())),
        }
    }
}

fn emit_state(app: &AppHandle, source_id: Uuid, state: &'static str, error_kind: Option<&str>) {
    let _ = app.emit(
        SOURCE_CHANGED_EVENT,
        KnowledgeSourceChanged {
            source_id,
            state,
            error_kind: error_kind.map(str::to_owned),
        },
    );
}
