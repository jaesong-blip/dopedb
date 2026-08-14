//! ACP session change delivery port and its Tauri desktop adapter.

use std::sync::Arc;

use tauri::{AppHandle, Emitter};

use super::super::domain::AcpSessionChanged;

const EVENT_NAME: &str = "agent-acp:changed";

pub(super) trait AcpSessionEventSink: Send + Sync {
    fn emit_changed(&self, changed: AcpSessionChanged);
}

pub(super) type SharedAcpSessionEventSink = Arc<dyn AcpSessionEventSink>;

pub(super) struct TauriAcpSessionEventSink {
    app: AppHandle,
}

impl TauriAcpSessionEventSink {
    pub(super) fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl AcpSessionEventSink for TauriAcpSessionEventSink {
    fn emit_changed(&self, changed: AcpSessionChanged) {
        let _ = self.app.emit(EVENT_NAME, changed);
    }
}
