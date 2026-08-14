//! Rust-side checks for the cross-runtime safety and authority invariants in an
//! Analysis Article create request.
//!
//! Workspace Cloud remains the authoritative parser for schedule semantics and
//! transform/block configuration policy. This module intentionally does not
//! duplicate those feature-owned parsers.

use std::collections::{HashMap, HashSet};
use std::hash::Hash;

use serde_json::Value;
use uuid::{Uuid, Variant};

use crate::{
    AnalysisArticleConnection, AnalysisArticleDefinition, AnalysisBlock, AnalysisBlockKind,
    AnalysisColumn, AnalysisColumnMasking, AnalysisColumnRole, AnalysisColumnSensitivity,
    AnalysisColumnType, AnalysisNumberFormat, AnalysisNumberStyle, AnalysisParameter,
    AnalysisParameterType, AnalysisRefreshMode, AnalysisTransformOperation,
    SharedAnalysisArticleCreate,
};

const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const MAX_ARTICLE_RESULT_BYTES: usize = 16 * 1024 * 1024;

pub(crate) fn shared_create_is_valid(article: &SharedAnalysisArticleCreate) -> bool {
    contract_uuid(&article.id)
        && contract_uuid(&article.project_environment_id)
        && (1..=MAX_SAFE_INTEGER).contains(&article.environment_revision)
        && article
            .source_knowledge_grant_id
            .as_ref()
            .is_none_or(contract_uuid)
        && article.graph_revision_ids.len() <= 32
        && article.graph_revision_ids.iter().all(contract_uuid)
        && unique(article.graph_revision_ids.iter())
        && (article.source_knowledge_grant_id.is_none() == article.graph_revision_ids.is_empty())
        && validate_connections(&article.connections)
        && validate_definition(&article.definition, &article.connections)
}

fn contract_uuid(value: &Uuid) -> bool {
    value.get_variant() == Variant::RFC4122 && (1..=8).contains(&value.get_version_num())
}

fn contract_uuid_text(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && [8, 13, 18, 23].iter().all(|index| bytes[*index] == b'-')
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| [8, 13, 18, 23].contains(&index) || byte.is_ascii_hexdigit())
        && matches!(bytes[14], b'1'..=b'8')
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'A' | b'b' | b'B')
        && Uuid::parse_str(value).is_ok()
}

fn unique<T, I>(values: I) -> bool
where
    T: Eq + Hash,
    I: IntoIterator<Item = T>,
{
    let mut seen = HashSet::new();
    values.into_iter().all(|value| seen.insert(value))
}

fn valid_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_alphabetic()
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn display_text(value: &str, maximum: usize, allow_empty: bool) -> bool {
    (allow_empty || !value.trim_matches(js_trim_character).is_empty())
        && value.chars().count() <= maximum
        && !value.chars().any(|character| {
            matches!(
                character,
                '\u{0000}'..='\u{0008}'
                    | '\u{000b}'
                    | '\u{000c}'
                    | '\u{000e}'..='\u{001f}'
                    | '\u{007f}'
                    | '\u{202a}'..='\u{202e}'
                    | '\u{2066}'..='\u{2069}'
            )
        })
}

