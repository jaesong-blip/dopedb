//! Runtime validation for the cloud-neutral Analysis Article contract.

use std::collections::{BTreeMap, HashMap, HashSet};

use dopedb_protocol::{
    AnalysisArticleConnection, AnalysisArticleDefinition, AnalysisBlockKind, AnalysisColumn,
    AnalysisColumnMasking, AnalysisColumnRole, AnalysisColumnSensitivity, AnalysisColumnType,
    AnalysisNumberStyle, AnalysisParameter, AnalysisParameterType, AnalysisRefreshMode,
    AnalysisTransformOperation,
};
use serde_json::Value;

use crate::error::{AppError, AppResult};

use super::config::{
    parse_transform_config, validate_block_config, AggregateFunction, BlockColumnConfig,
    TransformConfig, WindowFunction,
};

const MAX_ARTICLE_RESULT_BYTES: usize = 16 * 1024 * 1024;

pub(crate) fn max_article_result_bytes() -> usize {
    MAX_ARTICLE_RESULT_BYTES
}

fn valid_id(value: &str) -> bool {
    let mut characters = value.chars();
    characters
        .next()
        .is_some_and(|character| character.is_ascii_alphabetic())
        && value.len() <= 64
        && characters
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
}

fn safe_text(value: &str, maximum: usize, allow_empty: bool) -> bool {
    (allow_empty || !value.trim().is_empty())
        && value.chars().count() <= maximum
        && !value.chars().any(|character| {
            character == '\0'
                || (character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
                || matches!(
                    character,
                    '\u{202a}'
                        | '\u{202b}'
                        | '\u{202c}'
                        | '\u{202d}'
                        | '\u{202e}'
                        | '\u{2066}'
                        | '\u{2067}'
                        | '\u{2068}'
                        | '\u{2069}'
                )
        })
}

fn parameter_value_is_valid(parameter: &AnalysisParameter, value: &Value) -> bool {
    if value.is_null() {
        return !parameter.required;
    }
    match parameter.parameter_type {
        AnalysisParameterType::Boolean => value.is_boolean(),
        AnalysisParameterType::Number => value.as_f64().is_some_and(f64::is_finite),
        AnalysisParameterType::String => value
            .as_str()
            .is_some_and(|value| safe_text(value, 4_000, true)),
        AnalysisParameterType::Date => value
            .as_str()
            .is_some_and(|value| chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok()),
        AnalysisParameterType::Datetime => value
            .as_str()
            .is_some_and(|value| chrono::DateTime::parse_from_rfc3339(value).is_ok()),
        AnalysisParameterType::Enum => value
            .as_str()
            .is_some_and(|value| parameter.options.iter().any(|option| option == value)),
    }
}

fn validate_column(column: &AnalysisColumn) -> AppResult<()> {
    if !safe_text(&column.name, 256, false)
        || (column.role == AnalysisColumnRole::Identifier
            && !matches!(
                column.masking,
                AnalysisColumnMasking::Hash | AnalysisColumnMasking::Redact
            ))
        || (column.role == AnalysisColumnRole::FreeText
            && column.masking != AnalysisColumnMasking::Redact)
        || (column.sensitivity == AnalysisColumnSensitivity::Restricted
            && column.masking != AnalysisColumnMasking::Redact)
        || (column.sensitivity == AnalysisColumnSensitivity::Confidential
            && column.masking == AnalysisColumnMasking::None)
        || (column.masking == AnalysisColumnMasking::Hash
            && column.column_type != AnalysisColumnType::String)
    {
        return Err(AppError::Config(
            "Analysis Article has an unsafe column policy".into(),
        ));
    }
    Ok(())
}

fn validate_columns(columns: &[AnalysisColumn]) -> AppResult<()> {
    if columns.is_empty() || columns.len() > 256 {
        return Err(AppError::Config(
            "Analysis Article node must declare 1 to 256 columns".into(),
        ));
    }
    let mut names = HashSet::with_capacity(columns.len());
    for column in columns {
        validate_column(column)?;
        if !names.insert(column.name.as_str()) {
            return Err(AppError::Config(
                "Analysis Article node has duplicate columns".into(),
            ));
        }
    }
    Ok(())
}

fn same_schema(left: &[AnalysisColumn], right: &[AnalysisColumn]) -> bool {
    left == right
}

fn column<'a>(columns: &'a [AnalysisColumn], name: &str) -> Option<&'a AnalysisColumn> {
    columns.iter().find(|column| column.name == name)
}

