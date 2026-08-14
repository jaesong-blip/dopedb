//! Desktop adapter bundle supplied by the Tauri transport for one ACP launch.

use std::sync::Arc;

use tauri::AppHandle;

use super::event_sink::{SharedAcpSessionEventSink, TauriAcpSessionEventSink};
use super::process::{AcpProcessLaunchPort, TauriAcpProcessLaunchPort};
use crate::features::agents::runtime::AcpPluginManager;

#[derive(Clone)]
pub(crate) struct DesktopAcpRuntimePorts {
    pub(super) process: Arc<dyn AcpProcessLaunchPort>,
    pub(super) events: SharedAcpSessionEventSink,
}

impl DesktopAcpRuntimePorts {
    pub(crate) fn new(app: AppHandle, plugins: AcpPluginManager) -> Self {
        Self {
            process: Arc::new(TauriAcpProcessLaunchPort::new(app.clone(), plugins)),
            events: Arc::new(TauriAcpSessionEventSink::new(app)),
        }
    }
}