fn js_trim_character(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'..='\u{000d}'
            | '\u{0020}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

fn validate_connections(connections: &[AnalysisArticleConnection]) -> bool {
    !connections.is_empty()
        && connections.len() <= 32
        && connections.iter().all(|connection| {
            contract_uuid(&connection.connection_id)
                && (1..=MAX_SAFE_INTEGER).contains(&connection.connection_revision)
                && valid_id(&connection.role)
                && display_text(&connection.alias, 128, false)
        })
        && unique(
            connections
                .iter()
                .map(|connection| &connection.connection_id),
        )
        && unique(connections.iter().map(|connection| &connection.role))
}

fn parameter_value_is_valid(parameter: &AnalysisParameter, value: &Value) -> bool {
    if value.is_null() {
        return true;
    }
    match parameter.parameter_type {
        AnalysisParameterType::Boolean => value.is_boolean(),
        AnalysisParameterType::Number => value.as_f64().is_some_and(f64::is_finite),
        AnalysisParameterType::Enum => value.as_str().is_some_and(|value| {
            contract_parameter_string(value)
                && parameter.options.iter().any(|option| option == value)
        }),
        AnalysisParameterType::String
        | AnalysisParameterType::Date
        | AnalysisParameterType::Datetime => value.as_str().is_some_and(contract_parameter_string),
    }
}

fn contract_parameter_string(value: &str) -> bool {
    value.encode_utf16().count() <= 4_000 && !value.contains('\0')
}

fn validate_parameter(parameter: &AnalysisParameter) -> bool {
    valid_id(&parameter.id)
        && display_text(&parameter.label, 128, false)
        && parameter.options.len() <= 100
        && parameter
            .options
            .iter()
            .all(|option| display_text(option, 256, false))
        && unique(parameter.options.iter())
        && ((parameter.parameter_type == AnalysisParameterType::Enum)
            == !parameter.options.is_empty())
        && parameter_value_is_valid(parameter, &parameter.default_value)
        && (!parameter.required || !parameter.default_value.is_null())
}

fn validate_column(column: &AnalysisColumn) -> bool {
    display_text(&column.name, 256, false)
        && !(column.role == AnalysisColumnRole::Identifier
            && !matches!(
                column.masking,
                AnalysisColumnMasking::Hash | AnalysisColumnMasking::Redact
            ))
        && !(column.role == AnalysisColumnRole::FreeText
            && column.masking != AnalysisColumnMasking::Redact)
        && !(column.sensitivity == AnalysisColumnSensitivity::Restricted
            && column.masking != AnalysisColumnMasking::Redact)
        && !(column.sensitivity == AnalysisColumnSensitivity::Confidential
            && column.masking == AnalysisColumnMasking::None)
        && !(column.masking == AnalysisColumnMasking::Bucket
            && column.sensitivity != AnalysisColumnSensitivity::Public)
        && !(column.masking == AnalysisColumnMasking::Hash
            && column.column_type != AnalysisColumnType::String)
}

fn validate_columns(columns: &[AnalysisColumn]) -> bool {
    !columns.is_empty()
        && columns.len() <= 256
        && columns.iter().all(validate_column)
        && unique(columns.iter().map(|column| &column.name))
}

fn parameter_tokens(sql: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut rest = sql;
    while let Some(start) = rest.find("{{") {
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            break;
        };
        let token = &after[..end];
        if valid_id(token) {
            tokens.push(token.to_owned());
            rest = &after[end + 2..];
        } else {
            // Match the Cloud regex search semantics: an invalid outer token
            // must not hide a later valid `{{token}}` nested inside its text.
            rest = after;
        }
    }
    tokens
}

fn validate_query(
    query: &crate::AnalysisQueryNode,
    parameter_ids: &HashSet<&str>,
    connection_roles: &HashSet<&str>,
) -> bool {
    let tokens = parameter_tokens(&query.sql);
    valid_id(&query.id)
        && display_text(&query.title, 256, false)
        && connection_roles.contains(query.connection_role.as_str())
        && !query.sql.trim().is_empty()
        && query.sql.len() <= 100_000
        && !query.sql.contains('\0')
        && crate::analysis_article_sql::read_only_sql(&query.sql)
        && query.parameter_ids.len() <= 32
        && query
            .parameter_ids
            .iter()
            .all(|id| valid_id(id) && parameter_ids.contains(id.as_str()))
        && unique(query.parameter_ids.iter())
        && unique(tokens.iter())
        && tokens.len() == query.parameter_ids.len()
        && query
            .parameter_ids
            .iter()
            .all(|id| tokens.iter().any(|token| token == id))
        && (1..=50_000).contains(&query.max_rows)
        && (1_024..=MAX_ARTICLE_RESULT_BYTES).contains(&query.max_bytes)
        && query.cache_ttl_seconds <= 7 * 24 * 60 * 60
        && validate_columns(&query.columns)
}

