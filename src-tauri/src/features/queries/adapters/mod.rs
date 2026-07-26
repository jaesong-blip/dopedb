//! Concrete Terminal query adapters.

mod errors;
mod provenance;
mod terminal_plan;
mod terminal_run;
mod terminal_support;

pub(crate) use errors::{AgentQueryPlanError, AgentQueryRunError, AgentQueryRunPrepareError};
pub(crate) use provenance::TerminalQueryRunRegistry;
#[cfg(test)]
pub(crate) use terminal_plan::SeedQueryPlanForTest;
pub(crate) use terminal_plan::{AgentQueryPlanReceipt, TerminalQueryAdapter};
pub(crate) use terminal_run::PreparedAgentQueryRun;
