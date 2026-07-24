#![cfg(unix)]

use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::process::{Command, Stdio};
use std::thread;

use chrono::{Duration, Utc};
use dopedb_protocol::{
    decode_frame, encode_frame, parse_frame_length, CatalogArguments, CommandName,
    ConnectionSelector, QueryHealth, QueryPlanArguments, QueryPlanResult, QueryResultPage,
    QueryRunArguments, QueryRunResult, RequestEnvelope, ResponseEnvelope, RuntimeDiscovery,
    SchemaListResult, SchemaSummary, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, PROTOCOL_MAX,
    PROTOCOL_MIN,
};
use tempfile::TempDir;
use uuid::Uuid;

fn read_request(stream: &mut UnixStream) -> RequestEnvelope {
    let mut prefix = [0u8; 4];
    stream.read_exact(&mut prefix).unwrap();
    let length = parse_frame_length(prefix, MAX_REQUEST_BYTES).unwrap();
    let mut frame = Vec::from(prefix);
    frame.resize(4 + length, 0);
    stream.read_exact(&mut frame[4..]).unwrap();
    decode_frame(&frame, MAX_REQUEST_BYTES).unwrap()
}

fn respond<T: serde::Serialize>(stream: &mut UnixStream, request: &RequestEnvelope, result: &T) {
    let response = ResponseEnvelope::success(
        request.protocol_version,
        request.request_id,
        serde_json::to_value(result).unwrap(),
    );
    stream
        .write_all(&encode_frame(&response, MAX_RESPONSE_BYTES).unwrap())
        .unwrap();
}

fn terminal_command(runtime_file: &std::path::Path, session_id: Uuid, token: &str) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_dopedb-cli"));
    command
        .env("DOPEDB_RUNTIME_FILE", runtime_file)
        .env("DOPEDB_TERMINAL_SESSION_ID", session_id.to_string())
        .env("DOPEDB_CONNECTION_SCOPE", Uuid::from_u128(7).to_string())
        .env("DOPEDB_SESSION_TOKEN", token)
        .env(
            "DATABASE_URL",
            "postgresql://fixture:must-never-escape@example.invalid/app",
        );
    command
}

