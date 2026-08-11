//! Deterministic in-process typed DAG transforms. Database reads never cross
//! connections inside SQL; approved join/union nodes combine already bounded
//! materialized data under the one Article run cancellation identity.

use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::{DateTime, Datelike, NaiveDate, NaiveDateTime, Utc, Weekday};
use dopedb_protocol::{AnalysisColumn, AnalysisTransformNode, AnalysisTransformOperation};
use serde_json::{Number, Value};

use crate::error::{AppError, AppResult};
use crate::executor::cancel::CancelHandle;

use super::config::{
    parse_transform_config, AggregateConfig, AggregateFunction, ArithmeticConfig, CohortConfig,
    FilterConfig, FilterOperator, JoinConfig, LagConfig, PeriodUnit, ProjectConfig, SortConfig,
    SortDirection, TransformConfig, WindowConfig, WindowFunction,
};
use super::domain::AnalysisDataSet;
use super::validation::max_article_result_bytes;

const MAX_ROWS: usize = 50_000;

fn cancelled(handle: &CancelHandle, index: usize) -> AppResult<()> {
    if index % 256 == 0 && handle.is_cancelled() {
        return Err(AppError::Safety("Analysis Article run cancelled".into()));
    }
    Ok(())
}

fn column_index(columns: &[AnalysisColumn], name: &str) -> AppResult<usize> {
    columns
        .iter()
        .position(|column| column.name == name)
        .ok_or_else(|| {
            AppError::Config(format!("Analysis Article column no longer exists: {name}"))
        })
}

fn canonical(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".into())
}

fn row_key(row: &[Value], indexes: &[usize]) -> String {
    let values = indexes
        .iter()
        .map(|index| row.get(*index).cloned().unwrap_or(Value::Null))
        .collect::<Vec<_>>();
    serde_json::to_string(&values).unwrap_or_else(|_| "[]".into())
}

fn value_number(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str()?.parse::<f64>().ok())
        .filter(|value| value.is_finite())
}

