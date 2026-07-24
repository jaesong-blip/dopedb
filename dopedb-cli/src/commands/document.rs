//! Typed MongoDB reads through the authenticated local broker.

use dopedb_protocol::{
    DocumentQuery, DocumentRunArguments, DocumentRunCommand, DocumentRunResult, MAX_STRING_BYTES,
};

use crate::client::{BrokerClient, ClientError};
use crate::commands::connection::{parse_selector, resolve_selector};
use crate::commands::input::read_stdin_utf8;
use crate::output::{self, OutputMode};

pub(crate) async fn run(
    connection: &str,
    file: &str,
    max_rows: Option<u64>,
    mode: OutputMode,
) -> Result<(), ClientError> {
    let input = read_stdin_utf8(file, MAX_STRING_BYTES as u64)?;
    let query: DocumentQuery =
        serde_json::from_str(&input).map_err(|_| ClientError::InvalidArguments)?;
    let client = BrokerClient::discover()?;
    let connection = resolve_selector(&client, parse_selector(connection)?).await?;
    let result: DocumentRunResult = client
        .request::<DocumentRunCommand>(&DocumentRunArguments {
            connection,
            query,
            max_rows,
        })
        .await?;
    match mode {
        OutputMode::Json => output::write_json(&result),
        OutputMode::Human => {
            let mut lines = vec![
                format!("Operation: {}", result.operation_id),
                format!("Connection: {}", result.connection_name),
                format!(
                    "{} documents{} in {} ms",
                    result.result.doc_count,
                    if result.result.truncated {
                        " (truncated)"
                    } else {
                        ""
                    },
                    result.result.duration_ms
                ),
            ];
            lines.extend(
                result.result.documents.iter().map(|document| {
                    serde_json::to_string(document).unwrap_or_else(|_| "null".into())
                }),
            );
            output::write_human(&lines)
        }
    }
}