#[test]
fn terminal_session_can_read_schema_and_plan_then_run_a_safe_query() {
    let temp = TempDir::new().unwrap();
    let runtime_directory = temp.path().join("runtime");
    fs::create_dir(&runtime_directory).unwrap();
    fs::set_permissions(&runtime_directory, fs::Permissions::from_mode(0o700)).unwrap();
    let runtime_id = Uuid::from_u128(1);
    let runtime_id_text = runtime_id.simple().to_string();
    let endpoint = runtime_directory.join(format!("broker-{}.sock", &runtime_id_text[..16]));
    let listener = UnixListener::bind(&endpoint).unwrap();
    fs::set_permissions(&endpoint, fs::Permissions::from_mode(0o600)).unwrap();
    let runtime_file = runtime_directory.join("runtime.json");
    let discovery = RuntimeDiscovery::new(
        runtime_id,
        std::process::id(),
        "0.3.3",
        PROTOCOL_MIN,
        PROTOCOL_MAX,
        endpoint.to_string_lossy(),
        Utc::now(),
    )
    .unwrap();
    fs::write(&runtime_file, serde_json::to_vec(&discovery).unwrap()).unwrap();
    fs::set_permissions(&runtime_file, fs::Permissions::from_mode(0o600)).unwrap();

    let session_id = Uuid::from_u128(2);
    let connection_id = Uuid::from_u128(7);
    let plan_id = Uuid::from_u128(8);
    let query_run_id = Uuid::from_u128(9);
    let token = "a5".repeat(32);
    let expected_token = token.clone();
    let server = thread::spawn(move || {
        for expected in [
            CommandName::SchemaList,
            CommandName::QueryPlan,
            CommandName::QueryRun,
        ] {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_request(&mut stream);
            assert_eq!(request.command, expected);
            let authentication = request.authentication.as_ref().unwrap();
            assert_eq!(authentication.terminal_session_id, session_id);
            assert_eq!(authentication.token(), expected_token);
            match expected {
                CommandName::SchemaList => {
                    let arguments: CatalogArguments =
                        serde_json::from_value(request.arguments.clone()).unwrap();
                    assert_eq!(arguments.connection, ConnectionSelector::Current);
                    respond(
                        &mut stream,
                        &request,
                        &SchemaListResult {
                            connection_id,
                            schemas: vec![SchemaSummary {
                                name: "main".into(),
                                relation_count: 1,
                                routine_count: 0,
                                object_count: 1,
                            }],
                        },
                    );
                }
                CommandName::QueryPlan => {
                    let arguments: QueryPlanArguments =
                        serde_json::from_value(request.arguments.clone()).unwrap();
                    assert_eq!(arguments.connection, ConnectionSelector::Current);
                    assert_eq!(arguments.sql, "SELECT name FROM users ORDER BY name");
                    respond(
                        &mut stream,
                        &request,
                        &QueryPlanResult {
                            connection_id,
                            connection_name: "fixture".into(),
                            environment: Some("test".into()),
                            plan_id,
                            decision: "allow".into(),
                            notices: Vec::new(),
                            suggestions: Vec::new(),
                            estimated_rows: Some(2),
                            health: QueryHealth {
                                level: "healthy".into(),
                                coverage: "full".into(),
                                total_connections: None,
                                max_connections: None,
                                connection_usage_percent: None,
                                active_queries: None,
                                long_running_queries: None,
                                lock_waits: None,
                                replication_lag_seconds: None,
                                reasons: Vec::new(),
                                captured_at: Utc::now(),
                            },
                            expires_at: Utc::now() + Duration::minutes(5),
                        },
                    );
                }
                CommandName::QueryRun => {
                    let arguments: QueryRunArguments =
                        serde_json::from_value(request.arguments.clone()).unwrap();
                    assert_eq!(arguments.plan_id, plan_id);
                    respond(
                        &mut stream,
                        &request,
                        &QueryRunResult {
                            connection_id,
                            connection_name: "fixture".into(),
                            plan_id,
                            query_run_id,
                            planning_decision: "allow".into(),
                            result: QueryResultPage {
                                columns: vec!["name".into()],
                                rows: vec![
                                    vec![serde_json::json!("Ada")],
                                    vec![serde_json::json!("Linus")],
                                ],
                                row_count: 2,
                                truncated: false,
                                duration_ms: 1,
                            },
                        },
                    );
                }
                _ => unreachable!(),
            }
        }
    });

    let schema = terminal_command(&runtime_file, session_id, &token)
        .args(["schema", "list", "--connection", "current", "--json"])
        .output()
        .unwrap();
    assert!(schema.status.success());
    assert!(schema.stderr.is_empty());
    let schema: SchemaListResult = serde_json::from_slice(&schema.stdout).unwrap();
    assert_eq!(schema.schemas[0].name, "main");

    let mut plan_child = terminal_command(&runtime_file, session_id, &token)
        .args([
            "query",
            "plan",
            "--connection",
            "current",
            "--file",
            "-",
            "--json",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    plan_child
        .stdin
        .take()
        .unwrap()
        .write_all(b"SELECT name FROM users ORDER BY name")
        .unwrap();
    let planned = plan_child.wait_with_output().unwrap();
    assert!(planned.status.success());
    assert!(planned.stderr.is_empty());
    let planned: QueryPlanResult = serde_json::from_slice(&planned.stdout).unwrap();
    assert_eq!(planned.plan_id, plan_id);

    let run = terminal_command(&runtime_file, session_id, &token)
        .args(["query", "run", "--plan", &plan_id.to_string(), "--json"])
        .output()
        .unwrap();
    server.join().unwrap();
    assert!(run.status.success());
    assert!(run.stderr.is_empty());
    let serialized = String::from_utf8(run.stdout).unwrap();
    assert!(!serialized.contains(&token));
    assert!(!serialized.contains("must-never-escape"));
    let run: QueryRunResult = serde_json::from_str(&serialized).unwrap();
    assert_eq!(run.query_run_id, query_run_id);
    assert_eq!(run.result.row_count, 2);
}
