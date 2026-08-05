mod creator;
mod metadata;
mod runner;

pub(in crate::features::dashboards) use creator::TerminalDashboardCreator;
pub(in crate::features::dashboards) use metadata::DashboardMetadataAdapter;
pub(in crate::features::dashboards) use runner::DashboardRunner;
#[cfg(test)]
pub(in crate::features::dashboards) use runner::{
    dashboard_result_limits, enforce_dashboard_result,
};
pub(crate) use runner::{DashboardRunError, DashboardRunReceipt};