fn number(value: f64) -> Value {
    Number::from_f64(value)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

fn compare(left: &Value, right: &Value) -> Ordering {
    match (value_number(left), value_number(right)) {
        (Some(left), Some(right)) => left.partial_cmp(&right).unwrap_or(Ordering::Equal),
        _ => match (left.as_str(), right.as_str()) {
            (Some(left), Some(right)) => left.cmp(right),
            _ => match (left.as_bool(), right.as_bool()) {
                (Some(left), Some(right)) => left.cmp(&right),
                _ => canonical(left).cmp(&canonical(right)),
            },
        },
    }
}

fn project_row(
    input_columns: &[AnalysisColumn],
    row: &[Value],
    output_columns: &[AnalysisColumn],
    extras: &HashMap<String, Value>,
) -> Vec<Value> {
    output_columns
        .iter()
        .map(|column| {
            extras.get(&column.name).cloned().unwrap_or_else(|| {
                input_columns
                    .iter()
                    .position(|input| input.name == column.name)
                    .and_then(|index| row.get(index).cloned())
                    .unwrap_or(Value::Null)
            })
        })
        .collect()
}

fn enforce_bounds(mut data: AnalysisDataSet) -> AppResult<AnalysisDataSet> {
    if data.rows.len() > MAX_ROWS {
        data.rows.truncate(MAX_ROWS);
        data.truncated = true;
    }
    let mut retained = Vec::with_capacity(data.rows.len());
    let mut bytes = serde_json::to_vec(&data.columns)?.len();
    for row in data.rows {
        let encoded = serde_json::to_vec(&row)?.len();
        if bytes.saturating_add(encoded) > max_article_result_bytes() {
            data.truncated = true;
            break;
        }
        bytes += encoded;
        retained.push(row);
    }
    data.rows = retained;
    Ok(data)
}

fn project(
    input: &AnalysisDataSet,
    output: &[AnalysisColumn],
    config: &ProjectConfig,
    distinct: bool,
    cancellation: &CancelHandle,
) -> AppResult<AnalysisDataSet> {
    let indexes = config
        .columns
        .iter()
        .map(|name| column_index(&input.columns, name))
        .collect::<AppResult<Vec<_>>>()?;
    let mut seen = HashSet::new();
    let mut rows = Vec::with_capacity(input.rows.len());
    for (index, row) in input.rows.iter().enumerate() {
        cancelled(cancellation, index)?;
        let projected = indexes
            .iter()
            .map(|index| row.get(*index).cloned().unwrap_or(Value::Null))
            .collect::<Vec<_>>();
        if !distinct || seen.insert(serde_json::to_string(&projected)?) {
            rows.push(projected);
        }
    }
    enforce_bounds(AnalysisDataSet {
        columns: output.to_vec(),
        rows,
        truncated: input.truncated,
    })
}

fn filter_matches(value: &Value, config: &FilterConfig) -> bool {
    match config.operator {
        FilterOperator::Eq => value == &config.value,
        FilterOperator::Neq => value != &config.value,
        FilterOperator::Gt => compare(value, &config.value) == Ordering::Greater,
        FilterOperator::Gte => compare(value, &config.value) != Ordering::Less,
        FilterOperator::Lt => compare(value, &config.value) == Ordering::Less,
        FilterOperator::Lte => compare(value, &config.value) != Ordering::Greater,
        FilterOperator::Contains => match (value, &config.value) {
            (Value::String(value), Value::String(needle)) => value.contains(needle),
            (Value::Array(values), needle) => values.contains(needle),
            _ => false,
        },
        FilterOperator::In => config
            .value
            .as_array()
            .is_some_and(|values| values.contains(value)),
        FilterOperator::IsNull => value.is_null(),
        FilterOperator::NotNull => !value.is_null(),
    }
}

fn filter(
    input: &AnalysisDataSet,
    config: &FilterConfig,
    cancellation: &CancelHandle,
) -> AppResult<AnalysisDataSet> {
    let index = column_index(&input.columns, &config.column)?;
    let mut rows = Vec::new();
    for (ordinal, row) in input.rows.iter().enumerate() {
        cancelled(cancellation, ordinal)?;
        if row
            .get(index)
            .is_some_and(|value| filter_matches(value, config))
        {
            rows.push(row.clone());
        }
    }
    Ok(AnalysisDataSet {
        columns: input.columns.clone(),
        rows,
        truncated: input.truncated,
    })
}

fn sort(input: &AnalysisDataSet, config: &SortConfig) -> AppResult<AnalysisDataSet> {
    let indexes = config
        .columns
        .iter()
        .map(|column| {
            Ok((
                column_index(&input.columns, &column.column)?,
                column.direction,
            ))
        })
        .collect::<AppResult<Vec<_>>>()?;
    let mut rows = input.rows.clone();
    rows.sort_by(|left, right| {
        indexes
            .iter()
            .find_map(|(index, direction)| {
                let ordering = compare(
                    left.get(*index).unwrap_or(&Value::Null),
                    right.get(*index).unwrap_or(&Value::Null),
                );
                (ordering != Ordering::Equal).then_some(match direction {
                    SortDirection::Asc => ordering,
                    SortDirection::Desc => ordering.reverse(),
                })
            })
            .unwrap_or(Ordering::Equal)
    });
    Ok(AnalysisDataSet {
        columns: input.columns.clone(),
        rows,
        truncated: input.truncated,
    })
}

fn union(
    left: &AnalysisDataSet,
    right: &AnalysisDataSet,
    all: bool,
    cancellation: &CancelHandle,
) -> AppResult<AnalysisDataSet> {
    let mut rows = Vec::with_capacity((left.rows.len() + right.rows.len()).min(MAX_ROWS));
    let mut seen = HashSet::new();
    let mut truncated = left.truncated || right.truncated;
    for (index, row) in left.rows.iter().chain(&right.rows).enumerate() {
        cancelled(cancellation, index)?;
        if all || seen.insert(serde_json::to_string(row)?) {
            if rows.len() == MAX_ROWS {
                truncated = true;
                break;
            }
            rows.push(row.clone());
        }
    }
    enforce_bounds(AnalysisDataSet {
        columns: left.columns.clone(),
        rows,
        truncated,
    })
}

#[derive(Default)]
struct AggregateState {
    count: u64,
    distinct: HashSet<String>,
    sum: f64,
    numeric_count: u64,
    minimum: Option<Value>,
    maximum: Option<Value>,
}

fn aggregate(
    input: &AnalysisDataSet,
    output: &[AnalysisColumn],
    config: &AggregateConfig,
    cancellation: &CancelHandle,
) -> AppResult<AnalysisDataSet> {
    let group_indexes = config
        .group_by
        .iter()
        .map(|name| column_index(&input.columns, name))
        .collect::<AppResult<Vec<_>>>()?;
    let measure_indexes = config
        .measures
        .iter()
        .map(|measure| column_index(&input.columns, &measure.column))
        .collect::<AppResult<Vec<_>>>()?;
    let mut groups = BTreeMap::<String, (Vec<Value>, Vec<AggregateState>)>::new();
    for (ordinal, row) in input.rows.iter().enumerate() {
        cancelled(cancellation, ordinal)?;
        let group = group_indexes
            .iter()
            .map(|index| row.get(*index).cloned().unwrap_or(Value::Null))
            .collect::<Vec<_>>();
        let key = serde_json::to_string(&group)?;
        let entry = groups.entry(key).or_insert_with(|| {
            (
                group,
                (0..config.measures.len())
                    .map(|_| AggregateState::default())
                    .collect(),
            )
        });
        for (index, state) in entry.1.iter_mut().enumerate() {
            let value = row
                .get(measure_indexes[index])
                .cloned()
                .unwrap_or(Value::Null);
            state.count += 1;
            state.distinct.insert(canonical(&value));
            if let Some(value) = value_number(&value) {
                state.sum += value;
                state.numeric_count += 1;
            }
            if state
                .minimum
                .as_ref()
                .is_none_or(|minimum| compare(&value, minimum) == Ordering::Less)
            {
                state.minimum = Some(value.clone());
            }
            if state
                .maximum
                .as_ref()
                .is_none_or(|maximum| compare(&value, maximum) == Ordering::Greater)
            {
                state.maximum = Some(value);
            }
        }
        if groups.len() > MAX_ROWS {
            return Err(AppError::Blocked {
                reason: "Analysis Article aggregate exceeded 50,000 groups".into(),
            });
        }
    }
    let rows = groups
        .into_values()
        .map(|(mut group, states)| {
            for (measure, state) in config.measures.iter().zip(states) {
                group.push(match measure.function {
                    AggregateFunction::Count => Value::from(state.count),
                    AggregateFunction::CountDistinct => Value::from(state.distinct.len() as u64),
                    AggregateFunction::Sum => number(state.sum),
                    AggregateFunction::Avg => (state.numeric_count > 0)
                        .then(|| number(state.sum / state.numeric_count as f64))
                        .unwrap_or(Value::Null),
                    AggregateFunction::Min => state.minimum.unwrap_or(Value::Null),
                    AggregateFunction::Max => state.maximum.unwrap_or(Value::Null),
                });
            }
            group
        })
        .collect();
    enforce_bounds(AnalysisDataSet {
        columns: output.to_vec(),
        rows,
        truncated: input.truncated,
    })
}

fn join(
    left: &AnalysisDataSet,
    right: &AnalysisDataSet,
    config: &JoinConfig,
    left_join: bool,
    cancellation: &CancelHandle,
) -> AppResult<AnalysisDataSet> {
    let left_indexes = config
        .keys
        .iter()
        .map(|key| column_index(&left.columns, &key.left))
        .collect::<AppResult<Vec<_>>>()?;
    let right_indexes = config
        .keys
        .iter()
        .map(|key| column_index(&right.columns, &key.right))
        .collect::<AppResult<Vec<_>>>()?;
    let mut right_by_key = HashMap::<String, Vec<&Vec<Value>>>::new();
    for row in &right.rows {
        right_by_key
            .entry(row_key(row, &right_indexes))
            .or_default()
            .push(row);
    }
    let mut rows = Vec::new();
    let mut truncated = left.truncated || right.truncated;
    for (ordinal, left_row) in left.rows.iter().enumerate() {
        cancelled(cancellation, ordinal)?;
        let matches = right_by_key.get(&row_key(left_row, &left_indexes));
        if let Some(matches) = matches {
            for right_row in matches {
                if rows.len() == MAX_ROWS {
                    truncated = true;
                    break;
                }
                let mut row = left_row.clone();
                row.extend((*right_row).clone());
                rows.push(row);
            }
        } else if left_join {
            let mut row = left_row.clone();
            row.extend((0..right.columns.len()).map(|_| Value::Null));
            rows.push(row);
        }
        if rows.len() == MAX_ROWS {
            truncated = true;
            break;
        }
    }
    let mut columns = left.columns.clone();
    columns.extend(right.columns.clone());
    enforce_bounds(AnalysisDataSet {
        columns,
        rows,
        truncated,
    })
}

fn partitioned_order(
    input: &AnalysisDataSet,
    partition_names: &[String],
    order_name: &str,
) -> AppResult<Vec<Vec<usize>>> {
    let partitions = partition_names
        .iter()
        .map(|name| column_index(&input.columns, name))
        .collect::<AppResult<Vec<_>>>()?;
    let order = column_index(&input.columns, order_name)?;
    let mut groups = BTreeMap::<String, Vec<usize>>::new();
    for (index, row) in input.rows.iter().enumerate() {
        groups
            .entry(row_key(row, &partitions))
            .or_default()
            .push(index);
    }
    for indexes in groups.values_mut() {
        indexes.sort_by(|left, right| {
            compare(
                input.rows[*left].get(order).unwrap_or(&Value::Null),
                input.rows[*right].get(order).unwrap_or(&Value::Null),
            )
        });
    }
    Ok(groups.into_values().collect())
}

fn window(
    input: &AnalysisDataSet,
    output: &[AnalysisColumn],
    config: &WindowConfig,
    cancellation: &CancelHandle,
) -> AppResult<AnalysisDataSet> {
    let order = column_index(&input.columns, &config.order_by)?;
    let measure_indexes = config
        .measures
        .iter()
        .map(|measure| {
            measure
                .column
                .as_deref()
                .map(|name| column_index(&input.columns, name))
                .transpose()
        })
        .collect::<AppResult<Vec<_>>>()?;
    let mut rows = Vec::with_capacity(input.rows.len());
    for partition in partitioned_order(input, &config.partition_by, &config.order_by)? {
        let mut sums = vec![0.0; config.measures.len()];
        let mut counts = vec![0_u64; config.measures.len()];
        let mut prior_order: Option<Value> = None;
        let mut rank = 1_u64;
        let mut dense_rank = 1_u64;
        for (position, row_index) in partition.into_iter().enumerate() {
            cancelled(cancellation, rows.len())?;
            let row = &input.rows[row_index];
            let order_value = row.get(order).cloned().unwrap_or(Value::Null);
            if prior_order
                .as_ref()
                .is_some_and(|prior| compare(prior, &order_value) != Ordering::Equal)
            {
                rank = position as u64 + 1;
                dense_rank += 1;
            }
            prior_order = Some(order_value);
            let mut extras = HashMap::new();
            for (index, measure) in config.measures.iter().enumerate() {
                let value = match measure.function {
                    WindowFunction::RowNumber => Value::from(position as u64 + 1),
                    WindowFunction::Rank => Value::from(rank),
                    WindowFunction::DenseRank => Value::from(dense_rank),
                    WindowFunction::RunningSum | WindowFunction::RunningAvg => {
                        if let Some(value) = measure_indexes[index]
                            .and_then(|index| row.get(index))
                            .and_then(value_number)
                        {
                            sums[index] += value;
                            counts[index] += 1;
                        }
                        if matches!(measure.function, WindowFunction::RunningAvg) {
                            (counts[index] > 0)
                                .then(|| number(sums[index] / counts[index] as f64))
                                .unwrap_or(Value::Null)
                        } else {
                            number(sums[index])
                        }
                    }
                };
                extras.insert(measure.output.clone(), value);
            }
            rows.push(project_row(&input.columns, row, output, &extras));
        }
    }
    enforce_bounds(AnalysisDataSet {
        columns: output.to_vec(),
        rows,
        truncated: input.truncated,
    })
}

fn lag(
    input: &AnalysisDataSet,
    output: &[AnalysisColumn],
    config: &LagConfig,
    cancellation: &CancelHandle,
) -> AppResult<AnalysisDataSet> {
    let value_index = column_index(&input.columns, &config.column)?;
    let mut rows = Vec::with_capacity(input.rows.len());
    for partition in partitioned_order(input, &config.partition_by, &config.order_by)? {
        for (position, row_index) in partition.iter().copied().enumerate() {
            cancelled(cancellation, rows.len())?;
            let lagged = position
                .checked_sub(config.offset)
                .and_then(|position| partition.get(position))
                .and_then(|index| input.rows.get(*index))
                .and_then(|row| row.get(value_index))
                .cloned()
                .unwrap_or(Value::Null);
            rows.push(project_row(
                &input.columns,
                &input.rows[row_index],
                output,
                &HashMap::from([(config.output.clone(), lagged)]),
            ));
        }
    }
    enforce_bounds(AnalysisDataSet {
        columns: output.to_vec(),
        rows,
        truncated: input.truncated,
    })
}

fn arithmetic(
    input: &AnalysisDataSet,
    output: &[AnalysisColumn],
    config: &ArithmeticConfig,
    operation: AnalysisTransformOperation,
    cancellation: &CancelHandle,
) -> AppResult<AnalysisDataSet> {
    let numerator = column_index(&input.columns, &config.numerator)?;
    let denominator = column_index(&input.columns, &config.denominator)?;
    let mut rows = Vec::with_capacity(input.rows.len());
    for (index, row) in input.rows.iter().enumerate() {
        cancelled(cancellation, index)?;
        let value = match (
            row.get(numerator).and_then(value_number),
            row.get(denominator).and_then(value_number),
        ) {
            (Some(numerator), Some(denominator)) => match operation {
                AnalysisTransformOperation::Difference => number(numerator - denominator),
                AnalysisTransformOperation::Ratio if denominator != 0.0 => {
                    number(numerator / denominator)
                }
                AnalysisTransformOperation::Rate if denominator != 0.0 => {
                    number((numerator - denominator) / denominator)
                }
                _ => Value::Null,
            },
            _ => Value::Null,
        };
        rows.push(project_row(
            &input.columns,
            row,
            output,
            &HashMap::from([(config.output.clone(), value)]),
        ));
    }
    enforce_bounds(AnalysisDataSet {
        columns: output.to_vec(),
        rows,
        truncated: input.truncated,
    })
}

fn timestamp(value: &Value) -> Option<DateTime<Utc>> {
    let value = value.as_str()?;
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.with_timezone(&Utc))
        .ok()
        .or_else(|| {
            NaiveDate::parse_from_str(value, "%Y-%m-%d")
                .ok()?
                .and_hms_opt(0, 0, 0)
                .map(|value| value.and_utc())
        })
        .or_else(|| {
            NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S")
                .ok()
                .map(|value| value.and_utc())
        })
        .or_else(|| {
            let (year, week) = value.split_once("-W")?;
            NaiveDate::from_isoywd_opt(year.parse().ok()?, week.parse().ok()?, Weekday::Mon)
                .and_then(|value| value.and_hms_opt(0, 0, 0))
                .map(|value| value.and_utc())
        })
        .or_else(|| {
            NaiveDate::parse_from_str(&format!("{value}-01"), "%Y-%m-%d")
                .ok()?
                .and_hms_opt(0, 0, 0)
                .map(|value| value.and_utc())
        })
}