fn projected_schema(input: &[AnalysisColumn], output: &[AnalysisColumn], names: &[String]) -> bool {
    names.len() == output.len()
        && names
            .iter()
            .zip(output)
            .all(|(name, output)| column(input, name) == Some(output))
}

fn inherited_schema(input: &[AnalysisColumn], output: &[AnalysisColumn]) -> bool {
    input
        .iter()
        .all(|input| column(output, &input.name) == Some(input))
}

fn validate_transform_schema(
    operation: AnalysisTransformOperation,
    config: &TransformConfig,
    inputs: &[&[AnalysisColumn]],
    output: &[AnalysisColumn],
) -> AppResult<()> {
    let first = inputs[0];
    let valid = match (operation, config) {
        (AnalysisTransformOperation::Filter, TransformConfig::Filter(config)) => {
            same_schema(first, output) && column(first, &config.column).is_some()
        }
        (AnalysisTransformOperation::Sort, TransformConfig::Sort(config)) => {
            same_schema(first, output)
                && !config.columns.is_empty()
                && config.columns.len() <= 32
                && config
                    .columns
                    .iter()
                    .all(|item| column(first, &item.column).is_some())
        }
        (AnalysisTransformOperation::Limit, TransformConfig::Limit(config)) => {
            same_schema(first, output) && (1..=50_000).contains(&config.count)
        }
        (AnalysisTransformOperation::Project, TransformConfig::Project(config))
        | (AnalysisTransformOperation::Group, TransformConfig::Group(config)) => {
            !config.columns.is_empty()
                && config.columns.len() <= 256
                && projected_schema(first, output, &config.columns)
        }
        (AnalysisTransformOperation::Union, TransformConfig::Union(config)) => {
            let _approved_mapping = config.mapping_proposal_id;
            same_schema(first, inputs[1]) && same_schema(first, output)
        }
        (AnalysisTransformOperation::Aggregate, TransformConfig::Aggregate(config)) => {
            if config.group_by.len() > 32
                || config.measures.is_empty()
                || config.measures.len() > 64
                || output.len() != config.group_by.len() + config.measures.len()
                || !projected_schema(first, &output[..config.group_by.len()], &config.group_by)
            {
                false
            } else {
                config.measures.iter().enumerate().all(|(index, measure)| {
                    let Some(source) = column(first, &measure.column) else {
                        return false;
                    };
                    let result = &output[config.group_by.len() + index];
                    result.name == measure.output
                        && result.role == AnalysisColumnRole::Measure
                        && matches!(
                            result.column_type,
                            AnalysisColumnType::Number
                                | AnalysisColumnType::Duration
                                | AnalysisColumnType::Currency
                                | AnalysisColumnType::Percent
                        )
                        && (matches!(
                            measure.function,
                            AggregateFunction::Count | AggregateFunction::CountDistinct
                        ) || matches!(
                            source.column_type,
                            AnalysisColumnType::Number
                                | AnalysisColumnType::Duration
                                | AnalysisColumnType::Currency
                                | AnalysisColumnType::Percent
                        ))
                })
            }
        }
        (
            AnalysisTransformOperation::InnerJoin | AnalysisTransformOperation::LeftJoin,
            TransformConfig::Join(config),
        ) => {
            let second = inputs[1];
            let _approved_mapping = config.mapping_proposal_id;
            !config.keys.is_empty()
                && config.keys.len() <= 16
                && config.keys.iter().all(|key| {
                    column(first, &key.left).is_some() && column(second, &key.right).is_some()
                })
                && first
                    .iter()
                    .chain(second)
                    .map(|column| column.name.as_str())
                    .collect::<HashSet<_>>()
                    .len()
                    == first.len() + second.len()
                && output == [first, second].concat()
        }
        (AnalysisTransformOperation::Window, TransformConfig::Window(config)) => {
            inherited_schema(first, output)
                && column(first, &config.order_by).is_some()
                && config
                    .partition_by
                    .iter()
                    .all(|name| column(first, name).is_some())
                && !config.measures.is_empty()
                && config.measures.len() <= 32
                && config.measures.iter().all(|measure| {
                    measure
                        .column
                        .as_deref()
                        .is_none_or(|name| column(first, name).is_some())
                        && column(output, &measure.output).is_some()
                        && (!matches!(
                            measure.function,
                            WindowFunction::RunningSum | WindowFunction::RunningAvg
                        ) || measure.column.as_deref().is_some_and(|name| {
                            column(first, name).is_some_and(|column| {
                                matches!(
                                    column.column_type,
                                    AnalysisColumnType::Number
                                        | AnalysisColumnType::Duration
                                        | AnalysisColumnType::Currency
                                        | AnalysisColumnType::Percent
                                )
                            })
                        }))
                })
        }
        (AnalysisTransformOperation::Lag, TransformConfig::Lag(config)) => {
            inherited_schema(first, output)
                && (1..=1_000).contains(&config.offset)
                && column(first, &config.column).is_some()
                && column(first, &config.order_by).is_some()
                && config
                    .partition_by
                    .iter()
                    .all(|name| column(first, name).is_some())
                && column(output, &config.output).is_some()
        }
        (
            AnalysisTransformOperation::Ratio
            | AnalysisTransformOperation::Difference
            | AnalysisTransformOperation::Rate,
            TransformConfig::Arithmetic(config),
        ) => {
            inherited_schema(first, output)
                && column(first, &config.numerator).is_some()
                && column(first, &config.denominator).is_some()
                && column(output, &config.output).is_some()
        }
        (AnalysisTransformOperation::Cohort, TransformConfig::Cohort(config)) => {
            inherited_schema(first, output)
                && column(first, &config.entity_column).is_some()
                && column(first, &config.event_time_column).is_some()
                && column(output, &config.output).is_some()
        }
        (AnalysisTransformOperation::Retention, TransformConfig::Retention(config)) => {
            inherited_schema(first, output)
                && (1..=365).contains(&config.periods)
                && column(first, &config.entity_column).is_some()
                && column(first, &config.cohort_column).is_some()
                && column(first, &config.event_time_column).is_some()
                && column(output, &config.output).is_some()
        }
        _ => false,
    };
    if !valid {
        return Err(AppError::Config(
            "Analysis Article transform schema does not match its operation".into(),
        ));
    }
    Ok(())
}

