//! Saved-dashboard presentation and read-only SQL policies.

use crate::error::{AppError, AppResult};
use crate::model::{Engine, QueryKind};
use crate::safety;

use super::domain::{DashboardDraft, DashboardVisualization};

pub(super) const VISUALIZATION_VERSION: u32 = 1;
const MAX_TITLE_CHARS: usize = 120;
const MAX_DESCRIPTION_CHARS: usize = 2_000;
const MAX_SQL_BYTES: usize = 100_000;
const MAX_COLUMN_NAME_CHARS: usize = 256;
const MAX_Y_COLUMNS: usize = 4;

fn has_unsafe_display_character(value: &str) -> bool {
    value.chars().any(|character| {
        (character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
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

pub(crate) fn validate_visualization(visualization: &DashboardVisualization) -> AppResult<()> {
    if visualization.version != VISUALIZATION_VERSION {
        return Err(AppError::Config(format!(
            "unsupported dashboard visualization version {}",
            visualization.version
        )));
    }
    if let Some(x_column) = &visualization.x_column {
        validate_column_name(x_column, "x column")?;
    }
    if visualization.y_columns.len() > MAX_Y_COLUMNS {
        return Err(AppError::Config(format!(
            "dashboard visualization cannot contain more than {MAX_Y_COLUMNS} y columns"
        )));
    }
    for (index, column) in visualization.y_columns.iter().enumerate() {
        validate_column_name(column, &format!("y column {}", index + 1))?;
        if visualization.y_columns[..index].contains(column) {
            return Err(AppError::Config(format!(
                "dashboard y column {column:?} is duplicated"
            )));
        }
    }
    Ok(())
}

fn validate_column_name(column: &str, label: &str) -> AppResult<()> {
    if column.trim().is_empty() {
        return Err(AppError::Config(format!(
            "dashboard {label} cannot be blank"
        )));
    }
    if column.chars().count() > MAX_COLUMN_NAME_CHARS {
        return Err(AppError::Config(format!(
            "dashboard {label} cannot exceed {MAX_COLUMN_NAME_CHARS} characters"
        )));
    }
    if has_unsafe_display_character(column) {
        return Err(AppError::Config(format!(
            "dashboard {label} contains unsafe display characters"
        )));
    }
    Ok(())
}

pub(super) fn validate_draft(draft: &DashboardDraft, engine: Engine) -> AppResult<()> {
    let title = draft.title.trim();
    if title.is_empty() {
        return Err(AppError::Config("dashboard title cannot be empty".into()));
    }
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err(AppError::Config(format!(
            "dashboard title cannot exceed {MAX_TITLE_CHARS} characters"
        )));
    }
    if has_unsafe_display_character(&draft.title) {
        return Err(AppError::Config(
            "dashboard title contains unsafe display characters".into(),
        ));
    }
    if draft.description.chars().count() > MAX_DESCRIPTION_CHARS {
        return Err(AppError::Config(format!(
            "dashboard description cannot exceed {MAX_DESCRIPTION_CHARS} characters"
        )));
    }
    if has_unsafe_display_character(&draft.description) {
        return Err(AppError::Config(
            "dashboard description contains unsafe display characters".into(),
        ));
    }
    if draft.sql.trim().is_empty() {
        return Err(AppError::Config("dashboard SQL cannot be empty".into()));
    }
    if draft.sql.len() > MAX_SQL_BYTES {
        return Err(AppError::Config(format!(
            "dashboard SQL cannot exceed {MAX_SQL_BYTES} bytes"
        )));
    }
    if draft.sql.contains('\0') {
        return Err(AppError::Config("dashboard SQL contains a null byte".into()));
    }
    validate_visualization(&draft.visualization)?;
    let classification = safety::classify(&draft.sql, engine)?;
    if !matches!(classification.kind, QueryKind::Read) || classification.statement_count != 1 {
        return Err(AppError::Blocked {
            reason: "dashboards may only save one read-only SQL statement".into(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use uuid::Uuid;

    use super::*;
    use crate::features::dashboards::adapters::{
        dashboard_result_limits, enforce_dashboard_result,
    };
    use crate::features::dashboards::{DashboardKind, DashboardVisualization};
    use crate::kernel::identity::ConnectionId;
    use crate::model::QueryResult;

    fn draft(sql: &str) -> DashboardDraft {
        DashboardDraft {
            connection_id: ConnectionId::from(Uuid::new_v4()),
            title: "Daily visitors".into(),
            description: String::new(),
            sql: sql.into(),
            visualization: DashboardVisualization {
                version: VISUALIZATION_VERSION,
                kind: DashboardKind::Line,
                x_column: Some("day".into()),
                y_columns: vec!["visitors".into()],
            },
        }
    }

    #[test]
    fn accepts_one_read_and_rejects_writes_and_stacked_reads() {
        assert!(validate_draft(
            &draft("SELECT day, count(*) FROM visits GROUP BY day"),
            Engine::Postgres
        )
        .is_ok());
        assert!(matches!(
            validate_draft(&draft("DELETE FROM visits"), Engine::Postgres),
            Err(AppError::Blocked { .. })
        ));
        assert!(matches!(
            validate_draft(&draft("SELECT 1; SELECT 2"), Engine::Postgres),
            Err(AppError::Blocked { .. })
        ));
        let mut unsafe_title = draft("SELECT 1");
        unsafe_title.title = "safe\u{202e}hidden".into();
        assert!(matches!(
            validate_draft(&unsafe_title, Engine::Postgres),
            Err(AppError::Config(_))
        ));
        let mut null_sql = draft("SELECT 1");
        null_sql.sql.push('\0');
        assert!(matches!(
            validate_draft(&null_sql, Engine::Postgres),
            Err(AppError::Config(_))
        ));

        assert_eq!(dashboard_result_limits(DashboardKind::Metric, 100_000).0, 1);
        assert_eq!(
            dashboard_result_limits(DashboardKind::Table, 100_000).0,
            1_000
        );
        let bounded = enforce_dashboard_result(
            QueryResult {
                columns: vec!["payload".into()],
                rows: (0..20)
                    .map(|_| vec![serde_json::Value::String("x".repeat(128))])
                    .collect(),
                row_count: 20,
                truncated: false,
                duration_ms: 1,
            },
            512,
        )
        .expect("dashboard result is bounded");
        assert!(bounded.rows.len() < 20);
        assert!(bounded.truncated);
        assert!(serde_json::to_vec(&bounded).unwrap().len() <= 512);
    }

    #[test]
    fn rejects_empty_or_oversized_title_and_sql() {
        let mut value = draft("SELECT 1");
        value.title = "   ".into();
        assert!(matches!(
            validate_draft(&value, Engine::Postgres),
            Err(AppError::Config(_))
        ));

        value.title = "x".repeat(MAX_TITLE_CHARS + 1);
        assert!(matches!(
            validate_draft(&value, Engine::Postgres),
            Err(AppError::Config(_))
        ));

        value.title = "ok".into();
        value.sql = " ".into();
        assert!(matches!(
            validate_draft(&value, Engine::Postgres),
            Err(AppError::Config(_))
        ));

        value.sql = "x".repeat(MAX_SQL_BYTES + 1);
        assert!(matches!(
            validate_draft(&value, Engine::Postgres),
            Err(AppError::Config(_))
        ));
    }

    #[test]
    fn rejects_oversized_description_and_invalid_column_mappings() {
        let mut value = draft("SELECT 1");
        value.description = "x".repeat(MAX_DESCRIPTION_CHARS + 1);
        assert!(matches!(
            validate_draft(&value, Engine::Postgres),
            Err(AppError::Config(_))
        ));

        value.description.clear();
        value.visualization.x_column = Some(" ".into());
        assert!(matches!(
            validate_draft(&value, Engine::Postgres),
            Err(AppError::Config(_))
        ));

        value.visualization.x_column = None;
        value.visualization.y_columns = vec!["value".into(), "value".into()];
        assert!(matches!(
            validate_draft(&value, Engine::Postgres),
            Err(AppError::Config(_))
        ));

        value.visualization.y_columns = (0..=MAX_Y_COLUMNS)
            .map(|index| format!("value_{index}"))
            .collect();
        assert!(matches!(
            validate_draft(&value, Engine::Postgres),
            Err(AppError::Config(_))
        ));

        value.visualization.y_columns = vec!["x".repeat(MAX_COLUMN_NAME_CHARS + 1)];
        assert!(matches!(
            validate_draft(&value, Engine::Postgres),
            Err(AppError::Config(_))
        ));
    }
}
