use super::*;

#[test]
fn synthesize_ddl_covers_pk_fk_index() {
    let t = Table {
        schema: Some("public".into()),
        name: "orders".into(),
        kind: "table".into(),
        columns: vec![
            Column {
                name: "id".into(),
                data_type: "integer".into(),
                nullable: false,
                pk: true,
                ..Column::default()
            },
            Column {
                name: "user_id".into(),
                data_type: "integer".into(),
                nullable: false,
                pk: false,
                ..Column::default()
            },
            Column {
                name: "note".into(),
                data_type: "text".into(),
                nullable: true,
                pk: false,
                ..Column::default()
            },
        ],
        foreign_keys: vec![ForeignKey {
            column: "user_id".into(),
            references_table: "users".into(),
            references_column: "id".into(),
            references_schema: Some("public".into()),
            ..ForeignKey::default()
        }],
        indexes: vec![Index {
            name: "idx_orders_user".into(),
            columns: vec!["user_id".into()],
            unique: false,
            ..Index::default()
        }],
        row_estimate: None,
        ..Table::default()
    };
    let ddl = synthesize_ddl(&t);
    assert!(ddl.contains("CREATE TABLE \"public\".\"orders\""));
    assert!(ddl.contains("\"id\" integer NOT NULL"));
    assert!(ddl.contains("\"note\" text\n") || ddl.contains("\"note\" text,"));
    assert!(ddl.contains("PRIMARY KEY (\"id\")"));
    assert!(ddl.contains("FOREIGN KEY (\"user_id\") REFERENCES \"public\".\"users\" (\"id\")"));
    assert!(
        ddl.contains("CREATE INDEX \"idx_orders_user\" ON \"public\".\"orders\" (\"user_id\");")
    );
}

#[test]
fn object_catalog_selects_the_server_compatible_pg_proc_shape() {
    assert!(objects_sql_for_version(100_000).contains("proisagg"));
    assert!(!objects_sql_for_version(100_000).contains("p.prokind"));
    assert!(objects_sql_for_version(110_000).contains("p.prokind"));
    assert!(objects_sql_for_version(170_000).contains("'pg_proc'::regclass"));
}

#[test]
fn relation_overview_is_a_bounded_pg_catalog_query() {
    assert!(RELATIONS_SQL.contains("FROM pg_class c"));
    assert!(RELATIONS_SQL.contains("c.relkind IN ('r', 'p', 'v', 'm', 'f')"));
    assert!(RELATIONS_SQL.contains("c.relkind IN ('r', 'p', 'f')"));
    assert!(!RELATIONS_SQL.contains("FROM information_schema"));
}

#[test]
fn foreign_tables_remain_in_overview_and_complete_catalog_scans() {
    // Both the unpersisted workspace/sidebar overview and the cacheable full catalog
    // derive their relation tree from RELATIONS_SQL; full detail columns use COLS_SQL.
    assert!(RELATIONS_SQL.contains("'f'"));
    assert!(COLS_SQL.contains("c.relkind IN ('r', 'p', 'v', 'm', 'f')"));
    // `relation_overview_from_row` maps every non-view relation to the wire-compatible
    // `table` kind, so foreign tables require no unsupported protocol kind.
    assert!(RELATIONS_SQL.contains("ELSE 'BASE TABLE'"));
}

#[test]
fn columns_use_pg_catalog_and_preserve_type_dimensions() {
    assert!(COLS_SQL.contains("FROM pg_attribute a"));
    assert!(COLS_SQL.contains("information_schema._pg_char_max_length"));
    assert!(COLS_SQL.contains("information_schema._pg_numeric_precision"));
    assert!(COLS_SQL.contains("information_schema._pg_numeric_scale"));
    assert!(COLS_SQL.contains("a.attnum::integer AS ordinal_position"));
    assert!(COLS_LEGACY_SQL.contains("a.attnum::integer AS ordinal_position"));
    assert!(!COLS_SQL.contains("is_pk"));
    assert!(CONSTRAINTS_SQL.contains("con.contype IN ('p', 'u', 'c')"));
    assert!(
        CONSTRAINTS_SQL.contains("con.contype::text AS constraint_type"),
        "PostgreSQL internal \"char\" values must be cast before String decoding"
    );
}

#[test]
fn columns_query_uses_identity_only_when_the_server_supports_it() {
    assert!(columns_sql_for_version(100_000).contains("a.attidentity <> ''"));
    assert!(columns_sql_for_version(96_000).contains("false AS is_identity"));
    assert!(!columns_sql_for_version(96_000).contains("a.attidentity"));
}

#[test]
fn only_local_statement_timeout_is_reclassified() {
    assert!(is_statement_timeout_details(
        Some("57014"),
        "canceling statement due to statement timeout"
    ));
    assert!(!is_statement_timeout_details(
        Some("57014"),
        "canceling statement due to user request"
    ));
    assert!(!is_statement_timeout_details(
        Some("42P01"),
        "canceling statement due to statement timeout"
    ));
}

#[test]
fn detail_deadlines_are_bounded_and_timeout_errors_are_non_retryable() {
    assert_eq!(adaptive_detail_stage_timeout(0), DETAIL_STAGE_MIN_TIMEOUT);
    assert_eq!(
        adaptive_detail_stage_timeout(usize::MAX),
        DETAIL_STAGE_MAX_TIMEOUT
    );
    assert_eq!(
        adaptive_detail_stage_timeout(112),
        Duration::from_millis(12_800)
    );
    assert!(remaining_detail_timeout(Instant::now(), 1).is_some());
    assert!(remaining_detail_timeout(Instant::now() - DETAIL_SCAN_BUDGET, 1).is_none());
    let error = catalog_stage_timeout(
        "indexes",
        Duration::from_millis(777),
        Duration::from_secs(20),
    );
    assert_eq!(error.kind(), "timeout");
    assert_eq!(error.to_string(), "timeout: PostgreSQL catalog indexes metadata timed out after 777 ms (limit 20000 ms); retry schema loading");
}
