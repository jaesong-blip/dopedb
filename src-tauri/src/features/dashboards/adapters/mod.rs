mod creator;
mod metadata;
mod runner;

pub(in crate::features::dashboards) use creator::TerminalDashboardCreator;
pub(in crate::features::dashboards) use metadata::DashboardMetadataAdapter;
pub(in crate::features::dashboards) use runner::DashboardRunner;
pub(crate) use runner::{DashboardRunError, DashboardRunReceipt};
