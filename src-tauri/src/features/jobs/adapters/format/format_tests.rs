use std::fs::File;
use std::io::Read;

use dopedb_protocol::NormalizedTypeFamily;
use flate2::read::GzDecoder;
use serde_json::Value;

use super::*;
use crate::error::AppError;
use crate::features::jobs::JobFormat;
use crate::model::Engine;

fn families() -> Vec<NormalizedTypeFamily> {
    vec![NormalizedTypeFamily::Integer, NormalizedTypeFamily::Text]
}

#[test]
fn json_export_resume_preserves_exact_partial_fingerprint() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("rows.json.part");
    let mut sink = ExportSink::open(
        &path,
        JobFormat::Json,
        vec!["id".into(), "name".into()],
        families(),
        "\"rows\"".into(),
        Engine::Sqlite,
        0,
    )
    .unwrap();
    sink.write_rows(&[
        vec![Value::from(1), Value::from("alpha")],
        vec![Value::from(2), Value::from("beta")],
    ])
    .unwrap();
    sink.flush().unwrap();
    let checkpoint = sink.fingerprint().unwrap();
    drop(sink);

    let mut resumed = ExportSink::open(
        &path,
        JobFormat::Json,
        vec!["id".into(), "name".into()],
        families(),
        "\"rows\"".into(),
        Engine::Sqlite,
        2,
    )
    .unwrap();
    assert_eq!(resumed.fingerprint().as_deref(), Some(checkpoint.as_str()));
    resumed
        .write_rows(&[vec![Value::from(3), Value::from("gamma")]])
        .unwrap();
    resumed.finish().unwrap();

    let rows: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(rows.as_array().unwrap().len(), 3);
    assert_eq!(rows[2]["name"], "gamma");
}

#[test]
fn csv_and_gzip_exports_quote_and_finalize_cleanly() {
    let directory = tempfile::tempdir().unwrap();
    let csv_path = directory.path().join("rows.csv");
    let rows = [vec![Value::from(7), Value::from("comma,\nquote\"")]];
    let mut csv = ExportSink::open(
        &csv_path,
        JobFormat::Csv,
        vec!["id".into(), "value".into()],
        families(),
        "\"rows\"".into(),
        Engine::Sqlite,
        0,
    )
    .unwrap();
    csv.write_rows(&rows).unwrap();
    csv.finish().unwrap();
    let mut parsed = csv::Reader::from_path(csv_path).unwrap();
    assert_eq!(
        parsed.records().next().unwrap().unwrap().get(1),
        Some("comma,\nquote\"")
    );

    let gzip_path = directory.path().join("rows.csv.gz");
    let mut gzip = ExportSink::open(
        &gzip_path,
        JobFormat::CsvGzip,
        vec!["id".into(), "value".into()],
        families(),
        "\"rows\"".into(),
        Engine::Sqlite,
        0,
    )
    .unwrap();
    gzip.write_rows(&rows).unwrap();
    gzip.finish().unwrap();
    let mut decoded = String::new();
    GzDecoder::new(File::open(gzip_path).unwrap())
        .read_to_string(&mut decoded)
        .unwrap();
    assert!(decoded.contains("\"comma,"));

    assert!(ExportSink::open(
        &directory.path().join("resume.csv.gz"),
        JobFormat::CsvGzip,
        vec!["id".into()],
        vec![NormalizedTypeFamily::Integer],
        "\"rows\"".into(),
        Engine::Sqlite,
        1,
    )
    .is_err());
}

#[test]
fn ndjson_and_sql_streams_round_trip_without_loading_the_export() {
    let directory = tempfile::tempdir().unwrap();
    let rows = [
        vec![Value::from(1), Value::from("alpha")],
        vec![Value::from(2), Value::from("beta")],
    ];

    let ndjson_path = directory.path().join("rows.ndjson");
    let mut ndjson = ExportSink::open(
        &ndjson_path,
        JobFormat::Ndjson,
        vec!["id".into(), "name".into()],
        families(),
        "\"rows\"".into(),
        Engine::Sqlite,
        0,
    )
    .unwrap();
    ndjson.write_rows(&rows).unwrap();
    ndjson.finish().unwrap();
    let mut source =
        ImportSource::open(&ndjson_path, JobFormat::Ndjson, 0, Engine::Sqlite).unwrap();
    let imported = source.next_batch(10).unwrap();
    assert_eq!(imported.len(), 2);
    let ImportItem::Data(first) = &imported[0] else {
        panic!("NDJSON row must remain structured data");
    };
    assert_eq!(first.values["name"], "alpha");

    let sql_path = directory.path().join("rows.sql");
    let mut sql = ExportSink::open(
        &sql_path,
        JobFormat::Sql,
        vec!["id".into(), "name".into()],
        families(),
        "\"rows\"".into(),
        Engine::Sqlite,
        0,
    )
    .unwrap();
    sql.write_rows(&rows).unwrap();
    sql.finish().unwrap();
    let audit = audit_sql_import(&sql_path, JobFormat::Sql, Engine::Sqlite).unwrap();
    assert_eq!(audit.statement_count, 2);
    assert_eq!(audit.write_count, 2);
}

