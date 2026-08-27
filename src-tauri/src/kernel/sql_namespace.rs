//! Shared SQL namespace validation and identifier quoting.
//!
//! A namespace travels through document persistence and immutable operation
//! payloads as data. The target-specific executor is the only layer that turns
//! it into SQL, using quoted identifiers rather than accepting a raw statement
//! fragment from a renderer.

use crate::error::{AppError, AppResult};

pub(crate) fn normalize_sql_namespace_bounded(
    value: Option<String>,
    maximum_bytes: usize,
) -> AppResult<Option<String>> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() > maximum_bytes {
        return Err(AppError::Config(format!(
            "SQL namespace exceeds the {maximum_bytes}-byte limit"
        )));
    }
    if value.chars().any(char::is_control) {
        return Err(AppError::Config(
            "SQL namespace contains a control character".into(),
        ));
    }
    Ok(Some(value.to_owned()))
}

pub(crate) fn quote_postgres_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}
