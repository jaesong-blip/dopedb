//! Exact-revision, read-only Analysis Article execution.

use std::collections::{HashMap, HashSet};

use chrono::Utc;
use dopedb_protocol::{
    AnalysisBlock, AnalysisColumn, AnalysisColumnMasking, AnalysisColumnType,
    AnalysisResultFragment,
};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::executor::cancel;

use super::config::{validate_block_config, BlockColumnConfig};
use super::domain::{AnalysisDataSet, AnalysisDefinitionRunReceipt, AnalysisDefinitionRunRequest};
use super::ports::{AnalysisReadExecutionPort, AnalysisReadExecutionRequest};
use super::transforms::execute_transform;
use super::validation::{max_article_result_bytes, validate_definition};

const FRAGMENT_MAX_BYTES: usize = 1024 * 1024;
const FRAGMENT_MAX_ROWS: usize = 5_000;
const FRAGMENT_MAX_COUNT: usize = 256;

#[derive(Clone)]
pub(crate) struct AnalysisArticleRunner<E> {
    execution: E,
}

impl<E> AnalysisArticleRunner<E>
where
    E: AnalysisReadExecutionPort,
{
    pub(crate) fn new(execution: E) -> Self {
        Self { execution }
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
        self.execution
            .verify_join_mappings(&join_mapping_ids(&request.definition)?)
            .await?;
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
            let outcome = self
                .execution
                .execute_read(AnalysisReadExecutionRequest {
                    workspace_id: request.workspace_id,
                    authority,
                    query,
                    parameter_definitions: &request.definition.parameters,
                    parameters: &parameters,
                    run_id: Uuid::new_v4(),
                    cancellation_id: request.run_id,
                })
                .await?;
            query_receipts.push(outcome.receipt);
            data.insert(query.id.clone(), outcome.data);
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
}

fn join_mapping_ids(
    definition: &dopedb_protocol::AnalysisArticleDefinition,
) -> AppResult<Vec<Uuid>> {
    let mut ids = Vec::new();
    let mut seen = HashSet::new();
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
            .ok_or_else(|| AppError::Config("Analysis Article join mapping is invalid".into()))?;
        if seen.insert(id) {
            ids.push(id);
        }
    }
    Ok(ids)
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
    let mut serialized_bytes = 0_usize;
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
            rows,
            dataset.truncated,
            &mut serialized_bytes,
        )?;
    }
    Ok(fragments)
}

fn append_fragments(
    output: &mut Vec<AnalysisResultFragment>,
    block_id: &str,
    columns: &[AnalysisColumn],
    rows: Vec<Vec<Value>>,
    source_truncated: bool,
    serialized_bytes: &mut usize,
) -> AppResult<()> {
    let mut ordinal = 0_u16;
    let mut current = Vec::<Vec<Value>>::new();
    let mut current_payload_bytes = 0_usize;
    let flush = |output: &mut Vec<AnalysisResultFragment>,
                 current: &mut Vec<Vec<Value>>,
                 ordinal: u16,
                 source_truncated: bool,
                 serialized_bytes: &mut usize|
     -> AppResult<()> {
        if output.len() >= FRAGMENT_MAX_COUNT {
            return Err(AppError::Blocked {
                reason: "Analysis Article result needs more than 256 fragments".into(),
            });
        }
        let fragment = AnalysisResultFragment {
            version: 1,
            block_id: block_id.to_owned(),
            ordinal,
            columns: columns.to_vec(),
            rows: std::mem::take(current),
            truncated: source_truncated,
        };
        let fragment_bytes = serde_json::to_vec(&fragment)?.len();
        if fragment_bytes > FRAGMENT_MAX_BYTES {
            return Err(AppError::Blocked {
                reason: format!(
                    "Analysis Article block '{block_id}' produced a fragment larger than 1 MiB"
                ),
            });
        }
        let next_total = serialized_bytes
            .checked_add(fragment_bytes)
            .ok_or_else(|| AppError::Blocked {
                reason: "Analysis Article shared result size overflowed".into(),
            })?;
        if next_total > max_article_result_bytes() {
            return Err(AppError::Blocked {
                reason: "Analysis Article shared result exceeds 16 MiB".into(),
            });
        }
        *serialized_bytes = next_total;
        output.push(fragment);
        Ok(())
    };
    if rows.is_empty() {
        return flush(
            output,
            &mut current,
            ordinal,
            source_truncated,
            serialized_bytes,
        );
    }
    let mut base_bytes =
        empty_fragment_serialized_size(block_id, ordinal, columns, source_truncated)?;
    for row in rows {
        let row_bytes = serde_json::to_vec(&row)?.len();
        let separator_bytes = usize::from(!current.is_empty());
        let candidate_bytes = base_bytes
            .checked_add(current_payload_bytes)
            .and_then(|bytes| bytes.checked_add(separator_bytes))
            .and_then(|bytes| bytes.checked_add(row_bytes))
            .ok_or_else(|| AppError::Blocked {
                reason: "Analysis Article fragment size overflowed".into(),
            })?;
        if current.len() >= FRAGMENT_MAX_ROWS || candidate_bytes > FRAGMENT_MAX_BYTES {
            if current.is_empty() {
                return Err(AppError::Blocked {
                    reason: format!(
                        "Analysis Article block '{block_id}' has a row larger than 1 MiB"
                    ),
                });
            }
            flush(
                output,
                &mut current,
                ordinal,
                source_truncated,
                serialized_bytes,
            )?;
            ordinal = ordinal.checked_add(1).ok_or_else(|| AppError::Blocked {
                reason: "Analysis Article fragment ordinal overflowed".into(),
            })?;
            current_payload_bytes = 0;
            base_bytes =
                empty_fragment_serialized_size(block_id, ordinal, columns, source_truncated)?;
            if base_bytes
                .checked_add(row_bytes)
                .is_none_or(|bytes| bytes > FRAGMENT_MAX_BYTES)
            {
                return Err(AppError::Blocked {
                    reason: format!(
                        "Analysis Article block '{block_id}' has a row larger than 1 MiB"
                    ),
                });
            }
        }
        current_payload_bytes += usize::from(!current.is_empty()) + row_bytes;
        current.push(row);
    }
    flush(
        output,
        &mut current,
        ordinal,
        source_truncated,
        serialized_bytes,
    )
}

