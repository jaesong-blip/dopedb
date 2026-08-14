//! Tauri event and OS-keychain adapters for the Knowledge watcher runtime.

use std::path::PathBuf;

use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::connection::keychain::fetch_knowledge_source_root;
use crate::error::AppResult;

use super::runtime::{KnowledgeSourceChanged, KnowledgeSourceEventSink};
use super::source_sync::KnowledgeSourceRootPort;

#[derive(Clone)]
pub(crate) struct TauriKnowledgeSourceEventSink {
    app: AppHandle,
}

impl TauriKnowledgeSourceEventSink {
    pub(crate) fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl KnowledgeSourceEventSink for TauriKnowledgeSourceEventSink {
    fn source_changed(&self, changed: KnowledgeSourceChanged) {
        let _ = self.app.emit("knowledge-source:changed", changed);
    }
}

#[derive(Clone, Copy, Default)]
pub(crate) struct KeychainKnowledgeSourceRoot;

impl KnowledgeSourceRootPort for KeychainKnowledgeSourceRoot {
    fn fetch_root(&self, source_id: Uuid) -> AppResult<Option<PathBuf>> {
        fetch_knowledge_source_root(source_id)
    }
}
