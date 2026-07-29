//! Shared SQL namespace validation and identifier quoting.
//!
//! A namespace travels through document persistence and immutable operation
//! payloads as data. The target-specific executor is the only layer that turns
//! it into SQL, using quoted identifiers rather than accepting a raw statement
//! fragment from a renderer.

use crate::error::{AppError, AppResult};

const MAX_SQL_NAMESPACE_BYTES: usize = 256;

pub(crate) fn normalize_sql_namespace(value: Option<String>) -> AppResult<Option<String>> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() > MAX_SQL_NAMESPACE_BYTES {
        return Err(AppError::Config(format!(
            "SQL namespace exceeds the {MAX_SQL_NAMESPACE_BYTES}-byte limit"
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
