//! Read-only multi-statement execution with durable receipts.

use super::*;

impl ScriptPlatformAdapter {
    pub(super) async fn run_reads(
        &self,
        prepared: PreparedScriptRun,
    ) -> Result<DesktopScriptRunReceipt, DesktopScriptRunError> {
        let PreparedScriptRun {
            operation_scope,
            operation_pin,
            operation,
            payload,
            statements,
            kinds: _,
            settings,
            engine,
            history_origin,
        } = prepared;
        let operation_id = operation.record().id;

        let lease = match operation_scope
            .connect(operation_pin.clone(), ConnectionAccess::Read)
            .await
        {
            Ok(lease) => lease,
            Err(error) => {
                record_script_run(
                    &self.store,
                    &operation_pin,
                    ScriptRunRecord {
                        sql: &payload.sql,
                        kind: QueryKind::Read,
                        action: "script:execute",
                        status: "error",
                        row_count: None,
                        error: Some(error.to_string()),
                        origin: &history_origin,
                    },
                )
                .await;
                let _ = self
                    .operation
                    .fail(
                        operation_id,
                        &serde_json::json!({"reason": "connection_failed"}),
                    )
                    .await;
                return Err(DesktopScriptRunError::Application(error));
            }
        };
        let live = match lease.live().sql() {
            Ok(live) => live,
            Err(error) => {
                let _ = self
                    .operation
                    .fail(
                        operation_id,
                        &serde_json::json!({"reason": "sql_backend_unavailable"}),
                    )
                    .await;
                return Err(DesktopScriptRunError::Execution(Box::new(
                    DesktopScriptExecutionFailure {
                        error,
                        _lease: lease,
                    },
                )));
            }
        };
        let mut outcomes = Vec::with_capacity(statements.len());
        let mut failure = None;
        for statement in &statements {
            if failure.is_some() {
                outcomes.push(statement_skipped(statement));
                continue;
            }
            match executor::run_read(
                live,
                engine,
                statement,
                settings.max_rows,
                Some(operation_id),
            )
            .await
            {
                Ok(result) => outcomes.push(ScriptStatement {
                    sql: statement.clone(),
                    result: Some(result),
                    affected: None,
                    error: None,
                }),
                Err(error) => {
                    let message = error.to_string();
                    outcomes.push(statement_error(statement, message.clone()));
                    failure = Some(message);
                }
            }
        }
        let total = outcomes
            .iter()
            .filter_map(|statement| statement.result.as_ref())
            .map(|result| result.row_count as i64)
            .sum();
        let failed = failure.is_some();
        let (status, error) = match failure {
            Some(error) => ("error", Some(error)),
            None => ("ok", None),
        };
        record_script_run(
            &self.store,
            &operation_pin,
            ScriptRunRecord {
                sql: &payload.sql,
                kind: QueryKind::Read,
                action: "script:execute",
                status,
                row_count: Some(total),
                error,
                origin: &history_origin,
            },
        )
        .await;
        let operation_result = if failed {
            self.operation
                .fail(
                    operation_id,
                    &serde_json::json!({"reason": "script_statement_failed"}),
                )
                .await
        } else {
            self.operation
                .succeed(
                    operation_id,
                    &serde_json::json!({"rowCount": total, "statementCount": statements.len()}),
                )
                .await
        };
        operation_result.map_err(DesktopScriptRunError::Application)?;
        Ok(DesktopScriptRunReceipt {
            outcome: ScriptOutcome {
                statements: outcomes,
                committed: false,
                all_reads: true,
            },
            _lease: lease,
        })
    }
}