fn bucket(value: DateTime<Utc>, unit: PeriodUnit) -> String {
    match unit {
        PeriodUnit::Day => value.format("%Y-%m-%d").to_string(),
        PeriodUnit::Week => {
            let week = value.iso_week();
            format!("{}-W{:02}", week.year(), week.week())
        }
        PeriodUnit::Month => value.format("%Y-%m").to_string(),
    }
}

fn cohort(
    input: &AnalysisDataSet,
    output: &[AnalysisColumn],
    config: &CohortConfig,
    cancellation: &CancelHandle,
) -> AppResult<AnalysisDataSet> {
    let entity = column_index(&input.columns, &config.entity_column)?;
    let event_time = column_index(&input.columns, &config.event_time_column)?;
    let mut first_event = HashMap::<String, DateTime<Utc>>::new();
    for row in &input.rows {
        let key = canonical(row.get(entity).unwrap_or(&Value::Null));
        let Some(event) = row.get(event_time).and_then(timestamp) else {
            continue;
        };
        first_event
            .entry(key)
            .and_modify(|current| *current = (*current).min(event))
            .or_insert(event);
    }
    let mut rows = Vec::with_capacity(input.rows.len());
    for (index, row) in input.rows.iter().enumerate() {
        cancelled(cancellation, index)?;
        let key = canonical(row.get(entity).unwrap_or(&Value::Null));
        let value = first_event
            .get(&key)
            .map(|value| Value::String(bucket(*value, config.cohort_unit)))
            .unwrap_or(Value::Null);
        rows.push(project_row(
            &input.columns,
            row,
            output,
            &HashMap::from([(config.output.clone(), value)]),
        ));
    }
    enforce_bounds(AnalysisDataSet {
        columns: output.to_vec(),
        rows,
        truncated: input.truncated,
    })
}