fn parameter_tokens(sql: &str) -> Option<Vec<String>> {
    let mut tokens = Vec::new();
    let mut rest = sql;
    while let Some(start) = rest.find("{{") {
        let after = &rest[start + 2..];
        let end = after.find("}}")?;
        let token = &after[..end];
        if !valid_id(token) {
            return None;
        }
        tokens.push(token.to_owned());
        rest = &after[end + 2..];
    }
    (!rest.contains("}}") && !sql.contains('\0')).then_some(tokens)
}

fn validate_refresh(definition: &AnalysisArticleDefinition) -> AppResult<()> {
    let refresh = &definition.refresh;
    let valid = safe_text(&refresh.timezone, 128, false)
        && (60..=31_622_400).contains(&refresh.max_staleness_seconds)
        && (1..=365).contains(&refresh.result_retention_days)
        && match refresh.mode {
            AnalysisRefreshMode::Manual => refresh.cron.is_none() && refresh.runner_id.is_none(),
            AnalysisRefreshMode::Scheduled => {
                refresh.cron.as_deref().is_some_and(|cron| {
                    safe_text(cron, 128, false)
                        && cron.split_whitespace().count() == 5
                        && cron.chars().all(|character| {
                            character.is_ascii_digit()
                                || character.is_ascii_whitespace()
                                || matches!(character, '*' | '/' | '?' | ',' | '-')
                        })
                }) && refresh.runner_id.is_some()
            }
        };
    if !valid {
        return Err(AppError::Config(
            "invalid Analysis Article refresh policy".into(),
        ));
    }
    Ok(())
}

