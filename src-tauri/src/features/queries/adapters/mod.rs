//! Concrete platform adapters for desktop and authenticated Terminal SQL Query workflows.

mod desktop_contracts;
mod desktop_execution;
#[cfg(test)]
mod desktop_execution_tests;
mod desktop_inspection;
#[cfg(test)]
mod desktop_inspection_tests;
mod desktop_planning;
mod desktop_port;
mod desktop_support;
mod errors;
mod platform;
mod provenance;
mod terminal_plan;
mod terminal_run;
mod terminal_support;

pub(crate) use desktop_contracts::{
    DesktopSqlInspectionError, DesktopSqlInspectionReceipt, DesktopSqlProposalReceipt,
    DesktopSqlRunError, DesktopSqlRunReceipt,
};
pub(crate) use errors::{AgentQueryPlanError, AgentQueryRunError, AgentQueryRunPrepareError};
pub(crate) use platform::QueryPlatformAdapter;
pub(crate) use provenance::TerminalQueryRunRegistry;
pub(crate) use terminal_plan::AgentQueryPlanReceipt;
#[cfg(test)]
pub(crate) use terminal_plan::SeedQueryPlanForTest;
pub(crate) use terminal_run::PreparedAgentQueryRun;