fn period_between(cohort: DateTime<Utc>, event: DateTime<Utc>, unit: PeriodUnit) -> i64 {
    match unit {
        PeriodUnit::Day => (event.date_naive() - cohort.date_naive()).num_days(),
        PeriodUnit::Week => (event.date_naive() - cohort.date_naive()).num_days() / 7,
        PeriodUnit::Month => {
            (event.year() as i64 - cohort.year() as i64) * 12 + event.month() as i64
                - cohort.month() as i64
        }
    }
}

fn retention(
    input: &AnalysisDataSet,
    output: &[AnalysisColumn],
    config: &super::config::RetentionConfig,
    cancellation: &CancelHandle,
) -> AppResult<AnalysisDataSet> {
    let _entity = column_index(&input.columns, &config.entity_column)?;
    let cohort = column_index(&input.columns, &config.cohort_column)?;
    let event = column_index(&input.columns, &config.event_time_column)?;
    let mut rows = Vec::with_capacity(input.rows.len());
    for (index, row) in input.rows.iter().enumerate() {
        cancelled(cancellation, index)?;
        let Some(cohort) = row.get(cohort).and_then(timestamp) else {
            continue;
        };
        let Some(event) = row.get(event).and_then(timestamp) else {
            continue;
        };
        let period = period_between(cohort, event, config.period_unit);
        if period < 0 || period > config.periods as i64 {
            continue;
        }
        rows.push(project_row(
            &input.columns,
            row,
            output,
            &HashMap::from([(config.output.clone(), Value::from(period))]),
        ));
    }
    enforce_bounds(AnalysisDataSet {
        columns: output.to_vec(),
        rows,
        truncated: input.truncated,
    })
}

