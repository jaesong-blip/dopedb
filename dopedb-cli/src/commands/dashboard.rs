//! Provenance-bound dashboard creation through the authenticated local broker.

use dopedb_protocol::{
    DashboardCreateArguments, DashboardCreateCommand, DashboardCreateResult, DashboardKind,
};
use uuid::Uuid;

use crate::client::{BrokerClient, ClientError};
use crate::output::{self, OutputMode};

pub(crate) async fn create(
    query_run: &str,
    title: String,
    description: String,
    kind: DashboardKind,
    x_column: Option<String>,
    y_columns: Vec<String>,
    mode: OutputMode,
) -> Result<(), ClientError> {
    let query_run_id = Uuid::parse_str(query_run).map_err(|_| ClientError::InvalidArguments)?;
    let client = BrokerClient::discover()?;
    let result: DashboardCreateResult = client
        .request::<DashboardCreateCommand>(&DashboardCreateArguments {
            query_run_id,
            title,
            description,
            kind,
            x_column,
            y_columns,
        })
        .await?;
    match mode {
        OutputMode::Json => output::write_json(&result),
        OutputMode::Human => output::write_human(&[
            format!("Dashboard: {}", result.dashboard.id),
            format!("Title: {}", result.dashboard.title),
            format!("Query run: {}", result.query_run_id),
        ]),
    }
}
