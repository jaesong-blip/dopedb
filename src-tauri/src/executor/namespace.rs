//! Engine-aware SQL namespace validation and PostgreSQL transaction context.

use crate::error::{AppError, AppResult};
use crate::kernel::sql_namespace::{normalize_sql_namespace_bounded, quote_postgres_identifier};
use crate::model::{ConnectionProfile, Engine};

pub(crate) fn resolve_sql_namespace(
    profile: &ConnectionProfile,
    target_database: Option<&str>,
    requested: Option<String>,
) -> AppResult<Option<String>> {
    let namespace = normalize_sql_namespace_bounded(
        requested,
        if profile.engine == Engine::Bigquery {
            1_024
        } else {
            256
        },
    )?;
    let Some(namespace) = namespace else {
        return Ok(None);
    };
    let target_database = target_database.unwrap_or(&profile.database);

    match profile.engine {
        Engine::Postgres => Ok(Some(namespace)),
        Engine::Mysql if namespace == target_database => Ok(Some(namespace)),
        Engine::Sqlite if namespace == "main" => Ok(Some(namespace)),
        Engine::Bigquery if namespace == target_database => Ok(Some(namespace)),
        Engine::Mysql => Err(AppError::Blocked {
            reason: "this MySQL connection can execute only in its configured database".into(),
        }),
        Engine::Sqlite => Err(AppError::Blocked {
            reason: "this SQLite connection exposes only the main namespace".into(),
        }),
        Engine::Mongodb => Err(AppError::Blocked {
            reason: "SQL namespaces are unavailable for document connections".into(),
        }),
        Engine::Bigquery => Err(AppError::Blocked {
            reason: "this BigQuery connection can execute only in its configured dataset".into(),
        }),
    }
}

pub(crate) fn postgres_search_path_statement(namespace: &str) -> String {
    format!(
        "SET LOCAL search_path TO {}",
        quote_postgres_identifier(namespace)
    )
}
