use std::io::Write;

use dopedb_protocol::NormalizedTypeFamily;
use serde_json::Value;

use crate::error::{AppError, AppResult};

pub(super) fn row_object(columns: &[String], values: &[Value]) -> Value {
    Value::Object(
        columns
            .iter()
            .enumerate()
            .map(|(index, column)| {
                (
                    column.clone(),
                    values.get(index).cloned().unwrap_or(Value::Null),
                )
            })
            .collect(),
    )
}

pub(super) fn write_delimited_row(
    writer: &mut impl Write,
    values: &[String],
    delimiter: u8,
) -> AppResult<()> {
    let values = values
        .iter()
        .map(|value| Value::String(value.clone()))
        .collect::<Vec<_>>();
    write_delimited_values(writer, &values, delimiter)
}

pub(super) fn write_delimited_values(
    writer: &mut impl Write,
    values: &[Value],
    delimiter: u8,
) -> AppResult<()> {
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            writer.write_all(&[delimiter])?;
        }
        let value = scalar_text(value);
        let needs_quote = value
            .bytes()
            .any(|byte| byte == delimiter || matches!(byte, b'"' | b'\r' | b'\n'));
        if needs_quote {
            writer.write_all(b"\"")?;
            writer.write_all(value.replace('"', "\"\"").as_bytes())?;
            writer.write_all(b"\"")?;
        } else {
            writer.write_all(value.as_bytes())?;
        }
    }
    writer.write_all(b"\n")?;
    Ok(())
}

pub(super) fn write_insert(
    writer: &mut impl Write,
    engine: crate::model::Engine,
    table_sql: &str,
    columns: &[String],
    type_families: &[NormalizedTypeFamily],
    values: &[Value],
) -> AppResult<()> {
    let columns = columns
        .iter()
        .map(|column| quote_identifier(engine, column))
        .collect::<Vec<_>>()
        .join(", ");
    let values = values
        .iter()
        .enumerate()
        .map(|(index, value)| {
            typed_sql_literal(
                engine,
                type_families
                    .get(index)
                    .copied()
                    .unwrap_or(NormalizedTypeFamily::Other),
                value,
            )
            .map_err(AppError::Config)
        })
        .collect::<AppResult<Vec<_>>>()?
        .join(", ");
    writeln!(
        writer,
        "INSERT INTO {table_sql} ({columns}) VALUES ({values});"
    )?;
    Ok(())
}

fn quote_identifier(engine: crate::model::Engine, value: &str) -> String {
    if engine == crate::model::Engine::Mysql {
        format!("`{}`", value.replace('`', "``"))
    } else {
        format!("\"{}\"", value.replace('"', "\"\""))
    }
}

