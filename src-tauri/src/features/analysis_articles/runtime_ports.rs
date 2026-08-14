//! Desktop-only delivery ports used by Analysis background and signal runtimes.

use serde::Serialize;
use uuid::Uuid;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnalysisRunnerChanged {
    pub(crate) state: &'static str,
    pub(crate) article_id: Option<Uuid>,
    pub(crate) run_id: Option<Uuid>,
    pub(crate) error_kind: Option<String>,
}

pub(crate) trait AnalysisRuntimeDesktopPort: Send + Sync {
    fn runner_changed(&self, changed: AnalysisRunnerChanged);
    fn notify_signal(&self, title: String, body: String);
}
