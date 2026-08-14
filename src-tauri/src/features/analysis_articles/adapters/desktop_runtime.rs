//! Tauri event and desktop-notification adapter for Analysis background work.

use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;

use super::super::runtime_ports::{AnalysisRunnerChanged, AnalysisRuntimeDesktopPort};

#[derive(Clone)]
pub(crate) struct TauriAnalysisRuntimeAdapter {
    app: AppHandle,
}

impl TauriAnalysisRuntimeAdapter {
    pub(crate) fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl AnalysisRuntimeDesktopPort for TauriAnalysisRuntimeAdapter {
    fn runner_changed(&self, changed: AnalysisRunnerChanged) {
        let _ = self.app.emit("analysis-runner:changed", changed);
    }

    fn notify_signal(&self, title: String, body: String) {
        let _ = self
            .app
            .notification()
            .builder()
            .title(title)
            .body(body)
            .show();
    }
}