#[test]
fn xlsx_export_import_round_trip_is_explicitly_non_resumable() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("rows.xlsx");
    let mut sink = ExportSink::open(
        &path,
        JobFormat::Xlsx,
        vec!["id".into(), "name".into()],
        families(),
        "\"rows\"".into(),
        Engine::Sqlite,
        0,
    )
    .unwrap();
    sink.write_rows(&[
        vec![Value::from(7), Value::from("xlsx")],
        vec![Value::from(8), Value::Null],
    ])
    .unwrap();
    sink.finish().unwrap();

    let inspection = inspect_input(&path, JobFormat::Xlsx, Engine::Sqlite).unwrap();
    assert_eq!(inspection.fields, vec!["id", "name"]);
    assert_eq!(inspection.item_count, Some(2));
    assert!(!inspection.resumable);
    assert!(ImportSource::open(&path, JobFormat::Xlsx, 1, Engine::Sqlite).is_err());

    let mut source = ImportSource::open(&path, JobFormat::Xlsx, 0, Engine::Sqlite).unwrap();
    let imported = source.next_batch(10).unwrap();
    let ImportItem::Data(first) = &imported[0] else {
        panic!("XLSX row must remain structured data");
    };
    assert_eq!(first.values["id"], 7.0);
    assert_eq!(first.values["name"], "xlsx");
}

#[test]
fn typed_literals_preserve_decimal_date_boolean_and_binary_values() {
    assert_eq!(
        typed_sql_literal(
            Engine::Postgres,
            NormalizedTypeFamily::Decimal,
            &Value::from("12345678901234567890.123400"),
        )
        .unwrap(),
        "'12345678901234567890.123400'"
    );
    assert_eq!(
        typed_sql_literal(
            Engine::Sqlite,
            NormalizedTypeFamily::Date,
            &Value::from("2026-07-25"),
        )
        .unwrap(),
        "'2026-07-25'"
    );
    assert_eq!(
        typed_sql_literal(
            Engine::Mysql,
            NormalizedTypeFamily::Boolean,
            &Value::from("1"),
        )
        .unwrap(),
        "TRUE"
    );
    assert_eq!(
        typed_sql_literal(
            Engine::Postgres,
            NormalizedTypeFamily::Binary,
            &Value::from("\\x00ff10"),
        )
        .unwrap(),
        "decode('00ff10', 'hex')"
    );
    assert_eq!(
        typed_sql_literal(
            Engine::Mysql,
            NormalizedTypeFamily::Binary,
            &Value::from("\\x00ff10"),
        )
        .unwrap(),
        "X'00ff10'"
    );
}

#[test]
fn input_inspection_returns_bounded_samples_without_paths() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("rows.ndjson");
    std::fs::write(
        &path,
        "{\"id\":1,\"name\":\"alpha\"}\n{\"id\":2,\"name\":\"beta\"}\n",
    )
    .unwrap();
    let inspection = inspect_input(&path, JobFormat::Ndjson, Engine::Sqlite).unwrap();
    assert_eq!(inspection.fields, vec!["id", "name"]);
    assert_eq!(inspection.sample_rows.len(), 2);
    assert!(inspection.resumable);
}

#[test]
fn sql_import_audit_blocks_privilege_statements() {
    let directory = tempfile::tempdir().unwrap();
    let safe = directory.path().join("safe.sql");
    std::fs::write(&safe, "INSERT INTO items(id) VALUES (1);").unwrap();
    let audit = audit_sql_import(&safe, JobFormat::Sql, Engine::Postgres).unwrap();
    assert_eq!(audit.statement_count, 1);
    assert_eq!(audit.write_count, 1);

    let privilege = directory.path().join("privilege.sql");
    std::fs::write(&privilege, "GRANT SELECT ON items TO reader;").unwrap();
    assert!(matches!(
        audit_sql_import(&privilege, JobFormat::Sql, Engine::Postgres),
        Err(AppError::Blocked { .. })
    ));
}

#[test]
fn verified_review_binds_preview_and_sql_audit_to_the_registered_hash() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("review.sql");
    std::fs::write(&path, "INSERT INTO items(id) VALUES (1);").unwrap();
    let expected = file_sha256(&path).unwrap();

    let review = review_input_verified(&path, JobFormat::Sql, Engine::Postgres, &expected).unwrap();
    assert_eq!(review.inspection.item_count, Some(1));
    assert_eq!(review.sql_audit.unwrap().write_count, 1);

    std::fs::write(&path, "DELETE FROM items;").unwrap();
    assert!(matches!(
        review_input_verified(&path, JobFormat::Sql, Engine::Postgres, &expected),
        Err(AppError::Blocked { .. })
    ));
}

#[test]
fn error_artifact_rows_and_messages_are_bounded() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("errors.ndjson");
    let mut writer = create_error_writer(&path, false).unwrap();
    write_error_row(
        &mut writer,
        7,
        &Value::String("x".repeat(MAX_ERROR_ROW_BYTES + 1)),
        &"e".repeat(MAX_ERROR_MESSAGE_CHARS + 100),
    )
    .unwrap();
    finalize_error_writer(writer).unwrap();

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    let artifact: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(artifact["row"]["truncated"], true);
    assert_eq!(
        artifact["error"].as_str().unwrap().chars().count(),
        MAX_ERROR_MESSAGE_CHARS
    );
    assert!(artifact["row"]["sha256"].as_str().unwrap().len() == 64);
}

#[cfg(unix)]
#[test]
fn input_reader_does_not_follow_symlinks() {
    use std::os::unix::fs::symlink;

    let directory = tempfile::tempdir().unwrap();
    let target = directory.path().join("target.csv");
    let link = directory.path().join("link.csv");
    std::fs::write(&target, "id\n1\n").unwrap();
    symlink(&target, &link).unwrap();
    assert!(file_sha256(&link).is_err());
}
