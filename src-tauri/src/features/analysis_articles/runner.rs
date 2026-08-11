//! Exact-revision, read-only Analysis Article execution.

use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::Utc;
use dopedb_protocol::{
    AnalysisBlock, AnalysisColumn, AnalysisColumnMasking, AnalysisColumnType, AnalysisQueryReceipt,
    AnalysisQueryState, AnalysisResultFragment,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::audit::{self, RecordArgs};
use crate::connection::{ConnectionAccess, ConnectionManager, DbPool};
use crate::error::{AppError, AppResult};
use crate::executor::cancel;
use crate::model::{Engine, HistoryEntry, QueryKind, QueryResult};
use crate::operations::canonical_hash;
use crate::safety::{self, PoolRef};
use crate::store::{PinnedConnection, Store};

use super::config::{validate_block_config, BlockColumnConfig};
use super::domain::{AnalysisDataSet, AnalysisDefinitionRunReceipt, AnalysisDefinitionRunRequest};
use super::transforms::execute_transform;
use super::validation::validate_definition;

const FRAGMENT_MAX_BYTES: usize = 1024 * 1024;
const FRAGMENT_MAX_ROWS: usize = 5_000;
const FRAGMENT_MAX_COUNT: usize = 256;

#[derive(Clone)]
pub(crate) struct AnalysisArticleRunner {
    store: Store,
    connections: ConnectionManager,
}

impl AnalysisArticleRunner {
    pub(crate) fn new(store: Store, connections: ConnectionManager) -> Self {
        Self { store, connections }
    }

    pub(crate) async fn run_definition(
        &self,
        request: AnalysisDefinitionRunRequest,
    ) -> AppResult<AnalysisDefinitionRunReceipt> {
        let started_at = Utc::now();
        if request.article_revision < 1 {
            return Err(AppError::Config(
                "Analysis Article revision must be positive".into(),
            ));
        }
        let parameters = validate_definition(
            &request.definition,
            &request.connections,
            &request.parameter_values,
        )?;
        self.verify_join_mappings(&request.definition).await?;
        let cancellation = cancel::register(request.run_id);
        let connections = request
            .connections
            .iter()
            .map(|connection| (connection.role.as_str(), connection))
            .collect::<HashMap<_, _>>();
        let mut data = HashMap::<String, AnalysisDataSet>::new();
        let mut query_receipts = Vec::with_capacity(request.definition.queries.len());

        for query in &request.definition.queries {
            if cancellation.is_cancelled() {
                return Err(AppError::Safety("Analysis Article run cancelled".into()));
            }
            let authority = connections
                .get(query.connection_role.as_str())
                .ok_or_else(|| {
                    AppError::Config("Analysis Article query lost its connection authority".into())
                })?;
            let sql = render_sql(&query.sql, &query.parameter_ids, &parameters)?;
            let query_run_id = Uuid::new_v4();
            let operation_scope = self.connections.begin_operation_scope().await;
            let local_connection_id = if let Some(workspace_id) = request.workspace_id {
                self.store
                    .local_connection_id_for_remote(workspace_id, authority.connection_id)
                    .await?
                    .ok_or_else(|| AppError::Blocked {
                        reason: format!(
                            "Analysis Article connection '{}' needs a local credential binding on this device",
                            authority.alias
                        ),
                    })?
            } else {
                authority.connection_id
            };
            let pin = operation_scope.pin_connection(local_connection_id).await?;
            if pin.connection_revision != authority.connection_revision {
                return Err(AppError::Blocked {
                    reason: format!(
                        "Analysis Article connection '{}' changed from revision {} to {}",
                        authority.alias, authority.connection_revision, pin.connection_revision
                    ),
                });
            }
            if pin.profile.engine == Engine::Mongodb {
                return Err(AppError::Blocked {
                    reason: "Analysis Articles currently require a relational read source; document sources must use a typed document node".into(),
                });
            }
            let classification = safety::classify(&sql, pin.profile.engine)?;
            if classification.kind != QueryKind::Read || classification.statement_count != 1 {
                return Err(AppError::Blocked {
                    reason: "Analysis Article queries must be one read-only statement".into(),
                });
            }
            let settings = self.store.get_safety(local_connection_id.into()).await?;
            let maximum_rows = query.max_rows.min(settings.max_rows.max(1));
            let lease = operation_scope
                .connect(pin.clone(), ConnectionAccess::Read)
                .await?;
            let live = lease.live().sql()?;
            let result = safety::run_read_only_byte_capped_cancellable(
                pool_ref(live.ro()),
                &sql,
                maximum_rows,
                query.max_bytes,
                Some(&cancellation),
            )
            .await;
            let result = match result {
                Ok(result) => result,
                Err(error) => {
                    record_query(
                        &self.store,
                        &pin,
                        &sql,
                        "error",
                        None,
                        None,
                        Some(error.to_string()),
                    )
                    .await;
                    return Err(error);
                }
            };
            if let Err(error) =
                validate_query_result_columns(&query.columns, &result, query.id.as_str())
            {
                record_query(
                    &self.store,
                    &pin,
                    &sql,
                    "error",
                    Some(result.row_count as i64),
                    Some(result.duration_ms as i64),
                    Some(error.to_string()),
                )
                .await;
                return Err(error);
            }
            let byte_count = serde_json::to_vec(&result)?.len();
            if byte_count > query.max_bytes {
                let error = AppError::Blocked {
                    reason: format!("Analysis query '{}' exceeded its byte budget", query.title),
                };
                record_query(
                    &self.store,
                    &pin,
                    &sql,
                    "error",
                    Some(result.row_count as i64),
                    Some(result.duration_ms as i64),
                    Some(error.to_string()),
                )
                .await;
                return Err(error);
            }
            record_query(
                &self.store,
                &pin,
                &sql,
                "ok",
                Some(result.row_count as i64),
                Some(result.duration_ms as i64),
                None,
            )
            .await;
            query_receipts.push(AnalysisQueryReceipt {
                query_node_id: query.id.clone(),
                connection_id: authority.connection_id,
                connection_revision: authority.connection_revision,
                query_run_id,
                query_hash: canonical_hash(&serde_json::json!({
                    "sql": query.sql,
                    "parameterValues": parameters,
                }))?,
                schema_fingerprint: schema_fingerprint(&query.columns)?,
                state: AnalysisQueryState::Succeeded,
                row_count: result.row_count as u64,
                byte_count: byte_count as u64,
                duration_ms: result.duration_ms,
            });
            data.insert(
                query.id.clone(),
                AnalysisDataSet {
                    columns: query.columns.clone(),
                    rows: result.rows,
                    truncated: result.truncated,
                },
            );
            drop(lease);
        }

        for transform in &request.definition.transforms {
            if cancellation.is_cancelled() {
                return Err(AppError::Safety("Analysis Article run cancelled".into()));
            }
            let inputs = transform
                .input_node_ids
                .iter()
                .map(|input| {
                    data.get(input).ok_or_else(|| {
                        AppError::Config(
                            "Analysis Article transform input was not materialized".into(),
                        )
                    })
                })
                .collect::<AppResult<Vec<_>>>()?;
            let output = execute_transform(transform, &inputs, &cancellation)?;
            data.insert(transform.id.clone(), output);
        }

        let fragments = build_fragments(&request.definition, &data, &cancellation)?;
        let result_hash = sha256(&serde_json::to_vec(&fragments)?);
        Ok(AnalysisDefinitionRunReceipt {
            run_id: request.run_id,
            article_id: request.article_id,
            article_revision: request.article_revision,
            parameter_values: parameters,
            query_receipts,
            fragments,
            result_hash,
            started_at,
            finished_at: Utc::now(),
        })
    }

    async fn verify_join_mappings(
        &self,
        definition: &dopedb_protocol::AnalysisArticleDefinition,
    ) -> AppResult<()> {
        let mut ids = HashSet::new();
        for transform in &definition.transforms {
            if !matches!(
                transform.operation,
                dopedb_protocol::AnalysisTransformOperation::Union
                    | dopedb_protocol::AnalysisTransformOperation::InnerJoin
                    | dopedb_protocol::AnalysisTransformOperation::LeftJoin
            ) {
                continue;
            }
            let id = transform
                .config
                .get("mappingProposalId")
                .and_then(Value::as_str)
                .and_then(|value| Uuid::parse_str(value).ok())
                .ok_or_else(|| {
                    AppError::Config("Analysis Article join mapping is invalid".into())
                })?;
            ids.insert(id);
        }
        for id in ids {
            let approved = sqlx::query(
                "SELECT 1 FROM knowledge_mapping_proposals WHERE id = ?1 AND state = 'approved' LIMIT 1",
            )
            .bind(id.to_string())
            .fetch_optional(self.store.pool())
            .await?
            .is_some();
            if !approved {
                return Err(AppError::Blocked {
                    reason: format!(
                        "Analysis Article cross-source mapping {id} is not approved locally"
                    ),
                });
            }
        }
        Ok(())
    }
}

fn render_sql(
    sql: &str,
    parameter_ids: &[String],
    parameters: &BTreeMap<String, Value>,
) -> AppResult<String> {
    let mut rendered = sql.to_owned();
    for id in parameter_ids {
        let value = parameters.get(id).ok_or_else(|| {
            AppError::Config(format!("Analysis Article parameter is missing: {id}"))
        })?;
        let literal = match value {
            Value::Null => "NULL".into(),
            Value::Bool(value) => if *value { "TRUE" } else { "FALSE" }.into(),
            Value::Number(value) => value.to_string(),
            Value::String(value) => format!("'{}'", value.replace('\'', "''")),
            Value::Array(_) | Value::Object(_) => {
                return Err(AppError::Config(format!(
                    "Analysis Article parameter is not scalar: {id}"
                )))
            }
        };
        let token = format!("{{{{{id}}}}}");
        if rendered.matches(&token).count() != 1 {
            return Err(AppError::Config(format!(
                "Analysis Article parameter token changed: {id}"
            )));
        }
        rendered = rendered.replace(&token, &literal);
    }
    if rendered.contains("{{") || rendered.contains("}}") {
        return Err(AppError::Config(
            "Analysis Article SQL contains an unresolved parameter".into(),
        ));
    }
    Ok(rendered)
}

fn validate_query_result_columns(
    declared: &[AnalysisColumn],
    result: &QueryResult,
    query_id: &str,
) -> AppResult<()> {
    let names = declared
        .iter()
        .map(|column| column.name.as_str())
        .collect::<Vec<_>>();
    if result
        .columns
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        != names
        || result.rows.iter().any(|row| row.len() != declared.len())
    {
        return Err(AppError::Blocked {
            reason: format!(
                "Analysis query '{query_id}' result schema changed; review the Article before sharing new results"
            ),
        });
    }
    Ok(())
}

fn required_block_columns(
    definition: &dopedb_protocol::AnalysisArticleDefinition,
    block: &AnalysisBlock,
) -> AppResult<Vec<String>> {
    match validate_block_config(block.kind, &block.config)? {
        BlockColumnConfig::Data(columns) => Ok(columns),
        BlockColumnConfig::Metric {
            metric_id,
            mut columns,
        } => {
            let metric = definition
                .metrics
                .iter()
                .find(|metric| metric.id == metric_id)
                .ok_or_else(|| AppError::Config("Analysis metric no longer exists".into()))?;
            columns.insert(0, metric.value_column.clone());
            let mut seen = HashSet::new();
            columns.retain(|column| seen.insert(column.clone()));
            Ok(columns)
        }
        BlockColumnConfig::None | BlockColumnConfig::Control(_) => Ok(Vec::new()),
    }
}

fn build_fragments(
    definition: &dopedb_protocol::AnalysisArticleDefinition,
    data: &HashMap<String, AnalysisDataSet>,
    cancellation: &cancel::CancelHandle,
) -> AppResult<Vec<AnalysisResultFragment>> {
    let mut fragments = Vec::new();
    for block in &definition.blocks {
        let Some(source) = block.source_node_id.as_deref() else {
            continue;
        };
        let dataset = data.get(source).ok_or_else(|| {
            AppError::Config("Analysis Article block source was not materialized".into())
        })?;
        let required = required_block_columns(definition, block)?;
        let indexes = required
            .iter()
            .map(|name| {
                dataset
                    .columns
                    .iter()
                    .position(|column| column.name == *name)
                    .ok_or_else(|| {
                        AppError::Config("Analysis Article block column disappeared".into())
                    })
            })
            .collect::<AppResult<Vec<_>>>()?;
        let columns = indexes
            .iter()
            .map(|index| dataset.columns[*index].clone())
            .collect::<Vec<_>>();
        let rows = dataset
            .rows
            .iter()
            .enumerate()
            .map(|(ordinal, row)| {
                if ordinal % 256 == 0 && cancellation.is_cancelled() {
                    return Err(AppError::Safety("Analysis Article run cancelled".into()));
                }
                indexes
                    .iter()
                    .enumerate()
                    .map(|(column_index, index)| {
                        mask_value(
                            &columns[column_index],
                            row.get(*index).unwrap_or(&Value::Null),
                        )
                    })
                    .collect::<AppResult<Vec<_>>>()
            })
            .collect::<AppResult<Vec<_>>>()?;
        append_fragments(
            &mut fragments,
            &block.id,
            &columns,
            &rows,
            dataset.truncated,
        )?;
        if fragments.len() > FRAGMENT_MAX_COUNT {
            return Err(AppError::Blocked {
                reason: "Analysis Article result needs more than 256 fragments".into(),
            });
        }
    }
    Ok(fragments)
}

fn append_fragments(
    output: &mut Vec<AnalysisResultFragment>,
    block_id: &str,
    columns: &[AnalysisColumn],
    rows: &[Vec<Value>],
    source_truncated: bool,
) -> AppResult<()> {
    let mut ordinal = 0_u16;
    let mut current = Vec::<Vec<Value>>::new();
    let flush = |output: &mut Vec<AnalysisResultFragment>,
                 current: &mut Vec<Vec<Value>>,
                 ordinal: u16,
                 source_truncated: bool|
     -> AppResult<()> {
        output.push(AnalysisResultFragment {
            version: 1,
            block_id: block_id.to_owned(),
            ordinal,
            columns: columns.to_vec(),
            rows: std::mem::take(current),
            truncated: source_truncated,
        });
        Ok(())
    };
    if rows.is_empty() {
        return flush(output, &mut current, ordinal, source_truncated);
    }
    for row in rows {
        current.push(row.clone());
        let candidate = AnalysisResultFragment {
            version: 1,
            block_id: block_id.to_owned(),
            ordinal,
            columns: columns.to_vec(),
            rows: current.clone(),
            truncated: source_truncated,
        };
        if current.len() > FRAGMENT_MAX_ROWS
            || serde_json::to_vec(&candidate)?.len() > FRAGMENT_MAX_BYTES
        {
            let last = current.pop().expect("candidate has one row");
            if current.is_empty() {
                return Err(AppError::Blocked {
                    reason: format!(
                        "Analysis Article block '{block_id}' has a row larger than 1 MiB"
                    ),
                });
            }
            flush(output, &mut current, ordinal, source_truncated)?;
            ordinal = ordinal.checked_add(1).ok_or_else(|| AppError::Blocked {
                reason: "Analysis Article fragment ordinal overflowed".into(),
            })?;
            current.push(last);
        }
    }
    flush(output, &mut current, ordinal, source_truncated)
}

fn mask_value(column: &AnalysisColumn, value: &Value) -> AppResult<Value> {
    Ok(match column.masking {
        AnalysisColumnMasking::None => value.clone(),
        AnalysisColumnMasking::Redact => Value::Null,
        AnalysisColumnMasking::Hash => value
            .as_str()
            .map(|value| Value::String(sha256(value.as_bytes())))
            .unwrap_or(Value::Null),
        AnalysisColumnMasking::Bucket => match column.column_type {
            AnalysisColumnType::Date | AnalysisColumnType::Datetime => value
                .as_str()
                .map(|value| Value::String(value.chars().take(7).collect()))
                .unwrap_or(Value::Null),
            AnalysisColumnType::Number
            | AnalysisColumnType::Duration
            | AnalysisColumnType::Currency
            | AnalysisColumnType::Percent => {
                let numeric = value
                    .as_f64()
                    .or_else(|| value.as_str().and_then(|value| value.parse::<f64>().ok()));
                numeric
                    .filter(|value| value.is_finite())
                    .and_then(|value| {
                        let magnitude = if value == 0.0 {
                            1.0
                        } else {
                            10_f64.powf(value.abs().log10().floor())
                        };
                        serde_json::Number::from_f64((value / magnitude).floor() * magnitude)
                    })
                    .map(Value::Number)
                    .unwrap_or(Value::Null)
            }
            AnalysisColumnType::String | AnalysisColumnType::Json => value
                .as_str()
                .map(|value| match value.chars().count() {
                    0..=3 => "0-3",
                    4..=7 => "4-7",
                    8..=15 => "8-15",
                    _ => "16+",
                })
                .map(|value| Value::String(value.into()))
                .unwrap_or(Value::Null),
            AnalysisColumnType::Boolean => value.clone(),
        },
    })
}

fn schema_fingerprint(columns: &[AnalysisColumn]) -> AppResult<String> {
    canonical_hash(&serde_json::to_value(columns)?)
}

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

async fn record_query(
    store: &Store,
    pin: &PinnedConnection,
    sql: &str,
    status: &str,
    row_count: Option<i64>,
    duration_ms: Option<i64>,
    error: Option<String>,
) {
    if let Err(record_error) = audit::record(
        store,
        RecordArgs {
            connection_id: pin.connection_id,
            engine: pin.profile.engine,
            agent_prompt: None,
            sql: sql.to_owned(),
            kind: QueryKind::Read,
            action: "analysis_article:run".into(),
            approved_by: None,
            affected_estimate: row_count,
            error: error.clone(),
        },
    )
    .await
    {
        tracing::error!(connection_id = %pin.connection_id, %record_error, "Analysis Article audit record failed");
    }
    if let Err(history_error) = store
        .insert_history_if_current(
            pin,
            &HistoryEntry {
                id: Uuid::new_v4(),
                connection_id: pin.connection_id,
                sql: sql.to_owned(),
                kind: QueryKind::Read,
                status: status.into(),
                row_count,
                duration_ms,
                error,
                executed_at: Utc::now(),
                origin: "analysis_article".into(),
            },
        )
        .await
    {
        tracing::error!(connection_id = %pin.connection_id, %history_error, "Analysis Article history insert failed");
    }
}

fn pool_ref(pool: &DbPool) -> PoolRef<'_> {
    match pool {
        DbPool::Postgres(pool) => PoolRef::Postgres(pool),
        DbPool::Mysql(pool) => PoolRef::Mysql(pool),
        DbPool::Sqlite(pool) => PoolRef::Sqlite(pool),
    }
}
