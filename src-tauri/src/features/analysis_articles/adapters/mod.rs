//! Concrete Desktop and hosted adapters for Analysis Articles.

mod desktop_read;
mod desktop_runtime;
pub(in crate::features::analysis_articles) mod hosted;
mod sqlite;

#[cfg(test)]
pub(crate) use desktop_read::assert_parameter_binding_contract;
pub(crate) use desktop_read::DesktopAnalysisReadExecution;
pub(crate) use desktop_runtime::TauriAnalysisRuntimeAdapter;
#[cfg(test)]
pub(crate) use hosted::assert_hosted_mutation_error_contract;
pub(crate) use hosted::HostedAnalysisAuthority;
pub(crate) use sqlite::SqliteAnalysisLocalRepository;
