//! Strict typed views of declarative transform and block configuration JSON.
//! Unknown keys fail closed so a newer cloud definition cannot silently execute
//! with older Desktop semantics.

use dopedb_protocol::{
    AnalysisBlockKind, AnalysisNumberFormat, AnalysisNumberStyle, AnalysisTransformOperation,
};
use serde::Deserialize;
use serde_json::Value;

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProjectConfig {
    pub(crate) columns: Vec<String>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum FilterOperator {
    Eq,
    Neq,
    Gt,
    Gte,
    Lt,
    Lte,
    Contains,
    In,
    IsNull,
    NotNull,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct FilterConfig {
    pub(crate) column: String,
    pub(crate) operator: FilterOperator,
    pub(crate) value: Value,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SortDirection {
    Asc,
    Desc,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SortColumn {
    pub(crate) column: String,
    pub(crate) direction: SortDirection,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SortConfig {
    pub(crate) columns: Vec<SortColumn>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct LimitConfig {
    pub(crate) count: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UnionConfig {
    pub(crate) all: bool,
    pub(crate) mapping_proposal_id: uuid::Uuid,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AggregateFunction {
    Count,
    CountDistinct,
    Sum,
    Avg,
    Min,
    Max,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AggregateMeasure {
    pub(crate) column: String,
    pub(crate) function: AggregateFunction,
    #[serde(rename = "as")]
    pub(crate) output: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AggregateConfig {
    pub(crate) group_by: Vec<String>,
    pub(crate) measures: Vec<AggregateMeasure>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct JoinKey {
    pub(crate) left: String,
    pub(crate) right: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct JoinConfig {
    pub(crate) mapping_proposal_id: uuid::Uuid,
    pub(crate) keys: Vec<JoinKey>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum WindowFunction {
    RowNumber,
    Rank,
    DenseRank,
    RunningSum,
    RunningAvg,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct WindowMeasure {
    pub(crate) column: Option<String>,
    pub(crate) function: WindowFunction,
    #[serde(rename = "as")]
    pub(crate) output: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WindowConfig {
    pub(crate) partition_by: Vec<String>,
    pub(crate) order_by: String,
    pub(crate) measures: Vec<WindowMeasure>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LagConfig {
    pub(crate) column: String,
    pub(crate) offset: usize,
    pub(crate) partition_by: Vec<String>,
    pub(crate) order_by: String,
    #[serde(rename = "as")]
    pub(crate) output: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ArithmeticConfig {
    pub(crate) numerator: String,
    pub(crate) denominator: String,
    #[serde(rename = "as")]
    pub(crate) output: String,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PeriodUnit {
    Day,
    Week,
    Month,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CohortConfig {
    pub(crate) entity_column: String,
    pub(crate) event_time_column: String,
    pub(crate) cohort_unit: PeriodUnit,
    #[serde(rename = "as")]
    pub(crate) output: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RetentionConfig {
    pub(crate) entity_column: String,
    pub(crate) cohort_column: String,
    pub(crate) event_time_column: String,
    pub(crate) period_unit: PeriodUnit,
    pub(crate) periods: usize,
    #[serde(rename = "as")]
    pub(crate) output: String,
}

#[derive(Debug, Clone)]
pub(crate) enum TransformConfig {
    Project(ProjectConfig),
    Filter(FilterConfig),
    Sort(SortConfig),
    Limit(LimitConfig),
    Union(UnionConfig),
    Group(ProjectConfig),
    Aggregate(AggregateConfig),
    Join(JoinConfig),
    Window(WindowConfig),
    Lag(LagConfig),
    Arithmetic(ArithmeticConfig),
    Cohort(CohortConfig),
    Retention(RetentionConfig),
}

fn decode<T: for<'de> Deserialize<'de>>(value: &Value, label: &str) -> AppResult<T> {
    serde_json::from_value(value.clone())
        .map_err(|_| AppError::Config(format!("invalid Analysis Article {label} configuration")))
}

pub(crate) fn parse_transform_config(
    operation: AnalysisTransformOperation,
    value: &Value,
) -> AppResult<TransformConfig> {
    Ok(match operation {
        AnalysisTransformOperation::Project => TransformConfig::Project(decode(value, "project")?),
        AnalysisTransformOperation::Filter => TransformConfig::Filter(decode(value, "filter")?),
        AnalysisTransformOperation::Sort => TransformConfig::Sort(decode(value, "sort")?),
        AnalysisTransformOperation::Limit => TransformConfig::Limit(decode(value, "limit")?),
        AnalysisTransformOperation::Union => TransformConfig::Union(decode(value, "union")?),
        AnalysisTransformOperation::Group => TransformConfig::Group(decode(value, "group")?),
        AnalysisTransformOperation::Aggregate => {
            TransformConfig::Aggregate(decode(value, "aggregate")?)
        }
        AnalysisTransformOperation::InnerJoin | AnalysisTransformOperation::LeftJoin => {
            TransformConfig::Join(decode(value, "join")?)
        }
        AnalysisTransformOperation::Window => TransformConfig::Window(decode(value, "window")?),
        AnalysisTransformOperation::Lag => TransformConfig::Lag(decode(value, "lag")?),
        AnalysisTransformOperation::Ratio
        | AnalysisTransformOperation::Difference
        | AnalysisTransformOperation::Rate => {
            TransformConfig::Arithmetic(decode(value, "arithmetic")?)
        }
        AnalysisTransformOperation::Cohort => TransformConfig::Cohort(decode(value, "cohort")?),
        AnalysisTransformOperation::Retention => {
            TransformConfig::Retention(decode(value, "retention")?)
        }
    })
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct HeadingBlockConfig {
    level: u8,
    text: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct MarkdownBlockConfig {
    markdown: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CalloutBlockConfig {
    tone: String,
    markdown: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyBlockConfig {}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MetricBlockConfig {
    pub(crate) metric_id: String,
    pub(crate) comparison_column: Option<String>,
    pub(crate) sparkline_column: Option<String>,
    pub(crate) sample_count_column: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ChartBlockConfig {
    pub(crate) x_column: String,
    pub(crate) y_columns: Vec<String>,
    pub(crate) series_column: Option<String>,
    pub(crate) stacked: bool,
    pub(crate) format: dopedb_protocol::AnalysisNumberFormat,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TableBlockConfig {
    pub(crate) columns: Vec<String>,
    pub(crate) page_size: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FunnelBlockConfig {
    pub(crate) stage_column: String,
    pub(crate) value_column: String,
    pub(crate) rate_column: Option<String>,
    pub(crate) format: dopedb_protocol::AnalysisNumberFormat,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RetentionBlockConfig {
    pub(crate) cohort_column: String,
    pub(crate) period_column: String,
    pub(crate) value_column: String,
    pub(crate) format: dopedb_protocol::AnalysisNumberFormat,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HeatmapBlockConfig {
    pub(crate) x_column: String,
    pub(crate) y_column: String,
    pub(crate) value_column: String,
    pub(crate) format: dopedb_protocol::AnalysisNumberFormat,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ControlBlockConfig {
    pub(crate) parameter_ids: Vec<String>,
}

#[derive(Debug, Clone)]
pub(crate) enum BlockColumnConfig {
    None,
    Metric {
        metric_id: String,
        columns: Vec<String>,
    },
    Data(Vec<String>),
    Control(Vec<String>),
}

fn validate_format(format: &AnalysisNumberFormat) -> AppResult<()> {
    let currency_is_valid = format.currency.as_deref().is_some_and(|currency| {
        currency.len() == 3
            && currency
                .chars()
                .all(|character| character.is_ascii_uppercase())
    });
    if format.decimals > 8 || ((format.style == AnalysisNumberStyle::Currency) != currency_is_valid)
    {
        return Err(AppError::Config(
            "invalid Analysis Article number format".into(),
        ));
    }
    Ok(())
}

pub(crate) fn validate_block_config(
    kind: AnalysisBlockKind,
    value: &Value,
) -> AppResult<BlockColumnConfig> {
    Ok(match kind {
        AnalysisBlockKind::Heading => {
            let config: HeadingBlockConfig = decode(value, "heading block")?;
            if !(1..=3).contains(&config.level) || config.text.trim().is_empty() {
                return Err(AppError::Config(
                    "invalid Analysis Article heading block".into(),
                ));
            }
            BlockColumnConfig::None
        }
        AnalysisBlockKind::Markdown => {
            let config: MarkdownBlockConfig = decode(value, "Markdown block")?;
            if config.markdown.len() > 100_000 {
                return Err(AppError::Config(
                    "Analysis Article Markdown is too large".into(),
                ));
            }
            BlockColumnConfig::None
        }
        AnalysisBlockKind::Callout => {
            let config: CalloutBlockConfig = decode(value, "callout block")?;
            if !matches!(
                config.tone.as_str(),
                "info" | "success" | "warning" | "danger"
            ) || config.markdown.trim().is_empty()
            {
                return Err(AppError::Config(
                    "invalid Analysis Article callout block".into(),
                ));
            }
            BlockColumnConfig::None
        }
        AnalysisBlockKind::Divider => {
            let _: EmptyBlockConfig = decode(value, "divider block")?;
            BlockColumnConfig::None
        }
        AnalysisBlockKind::Metric => {
            let config: MetricBlockConfig = decode(value, "metric block")?;
            let mut columns = Vec::new();
            if let Some(column) = config.comparison_column {
                columns.push(column);
            }
            if let Some(column) = config.sparkline_column {
                columns.push(column);
            }
            if let Some(column) = config.sample_count_column {
                columns.push(column);
            }
            BlockColumnConfig::Metric {
                metric_id: config.metric_id,
                columns,
            }
        }
        AnalysisBlockKind::TimeSeries
        | AnalysisBlockKind::Bar
        | AnalysisBlockKind::Area
        | AnalysisBlockKind::Scatter => {
            let config: ChartBlockConfig = decode(value, "chart block")?;
            validate_format(&config.format)?;
            if config.y_columns.is_empty()
                || config.y_columns.len() > 12
                || (kind == AnalysisBlockKind::Scatter && config.stacked)
            {
                return Err(AppError::Config(
                    "invalid Analysis Article chart block".into(),
                ));
            }
            let mut columns = vec![config.x_column];
            columns.extend(config.y_columns);
            if let Some(column) = config.series_column {
                columns.push(column);
            }
            BlockColumnConfig::Data(columns)
        }
        AnalysisBlockKind::Table => {
            let config: TableBlockConfig = decode(value, "table block")?;
            if config.columns.is_empty()
                || config.columns.len() > 64
                || !(10..=500).contains(&config.page_size)
            {
                return Err(AppError::Config(
                    "invalid Analysis Article table block".into(),
                ));
            }
            BlockColumnConfig::Data(config.columns)
        }
        AnalysisBlockKind::Funnel => {
            let config: FunnelBlockConfig = decode(value, "funnel block")?;
            validate_format(&config.format)?;
            let mut columns = vec![config.stage_column, config.value_column];
            if let Some(column) = config.rate_column {
                columns.push(column);
            }
            BlockColumnConfig::Data(columns)
        }
        AnalysisBlockKind::RetentionCohort => {
            let config: RetentionBlockConfig = decode(value, "retention block")?;
            validate_format(&config.format)?;
            BlockColumnConfig::Data(vec![
                config.cohort_column,
                config.period_column,
                config.value_column,
            ])
        }
        AnalysisBlockKind::Heatmap => {
            let config: HeatmapBlockConfig = decode(value, "heatmap block")?;
            validate_format(&config.format)?;
            BlockColumnConfig::Data(vec![config.x_column, config.y_column, config.value_column])
        }
        AnalysisBlockKind::DateRangeControl
        | AnalysisBlockKind::ComparisonControl
        | AnalysisBlockKind::SegmentControl => {
            let config: ControlBlockConfig = decode(value, "control block")?;
            if config.parameter_ids.is_empty()
                || config.parameter_ids.len()
                    != if kind == AnalysisBlockKind::DateRangeControl {
                        2
                    } else {
                        1
                    }
            {
                return Err(AppError::Config(
                    "invalid Analysis Article control block".into(),
                ));
            }
            BlockColumnConfig::Control(config.parameter_ids)
        }
    })
}
