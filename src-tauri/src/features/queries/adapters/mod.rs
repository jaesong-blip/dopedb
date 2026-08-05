//! Concrete platform adapters for desktop and authenticated Terminal SQL Query workflows.

mod desktop_contracts;
mod desktop_execution;
mod desktop_inspection;
mod desktop_planning;
mod desktop_port;
mod desktop_provenance;
mod desktop_result_store;
mod desktop_stream_lifecycle;
mod desktop_stream_registry;
mod desktop_support;
mod desktop_trace;
mod errors;
mod platform;
mod provenance;
mod terminal_plan;
mod terminal_run;
mod terminal_support;

pub(crate) use desktop_contracts::{
    DesktopSqlInspectionError, DesktopSqlInspectionReceipt, DesktopSqlProposalReceipt,
    DesktopSqlRunError, DesktopSqlRunReceipt, DesktopSqlStreamReceipt,
};
pub(crate) use desktop_result_store::DesktopSqlResultAuthority;
pub(crate) use desktop_stream_lifecycle::{DesktopStreamCleanupOwner, DesktopStreamCleanupRuntime};
pub(crate) use desktop_stream_registry::DesktopSqlStreamRegistry;
pub(crate) use errors::{AgentQueryPlanError, AgentQueryRunError, AgentQueryRunPrepareError};
pub(crate) use platform::QueryPlatformAdapter;
pub(crate) use provenance::TerminalQueryRunRegistry;
pub(crate) use terminal_plan::AgentQueryPlanReceipt;
pub(crate) use terminal_run::PreparedAgentQueryRun;