fn numeric_measure(column: &AnalysisColumn) -> bool {
    column.role == AnalysisColumnRole::Measure
        && matches!(
            column.column_type,
            AnalysisColumnType::Number
                | AnalysisColumnType::Duration
                | AnalysisColumnType::Currency
                | AnalysisColumnType::Percent
        )
}

fn validate_number_format(format: &AnalysisNumberFormat) -> bool {
    let valid_currency = format.currency.as_deref().is_some_and(|currency| {
        currency.len() == 3 && currency.bytes().all(|byte| byte.is_ascii_uppercase())
    });
    format.decimals <= 8 && ((format.style == AnalysisNumberStyle::Currency) == valid_currency)
}

fn source_required(kind: AnalysisBlockKind) -> bool {
    matches!(
        kind,
        AnalysisBlockKind::Metric
            | AnalysisBlockKind::TimeSeries
            | AnalysisBlockKind::Bar
            | AnalysisBlockKind::Area
            | AnalysisBlockKind::Scatter
            | AnalysisBlockKind::Table
            | AnalysisBlockKind::Funnel
            | AnalysisBlockKind::RetentionCohort
            | AnalysisBlockKind::Heatmap
    )
}

fn metric_id(block: &AnalysisBlock) -> Option<&str> {
    (block.kind == AnalysisBlockKind::Metric)
        .then(|| block.config.get("metricId")?.as_str())
        .flatten()
}

fn control_parameter_ids(block: &AnalysisBlock) -> Option<Vec<&str>> {
    matches!(
        block.kind,
        AnalysisBlockKind::DateRangeControl
            | AnalysisBlockKind::ComparisonControl
            | AnalysisBlockKind::SegmentControl
    )
    .then(|| {
        block
            .config
            .get("parameterIds")?
            .as_array()?
            .iter()
            .map(Value::as_str)
            .collect()
    })
    .flatten()
}