pub(crate) fn validate_definition(
    definition: &AnalysisArticleDefinition,
    connections: &[AnalysisArticleConnection],
    supplied_parameters: &BTreeMap<String, Value>,
) -> AppResult<BTreeMap<String, Value>> {
    if definition.version != 1
        || !safe_text(&definition.title, 160, false)
        || !safe_text(&definition.question, 8_000, true)
        || !safe_text(&definition.summary, 20_000, true)
        || !safe_text(&definition.timezone, 128, false)
        || connections.is_empty()
        || connections.len() > 32
        || definition.parameters.len() > 32
        || definition.queries.is_empty()
        || definition.queries.len() > 64
        || definition.transforms.len() > 128
        || definition.metrics.len() > 128
        || definition.blocks.is_empty()
        || definition.blocks.len() > 128
        || definition.claims.len() > 128
        || definition.warnings.len() > 64
    {
        return Err(AppError::Config(
            "invalid Analysis Article definition bounds".into(),
        ));
    }

    let mut connection_ids = HashSet::new();
    let mut roles = HashSet::new();
    for connection in connections {
        if connection.connection_revision < 1
            || !valid_id(&connection.role)
            || !safe_text(&connection.alias, 128, false)
            || !connection_ids.insert(connection.connection_id)
            || !roles.insert(connection.role.as_str())
        {
            return Err(AppError::Config(
                "invalid or duplicate Analysis Article connection authority".into(),
            ));
        }
    }

    let mut parameters = BTreeMap::new();
    let mut parameter_ids = HashSet::new();
    for parameter in &definition.parameters {
        if !valid_id(&parameter.id)
            || !safe_text(&parameter.label, 128, false)
            || !parameter_ids.insert(parameter.id.as_str())
            || parameter.options.len() > 100
            || parameter
                .options
                .iter()
                .any(|option| !safe_text(option, 256, false))
            || parameter.options.iter().collect::<HashSet<_>>().len() != parameter.options.len()
            || ((parameter.parameter_type == AnalysisParameterType::Enum)
                != !parameter.options.is_empty())
            || !parameter_value_is_valid(parameter, &parameter.default_value)
        {
            return Err(AppError::Config(
                "invalid Analysis Article parameter definition".into(),
            ));
        }
        let value = supplied_parameters
            .get(&parameter.id)
            .unwrap_or(&parameter.default_value);
        if !parameter_value_is_valid(parameter, value) {
            return Err(AppError::Config(format!(
                "invalid Analysis Article parameter: {}",
                parameter.label
            )));
        }
        parameters.insert(parameter.id.clone(), value.clone());
    }
    if supplied_parameters
        .keys()
        .any(|id| !parameter_ids.contains(id.as_str()))
    {
        return Err(AppError::Config(
            "unknown Analysis Article parameter".into(),
        ));
    }

    let mut schemas = HashMap::<String, Vec<AnalysisColumn>>::new();
    let mut node_roles = HashMap::<String, HashSet<String>>::new();
    for query in &definition.queries {
        let tokens = parameter_tokens(&query.sql)
            .ok_or_else(|| AppError::Config("invalid Analysis Article parameter token".into()))?;
        let unique_tokens = tokens.iter().collect::<HashSet<_>>();
        if !valid_id(&query.id)
            || !safe_text(&query.title, 256, false)
            || !roles.contains(query.connection_role.as_str())
            || query.sql.trim().is_empty()
            || query.sql.len() > 100_000
            || query.parameter_ids.len() > 32
            || query.parameter_ids.iter().collect::<HashSet<_>>().len() != query.parameter_ids.len()
            || tokens.len() != unique_tokens.len()
            || unique_tokens.len() != query.parameter_ids.len()
            || query
                .parameter_ids
                .iter()
                .any(|id| !parameter_ids.contains(id.as_str()) || !unique_tokens.contains(id))
            || !(1..=50_000).contains(&query.max_rows)
            || !(1_024..=MAX_ARTICLE_RESULT_BYTES).contains(&query.max_bytes)
            || query.cache_ttl_seconds > 7 * 24 * 60 * 60
            || schemas.contains_key(&query.id)
        {
            return Err(AppError::Config(
                "invalid Analysis Article query node".into(),
            ));
        }
        validate_columns(&query.columns)?;
        schemas.insert(query.id.clone(), query.columns.clone());
        node_roles.insert(
            query.id.clone(),
            HashSet::from([query.connection_role.clone()]),
        );
    }

    for transform in &definition.transforms {
        let expected_arity = if matches!(
            transform.operation,
            AnalysisTransformOperation::InnerJoin
                | AnalysisTransformOperation::LeftJoin
                | AnalysisTransformOperation::Union
        ) {
            2
        } else {
            1
        };
        if !valid_id(&transform.id)
            || !safe_text(&transform.title, 256, false)
            || schemas.contains_key(&transform.id)
            || transform.input_node_ids.len() != expected_arity
            || transform
                .input_node_ids
                .iter()
                .collect::<HashSet<_>>()
                .len()
                != transform.input_node_ids.len()
            || transform
                .input_node_ids
                .iter()
                .any(|input| !schemas.contains_key(input))
        {
            return Err(AppError::Config(
                "Analysis Article transforms must be topologically ordered".into(),
            ));
        }
        validate_columns(&transform.columns)?;
        let config = parse_transform_config(transform.operation, &transform.config)?;
        let inputs = transform
            .input_node_ids
            .iter()
            .map(|id| {
                schemas
                    .get(id)
                    .map(Vec::as_slice)
                    .expect("checked input node")
            })
            .collect::<Vec<_>>();
        validate_transform_schema(transform.operation, &config, &inputs, &transform.columns)?;
        let roles = transform
            .input_node_ids
            .iter()
            .flat_map(|id| node_roles.get(id).into_iter().flatten().cloned())
            .collect::<HashSet<_>>();
        if roles.len() > 1
            && !matches!(
                transform.operation,
                AnalysisTransformOperation::InnerJoin
                    | AnalysisTransformOperation::LeftJoin
                    | AnalysisTransformOperation::Union
            )
        {
            return Err(AppError::Blocked {
                reason: "cross-connection data may only meet in an approved join or union".into(),
            });
        }
        schemas.insert(transform.id.clone(), transform.columns.clone());
        node_roles.insert(transform.id.clone(), roles);
    }

    let mut metric_ids = HashSet::new();
    for metric in &definition.metrics {
        let value_column = schemas
            .get(&metric.source_node_id)
            .and_then(|columns| column(columns, &metric.value_column));
        if !valid_id(&metric.id)
            || !metric_ids.insert(metric.id.as_str())
            || !safe_text(&metric.label, 256, false)
            || !safe_text(&metric.description, 4_000, true)
            || !safe_text(&metric.unit, 64, true)
            || value_column.is_none_or(|column| {
                column.role != AnalysisColumnRole::Measure
                    || !matches!(
                        column.column_type,
                        AnalysisColumnType::Number
                            | AnalysisColumnType::Duration
                            | AnalysisColumnType::Currency
                            | AnalysisColumnType::Percent
                    )
            })
            || metric.format.decimals > 8
            || ((metric.format.style == AnalysisNumberStyle::Currency)
                != metric.format.currency.as_deref().is_some_and(|currency| {
                    currency.len() == 3
                        && currency
                            .chars()
                            .all(|character| character.is_ascii_uppercase())
                }))
        {
            return Err(AppError::Config("invalid Analysis Article metric".into()));
        }
    }

    let mut block_ids = HashSet::new();
    for block in &definition.blocks {
        let requires_source = matches!(
            block.kind,
            AnalysisBlockKind::Metric
                | AnalysisBlockKind::TimeSeries
                | AnalysisBlockKind::Bar
                | AnalysisBlockKind::Area
                | AnalysisBlockKind::Scatter
                | AnalysisBlockKind::Table
                | AnalysisBlockKind::Funnel
                | AnalysisBlockKind::RetentionCohort
                | AnalysisBlockKind::Heatmap
        );
        if !valid_id(&block.id)
            || !block_ids.insert(block.id.as_str())
            || !safe_text(&block.title, 256, true)
            || !(1..=12).contains(&block.width)
            || requires_source != block.source_node_id.is_some()
        {
            return Err(AppError::Config("invalid Analysis Article block".into()));
        }
        let config = validate_block_config(block.kind, &block.config)?;
        let source_columns = block
            .source_node_id
            .as_ref()
            .and_then(|source| schemas.get(source));
        if requires_source && source_columns.is_none() {
            return Err(AppError::Config(
                "Analysis Article block references an unknown node".into(),
            ));
        }
        let required_columns: &[String] = match &config {
            BlockColumnConfig::Metric { columns, .. } | BlockColumnConfig::Data(columns) => columns,
            BlockColumnConfig::None | BlockColumnConfig::Control(_) => &[],
        };
        if required_columns
            .iter()
            .any(|name| source_columns.is_none_or(|columns| column(columns, name).is_none()))
        {
            return Err(AppError::Config(
                "Analysis Article block references an unknown column".into(),
            ));
        }
        if block.kind == AnalysisBlockKind::Metric {
            let metric_id = match &config {
                BlockColumnConfig::Metric { metric_id, .. } => metric_id.as_str(),
                _ => "",
            };
            if !definition.metrics.iter().any(|metric| {
                metric.id == metric_id
                    && Some(&metric.source_node_id) == block.source_node_id.as_ref()
            }) {
                return Err(AppError::Config(
                    "Analysis Article metric block references an incompatible metric".into(),
                ));
            }
        }
        if let BlockColumnConfig::Control(control_parameter_ids) = config {
            if control_parameter_ids
                .iter()
                .any(|id| !parameters.contains_key(id))
            {
                return Err(AppError::Config(
                    "Analysis Article control references an unknown parameter".into(),
                ));
            }
        }
    }

    let node_ids = schemas.keys().map(String::as_str).collect::<HashSet<_>>();
    let mut claim_ids = HashSet::new();
    for claim in &definition.claims {
        if !valid_id(&claim.id)
            || !claim_ids.insert(claim.id.as_str())
            || !safe_text(&claim.text, 8_000, false)
            || (claim.block_ids.is_empty() && claim.node_ids.is_empty())
            || claim.block_ids.len() > 64
            || claim.node_ids.len() > 64
            || claim
                .block_ids
                .iter()
                .any(|id| !block_ids.contains(id.as_str()))
            || claim
                .node_ids
                .iter()
                .any(|id| !node_ids.contains(id.as_str()))
        {
            return Err(AppError::Config(
                "invalid Analysis Article evidence claim".into(),
            ));
        }
    }
    if definition
        .warnings
        .iter()
        .any(|warning| !safe_text(warning, 2_000, false))
    {
        return Err(AppError::Config("invalid Analysis Article warning".into()));
    }
    validate_refresh(definition)?;
    Ok(parameters)
}