fn empty_fragment_serialized_size(
    block_id: &str,
    ordinal: u16,
    columns: &[AnalysisColumn],
    truncated: bool,
) -> AppResult<usize> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct BorrowedFragment<'a> {
        version: u32,
        block_id: &'a str,
        ordinal: u16,
        columns: &'a [AnalysisColumn],
        rows: &'a [Vec<Value>],
        truncated: bool,
    }

    Ok(serde_json::to_vec(&BorrowedFragment {
        version: 1,
        block_id,
        ordinal,
        columns,
        rows: &[],
        truncated,
    })?
    .len())
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

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

#[cfg(test)]
pub(crate) fn assert_runner_safety_contract() {
    super::adapters::assert_parameter_binding_contract();
    super::adapters::assert_hosted_mutation_error_contract();

    let control_plane_fixture: Value = serde_json::from_str(include_str!(
        "../../../../dopedb-protocol/tests/fixtures/control-plane-contracts-v1.json"
    ))
    .expect("control-plane fixture must decode");
    let valid_article: dopedb_protocol::SharedAnalysisArticleCreate =
        serde_json::from_value(control_plane_fixture["analysisArticleCreate"].clone())
            .expect("golden Analysis Article must decode");
    assert!(super::validation::validate_shared_create(&valid_article).is_ok());
    let mut invalid_heading = valid_article;
    invalid_heading.definition.blocks[0].kind = dopedb_protocol::AnalysisBlockKind::Heading;
    invalid_heading.definition.blocks[0].source_node_id = None;
    invalid_heading.definition.blocks[0].config = serde_json::json!({ "level": 1 });
    assert!(super::validation::validate_shared_create(&invalid_heading).is_err());

    let column = AnalysisColumn {
        name: "value".into(),
        column_type: AnalysisColumnType::String,
        nullable: false,
        role: dopedb_protocol::AnalysisColumnRole::Dimension,
        sensitivity: dopedb_protocol::AnalysisColumnSensitivity::Internal,
        masking: AnalysisColumnMasking::None,
    };
    let mut fragments = Vec::new();
    let mut at_shared_limit = max_article_result_bytes();
    assert!(append_fragments(
        &mut fragments,
        "block",
        std::slice::from_ref(&column),
        Vec::new(),
        false,
        &mut at_shared_limit,
    )
    .is_err());
    assert!(fragments.is_empty());

    let mut serialized_bytes = 0;
    assert!(append_fragments(
        &mut fragments,
        "block",
        &[column],
        vec![vec![Value::String("x".repeat(FRAGMENT_MAX_BYTES))]],
        false,
        &mut serialized_bytes,
    )
    .is_err());
    assert!(fragments.is_empty());
}