fn validate_definition(
    definition: &AnalysisArticleDefinition,
    connections: &[AnalysisArticleConnection],
) -> bool {
    if definition.version != 1
        || !display_text(&definition.title, 160, false)
        || !display_text(&definition.question, 8_000, true)
        || !display_text(&definition.summary, 20_000, true)
        || !display_text(&definition.timezone, 128, false)
        || definition.parameters.len() > 32
        || definition.queries.is_empty()
        || definition.queries.len() > 64
        || definition.transforms.len() > 128
        || definition.metrics.len() > 128
        || definition.blocks.is_empty()
        || definition.blocks.len() > 128
        || definition.claims.len() > 128
        || definition.warnings.len() > 64
        || !definition.parameters.iter().all(validate_parameter)
        || !unique(definition.parameters.iter().map(|parameter| &parameter.id))
    {
        return false;
    }

    let parameter_ids = definition
        .parameters
        .iter()
        .map(|parameter| parameter.id.as_str())
        .collect::<HashSet<_>>();
    let connection_roles = connections
        .iter()
        .map(|connection| connection.role.as_str())
        .collect::<HashSet<_>>();
    if !definition
        .queries
        .iter()
        .all(|query| validate_query(query, &parameter_ids, &connection_roles))
    {
        return false;
    }

    let mut schemas = HashMap::<&str, &[AnalysisColumn]>::new();
    let mut roles = HashMap::<&str, HashSet<&str>>::new();
    for query in &definition.queries {
        if schemas.insert(&query.id, &query.columns).is_some() {
            return false;
        }
        roles.insert(&query.id, HashSet::from([query.connection_role.as_str()]));
    }
    for transform in &definition.transforms {
        let combines_sources = matches!(
            transform.operation,
            AnalysisTransformOperation::InnerJoin
                | AnalysisTransformOperation::LeftJoin
                | AnalysisTransformOperation::Union
        );
        let arity = if combines_sources { 2 } else { 1 };
        if !valid_id(&transform.id)
            || !display_text(&transform.title, 256, false)
            || schemas.contains_key(transform.id.as_str())
            || transform.input_node_ids.len() != arity
            || !unique(transform.input_node_ids.iter())
            || transform
                .input_node_ids
                .iter()
                .any(|input| !schemas.contains_key(input.as_str()))
            || !validate_columns(&transform.columns)
            || (combines_sources
                && !transform
                    .config
                    .get("mappingProposalId")
                    .and_then(Value::as_str)
                    .is_some_and(contract_uuid_text))
        {
            return false;
        }
        let source_roles = transform
            .input_node_ids
            .iter()
            .flat_map(|input| roles[input.as_str()].iter().copied())
            .collect::<HashSet<_>>();
        if source_roles.len() > 1 && !combines_sources {
            return false;
        }
        schemas.insert(&transform.id, &transform.columns);
        roles.insert(&transform.id, source_roles);
    }

    if !unique(definition.metrics.iter().map(|metric| &metric.id))
        || definition.metrics.iter().any(|metric| {
            !valid_id(&metric.id)
                || !display_text(&metric.label, 256, false)
                || !display_text(&metric.description, 4_000, true)
                || !display_text(&metric.value_column, 256, false)
                || !display_text(&metric.unit, 64, true)
                || !validate_number_format(&metric.format)
                || schemas
                    .get(metric.source_node_id.as_str())
                    .and_then(|columns| {
                        columns
                            .iter()
                            .find(|column| column.name == metric.value_column)
                    })
                    .is_none_or(|column| !numeric_measure(column))
        })
    {
        return false;
    }

    let mut block_ids = HashSet::new();
    for block in &definition.blocks {
        if !valid_id(&block.id)
            || !block_ids.insert(block.id.as_str())
            || !display_text(&block.title, 256, true)
            || !(1..=12).contains(&block.width)
            || source_required(block.kind) != block.source_node_id.is_some()
            || block
                .source_node_id
                .as_deref()
                .is_some_and(|source| !schemas.contains_key(source))
        {
            return false;
        }
        if block.kind == AnalysisBlockKind::Metric
            && metric_id(block).is_none_or(|metric_id| {
                !definition.metrics.iter().any(|metric| {
                    metric.id == metric_id
                        && block.source_node_id.as_deref() == Some(metric.source_node_id.as_str())
                })
            })
        {
            return false;
        }
        if matches!(
            block.kind,
            AnalysisBlockKind::DateRangeControl
                | AnalysisBlockKind::ComparisonControl
                | AnalysisBlockKind::SegmentControl
        ) && control_parameter_ids(block)
            .is_none_or(|ids| ids.iter().any(|id| !parameter_ids.contains(id)))
        {
            return false;
        }
    }

    let node_ids = schemas.keys().copied().collect::<HashSet<_>>();
    if !unique(definition.claims.iter().map(|claim| &claim.id))
        || definition.claims.iter().any(|claim| {
            !valid_id(&claim.id)
                || !display_text(&claim.text, 8_000, false)
                || (claim.block_ids.is_empty() && claim.node_ids.is_empty())
                || claim.block_ids.len() > 64
                || claim.node_ids.len() > 64
                || !unique(claim.block_ids.iter())
                || !unique(claim.node_ids.iter())
                || claim
                    .block_ids
                    .iter()
                    .any(|id| !block_ids.contains(id.as_str()))
                || claim
                    .node_ids
                    .iter()
                    .any(|id| !node_ids.contains(id.as_str()))
        })
        || definition
            .warnings
            .iter()
            .any(|warning| !display_text(warning, 2_000, false))
    {
        return false;
    }

    let refresh = &definition.refresh;
    display_text(&refresh.timezone, 128, false)
        && (60..=31_622_400).contains(&refresh.max_staleness_seconds)
        && (1..=365).contains(&refresh.result_retention_days)
        && refresh.runner_id.as_ref().is_none_or(contract_uuid)
        && match refresh.mode {
            AnalysisRefreshMode::Manual => refresh.cron.is_none() && refresh.runner_id.is_none(),
            AnalysisRefreshMode::Scheduled => {
                refresh
                    .cron
                    .as_deref()
                    .is_some_and(|cron| display_text(cron, 128, false))
                    && refresh.runner_id.is_some()
            }
        }
}