pub(in crate::features::jobs) fn typed_sql_literal(
    engine: crate::model::Engine,
    family: NormalizedTypeFamily,
    value: &Value,
) -> Result<String, String> {
    if value.is_null() {
        return Ok("NULL".into());
    }
    match family {
        NormalizedTypeFamily::Boolean => match value {
            Value::Bool(value) => Ok(if *value { "TRUE" } else { "FALSE" }.into()),
            Value::Number(value) if value.as_i64() == Some(1) => Ok("TRUE".into()),
            Value::Number(value) if value.as_i64() == Some(0) => Ok("FALSE".into()),
            Value::String(value) => match value.trim().to_ascii_lowercase().as_str() {
                "true" | "t" | "1" | "yes" | "y" => Ok("TRUE".into()),
                "false" | "f" | "0" | "no" | "n" => Ok("FALSE".into()),
                _ => Err("boolean value must be true/false or 1/0".into()),
            },
            _ => Err("boolean value has an unsupported shape".into()),
        },
        NormalizedTypeFamily::Integer
        | NormalizedTypeFamily::Decimal
        | NormalizedTypeFamily::Float => match value {
            Value::Number(value) => Ok(value.to_string()),
            Value::String(value) => Ok(quoted_text(engine, value)),
            _ => Err("numeric value must be a number or numeric string".into()),
        },
        NormalizedTypeFamily::Binary => {
            let Value::String(value) = value else {
                return Err("binary value must be a hexadecimal string".into());
            };
            let hex = value
                .strip_prefix("\\x")
                .or_else(|| value.strip_prefix("0x"))
                .ok_or_else(|| "binary value must use a \\\\x hexadecimal prefix".to_owned())?;
            if hex.len() % 2 != 0 || hex::decode(hex).is_err() {
                return Err("binary value contains invalid hexadecimal data".into());
            }
            Ok(if engine == crate::model::Engine::Postgres {
                format!("decode('{hex}', 'hex')")
            } else {
                format!("X'{hex}'")
            })
        }
        NormalizedTypeFamily::Array if engine == crate::model::Engine::Postgres => {
            let Value::Array(values) = value else {
                return Ok(quoted_value(engine, value));
            };
            let values = values
                .iter()
                .map(|value| {
                    if let Value::Array(_) = value {
                        typed_sql_literal(engine, NormalizedTypeFamily::Array, value)
                    } else {
                        typed_sql_literal(engine, NormalizedTypeFamily::Other, value)
                    }
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(format!("ARRAY[{}]", values.join(", ")))
        }
        NormalizedTypeFamily::Json
        | NormalizedTypeFamily::Array
        | NormalizedTypeFamily::Document => Ok(quoted_value(engine, value)),
        NormalizedTypeFamily::Text
        | NormalizedTypeFamily::Date
        | NormalizedTypeFamily::Time
        | NormalizedTypeFamily::Timestamp
        | NormalizedTypeFamily::Uuid => Ok(quoted_value(engine, value)),
        NormalizedTypeFamily::Other => match value {
            Value::Bool(value) => Ok(if *value { "TRUE" } else { "FALSE" }.into()),
            Value::Number(value) => Ok(value.to_string()),
            Value::String(value) => Ok(quoted_text(engine, value)),
            Value::Array(_) | Value::Object(_) => Ok(quoted_text(engine, &value.to_string())),
            Value::Null => unreachable!(),
        },
    }
}

fn quoted_value(engine: crate::model::Engine, value: &Value) -> String {
    match value {
        Value::String(value) => quoted_text(engine, value),
        value => quoted_text(engine, &value.to_string()),
    }
}

fn quoted_text(engine: crate::model::Engine, value: &str) -> String {
    let escaped = if engine == crate::model::Engine::Mysql {
        value.replace('\\', "\\\\").replace('\'', "''")
    } else {
        value.replace('\'', "''")
    };
    format!("'{escaped}'")
}

fn scalar_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(value) => value.clone(),
        Value::Bool(_) | Value::Number(_) => value.to_string(),
        Value::Array(_) | Value::Object(_) => value.to_string(),
    }
}

pub(super) fn write_xlsx_value(
    worksheet: &mut rust_xlsxwriter::Worksheet,
    row: u32,
    column: u16,
    value: &Value,
) -> AppResult<()> {
    match value {
        Value::Null => {}
        Value::Bool(value) => {
            worksheet
                .write_boolean(row, column, *value)
                .map_err(xlsx_error)?;
        }
        Value::Number(value) => {
            if let Some(value) = value.as_f64() {
                worksheet
                    .write_number(row, column, value)
                    .map_err(xlsx_error)?;
            } else {
                worksheet
                    .write_string(row, column, value.to_string())
                    .map_err(xlsx_error)?;
            }
        }
        Value::String(value) => {
            worksheet
                .write_string(row, column, value)
                .map_err(xlsx_error)?;
        }
        Value::Array(_) | Value::Object(_) => {
            worksheet
                .write_string(row, column, value.to_string())
                .map_err(xlsx_error)?;
        }
    }
    Ok(())
}

pub(super) fn xlsx_error(error: rust_xlsxwriter::XlsxError) -> AppError {
    AppError::Config(format!("XLSX writer failed: {error}"))
}