pub(crate) fn execute_transform(
    transform: &AnalysisTransformNode,
    inputs: &[&AnalysisDataSet],
    cancellation: &CancelHandle,
) -> AppResult<AnalysisDataSet> {
    let config = parse_transform_config(transform.operation, &transform.config)?;
    match (transform.operation, config) {
        (AnalysisTransformOperation::Project, TransformConfig::Project(config)) => {
            project(inputs[0], &transform.columns, &config, false, cancellation)
        }
        (AnalysisTransformOperation::Group, TransformConfig::Group(config)) => {
            project(inputs[0], &transform.columns, &config, true, cancellation)
        }
        (AnalysisTransformOperation::Filter, TransformConfig::Filter(config)) => {
            filter(inputs[0], &config, cancellation)
        }
        (AnalysisTransformOperation::Sort, TransformConfig::Sort(config)) => {
            sort(inputs[0], &config)
        }
        (AnalysisTransformOperation::Limit, TransformConfig::Limit(config)) => {
            let mut output = inputs[0].clone();
            if output.rows.len() > config.count {
                output.rows.truncate(config.count);
                output.truncated = true;
            }
            Ok(output)
        }
        (AnalysisTransformOperation::Union, TransformConfig::Union(config)) => {
            union(inputs[0], inputs[1], config.all, cancellation)
        }
        (AnalysisTransformOperation::Aggregate, TransformConfig::Aggregate(config)) => {
            aggregate(inputs[0], &transform.columns, &config, cancellation)
        }
        (AnalysisTransformOperation::InnerJoin, TransformConfig::Join(config)) => {
            join(inputs[0], inputs[1], &config, false, cancellation)
        }
        (AnalysisTransformOperation::LeftJoin, TransformConfig::Join(config)) => {
            join(inputs[0], inputs[1], &config, true, cancellation)
        }
        (AnalysisTransformOperation::Window, TransformConfig::Window(config)) => {
            window(inputs[0], &transform.columns, &config, cancellation)
        }
        (AnalysisTransformOperation::Lag, TransformConfig::Lag(config)) => {
            lag(inputs[0], &transform.columns, &config, cancellation)
        }
        (
            operation @ (AnalysisTransformOperation::Ratio
            | AnalysisTransformOperation::Difference
            | AnalysisTransformOperation::Rate),
            TransformConfig::Arithmetic(config),
        ) => arithmetic(
            inputs[0],
            &transform.columns,
            &config,
            operation,
            cancellation,
        ),
        (AnalysisTransformOperation::Cohort, TransformConfig::Cohort(config)) => {
            cohort(inputs[0], &transform.columns, &config, cancellation)
        }
        (AnalysisTransformOperation::Retention, TransformConfig::Retention(config)) => {
            retention(inputs[0], &transform.columns, &config, cancellation)
        }
        _ => Err(AppError::Config(
            "Analysis Article transform configuration changed operation".into(),
        )),
    }
}
