use dopedb_protocol::{
    OperationSummary, QueryCancelArguments, QueryCancelCommand, QueryPlanArguments,
    QueryPlanCommand, QueryPlanResult, QueryRunArguments, QueryRunCommand, QueryRunResult,
    SqlProposeArguments, SqlProposeCommand, MAX_STRING_BYTES,
};
use uuid::Uuid;

use crate::client::{BrokerClient, ClientError};
use crate::commands::connection::{parse_selector, resolve_selector};
use crate::commands::input::read_stdin_utf8;
use crate::output::{self, OutputMode};

const MAX_SQL_INPUT_BYTES: u64 = MAX_STRING_BYTES as u64;

pub(crate) async fn plan(
    connection: &str,
    database: Option<String>,
    file: &str,
    max_rows: Option<u64>,
    mode: OutputMode,
) -> Result<(), ClientError> {
    let sql = read_sql(file)?;
    let client = BrokerClient::discover()?;
    let connection = resolve_selector(&client, parse_selector(connection)?).await?;
    let result: QueryPlanResult = client
        .request::<QueryPlanCommand>(&QueryPlanArguments {
            connection,
            database,
            sql,
            max_rows,
        })
        .await?;
    match mode {
        OutputMode::Json => output::write_json(&result),
        OutputMode::Human => output::write_human(&[
            format!("Plan: {}", result.plan_id),
            format!("Connection: {}", result.connection_name),
            format!("Database: {}", result.database),
            format!("Decision: {}", result.decision),
            format!("Expires: {}", result.expires_at),
        ]),
    }
}

pub(crate) async fn run(plan: &str, mode: OutputMode) -> Result<(), ClientError> {
    let plan_id = parse_uuid(plan)?;
    let client = BrokerClient::discover()?;
    let result: QueryRunResult = client
        .request::<QueryRunCommand>(&QueryRunArguments {
            plan_id,
            connection: None,
        })
        .await?;
    match mode {
        OutputMode::Json => output::write_json(&result),
        OutputMode::Human => {
            let mut lines = vec![
                result.result.columns.join("\t"),
                format!(
                    "{} rows{} in {} ms",
                    result.result.row_count,
                    if result.result.truncated {
                        " (truncated)"
                    } else {
                        ""
                    },
                    result.result.duration_ms
                ),
            ];
            lines.extend(
                result
                    .result
                    .rows
                    .iter()
                    .map(|row| serde_json::to_string(row).unwrap_or_else(|_| "[]".into())),
            );
            output::write_human(&lines)
        }
    }
}

pub(crate) async fn cancel(operation_id: &str, mode: OutputMode) -> Result<(), ClientError> {
    let operation_id = parse_uuid(operation_id)?;
    let client = BrokerClient::discover()?;
    let result: OperationSummary = client
        .request::<QueryCancelCommand>(&QueryCancelArguments {
            operation_id,
            connection: None,
        })
        .await?;
    write_operation(&result, mode)
}

pub(crate) async fn propose(
    connection: &str,
    database: Option<String>,
    file: &str,
    mode: OutputMode,
) -> Result<(), ClientError> {
    let sql = read_sql(file)?;
    let client = BrokerClient::discover()?;
    let connection = resolve_selector(&client, parse_selector(connection)?).await?;
    let result: OperationSummary = client
        .request::<SqlProposeCommand>(&SqlProposeArguments {
            connection,
            database,
            sql,
        })
        .await?;
    write_operation(&result, mode)
}

pub(crate) fn write_operation(
    result: &OperationSummary,
    mode: OutputMode,
) -> Result<(), ClientError> {
    match mode {
        OutputMode::Json => output::write_json(result),
        OutputMode::Human => output::write_human(&[
            format!("Operation: {}", result.operation_id),
            format!("State: {:?}", result.state),
            format!("Payload: {}", result.payload_hash),
        ]),
    }
}

pub(crate) fn parse_uuid(value: &str) -> Result<Uuid, ClientError> {
    Uuid::parse_str(value).map_err(|_| ClientError::InvalidArguments)
}

fn read_sql(file: &str) -> Result<String, ClientError> {
    read_stdin_utf8(file, MAX_SQL_INPUT_BYTES)
}
