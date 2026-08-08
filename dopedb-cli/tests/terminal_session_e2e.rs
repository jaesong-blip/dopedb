#[cfg(unix)]
#[rustfmt::skip]
mod platform {

use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::{symlink, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration as StdDuration, Instant};

use chrono::{Duration, Utc};
use dopedb_protocol::{
    decode_frame, encode_frame, parse_frame_length, AgentSessionRegisterArguments,
    CatalogArguments, CatalogContents, CatalogSearchArguments, CatalogSearchMatch,
    CatalogSearchMatchType, CatalogSearchResult, CatalogSnapshot, Column, CommandName,
    ConnectionSelector, DatabaseEngine, EmptyArguments, NormalizedTypeFamily, ObjectKind,
    AcpPluginId, ObjectRef, QueryHealth, QueryPlanArguments, QueryPlanResult,
    QueryResultPage, QueryRunArguments, QueryRunResult, Relation, RequestEnvelope,
    ResponseEnvelope, RuntimeDiscovery, SchemaListResult, SchemaSummary, MAX_REQUEST_BYTES,
    MAX_RESPONSE_BYTES, PROTOCOL_MAX, PROTOCOL_MIN,
};
use sha2::{Digest, Sha256};
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

fn process_bound_agent_command(runtime_file: &std::path::Path, session_id: Uuid) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_dopedb-agent-bridge"));
    command
        .env("DOPEDB_RUNTIME_FILE", runtime_file)
        .env("DOPEDB_TERMINAL_SESSION_ID", session_id.to_string())
        .env("DOPEDB_CONNECTION_SCOPE", Uuid::from_u128(7).to_string())
        .env("DOPEDB_AGENT_PROCESS_BOUND", "1")
        .env_remove("DOPEDB_SESSION_TOKEN")
        .env(
            "DATABASE_URL",
            "postgresql://fixture:must-never-escape@example.invalid/app",
        );
    command
}

fn agent_bridge_messages(
    runtime_file: &std::path::Path,
    session_id: Uuid,
    messages: &[serde_json::Value],
) -> Vec<serde_json::Value> {
    let mut child = process_bound_agent_command(runtime_file, session_id)
        .arg("mcp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    for message in messages {
        serde_json::to_writer(&mut input, message).unwrap();
        input.write_all(b"\n").unwrap();
    }
    drop(input);
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn users_catalog(connection_id: Uuid) -> CatalogSnapshot {
    CatalogSnapshot::capture(
        connection_id,
        DatabaseEngine::Postgres,
        "app",
        Utc::now(),
        CatalogContents {
            relations: vec![Relation {
                object: ObjectRef {
                    catalog: Some("app".into()),
                    namespace: Some("public".into()),
                    name: "users".into(),
                    kind: ObjectKind::Table,
                    native_id: None,
                },
                comment: Some("Application user accounts".into()),
                row_estimate: Some(42),
                partition_parent: None,
                partition_children: Vec::new(),
                columns: vec![
                    Column {
                        name: "id".into(),
                        ordinal: 1,
                        native_type: "bigint".into(),
                        type_family: NormalizedTypeFamily::Integer,
                        length: None,
                        precision: None,
                        scale: None,
                        nullable: false,
                        default_expression: None,
                        generated_expression: None,
                        identity: true,
                        auto_increment: true,
                        collation: None,
                        comment: None,
                        sensitivity: None,
                    },
                    Column {
                        name: "deleted_at".into(),
                        ordinal: 2,
                        native_type: "timestamp with time zone".into(),
                        type_family: NormalizedTypeFamily::Timestamp,
                        length: None,
                        precision: None,
                        scale: None,
                        nullable: true,
                        default_expression: None,
                        generated_expression: None,
                        identity: false,
                        auto_increment: false,
                        collation: None,
                        comment: Some("Soft deletion timestamp".into()),
                        sensitivity: None,
                    },
                ],
                constraints: Vec::new(),
                indexes: Vec::new(),
            }],
            ..CatalogContents::default()
        },
    )
    .unwrap()
}

pub(super) fn run() {
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
    let sql = "SELECT COUNT(*) AS total_users FROM public.users";
    let (cancel_started_tx, cancel_started_rx) = mpsc::channel();
    let server = thread::spawn(move || {
        for expected in [
            CommandName::SchemaList,
            CommandName::CatalogSearch,
            CommandName::QueryPlan,
            CommandName::QueryRun,
        ] {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_request(&mut stream);
            assert_eq!(request.command, expected);
            let authentication = request.authentication.as_ref().unwrap();
            assert_eq!(authentication.terminal_session_id, session_id);
            assert!(authentication.token().is_none());
            assert!(serde_json::to_value(authentication)
                .unwrap()
                .get("token")
                .is_none());
            match expected {
                CommandName::SchemaList => {
                    let arguments: CatalogArguments =
                        serde_json::from_value(request.arguments.clone()).unwrap();
                    assert_eq!(arguments.connection, ConnectionSelector::Current);
                    assert_eq!(arguments.database.as_deref(), Some("app"));
                    respond(
                        &mut stream,
                        &request,
                        &SchemaListResult {
                            connection_id,
                            database: "app".into(),
                            schemas: vec![SchemaSummary {
                                name: "public".into(),
                                relation_count: 1,
                                routine_count: 0,
                                object_count: 1,
                            }],
                        },
                    );
                }
                CommandName::CatalogSearch => {
                    let arguments: CatalogSearchArguments =
                        serde_json::from_value(request.arguments.clone()).unwrap();
                    assert_eq!(arguments.connection, ConnectionSelector::Current);
                    assert_eq!(arguments.database.as_deref(), Some("app"));
                    assert_eq!(arguments.query, "user");
                    assert_eq!(arguments.kinds, vec![ObjectKind::Table]);
                    assert_eq!(arguments.limit, Some(20));
                    let catalog = users_catalog(connection_id);
                    respond(
                        &mut stream,
                        &request,
                        &CatalogSearchResult {
                            connection_id,
                            engine: catalog.engine(),
                            database: catalog.database().into(),
                            captured_at: catalog.captured_at(),
                            fingerprint: catalog.fingerprint().into(),
                            query: arguments.query,
                            total_matches: 1,
                            truncated: false,
                            matches: vec![CatalogSearchMatch {
                                match_type: CatalogSearchMatchType::Relation,
                                qualified_name: "app.public.users".into(),
                                object: catalog.relations()[0].object.clone(),
                                matched_fields: vec!["deleted_at".into()],
                            }],
                        },
                    );
                }
                CommandName::QueryPlan => {
                    let arguments: QueryPlanArguments =
                        serde_json::from_value(request.arguments.clone()).unwrap();
                    assert_eq!(arguments.connection, ConnectionSelector::Current);
                    assert_eq!(arguments.database.as_deref(), Some("app"));
                    assert_eq!(arguments.sql, sql);
                    respond(
                        &mut stream,
                        &request,
                        &QueryPlanResult {
                            connection_id,
                            connection_name: "fixture".into(),
                            database: "app".into(),
                            environment: Some("test".into()),
                            plan_id,
                            decision: "ready".into(),
                            notices: Vec::new(),
                            suggestions: Vec::new(),
                            estimated_rows: Some(1),
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
                            database: "app".into(),
                            plan_id,
                            query_run_id,
                            planning_decision: "ready".into(),
                            result: QueryResultPage {
                                columns: vec!["total_users".into()],
                                rows: vec![vec![serde_json::json!(42)]],
                                row_count: 1,
                                truncated: false,
                                duration_ms: 1,
                            },
                        },
                    );
                }
                _ => unreachable!(),
            }
        }

        let (mut stream, _) = listener.accept().unwrap();
        let request = read_request(&mut stream);
        assert_eq!(request.command, CommandName::CatalogSearch);
        let arguments: CatalogSearchArguments =
            serde_json::from_value(request.arguments.clone()).unwrap();
        assert_eq!(arguments.connection, ConnectionSelector::Current);
        assert_eq!(arguments.database.as_deref(), Some("app"));
        assert_eq!(arguments.query, "users");
        cancel_started_tx.send(()).unwrap();

        let mut byte = [0u8; 1];
        match stream.read(&mut byte) {
            Ok(0) => {}
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::UnexpectedEof
                ) => {}
            result => panic!("cancelled Broker request remained open: {result:?}"),
        }
    });

    let bridge = agent_bridge_messages(
        &runtime_file,
        session_id,
        &[
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": { "protocolVersion": "2025-11-25" }
            }),
            serde_json::json!({
                "jsonrpc": "2.0",
                "method": "notifications/initialized"
            }),
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/list",
                "params": {}
            }),
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": { "name": "schema_list", "arguments": { "database": "app" } }
            }),
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": 4,
                "method": "tools/call",
                "params": {
                    "name": "catalog_search",
                    "arguments": { "database": "app", "query": "user", "kinds": ["table"] }
                }
            }),
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": 5,
                "method": "tools/call",
                "params": {
                    "name": "query_read",
                    "arguments": { "database": "app", "sql": sql }
                }
            }),
        ],
    );
    assert_eq!(bridge.len(), 5);
    assert_eq!(bridge[0]["result"]["serverInfo"]["name"], "dopedb");
    let tools = bridge[1]["result"]["tools"].as_array().unwrap();
    assert!(tools.iter().any(|tool| tool["name"] == "catalog_search"));
    assert!(tools.iter().any(|tool| tool["name"] == "query_read"));
    let report_tool = tools
        .iter()
        .find(|tool| tool["name"] == "report_propose")
        .expect("the app-managed MCP bridge must expose report proposals");
    assert_eq!(report_tool["annotations"]["destructiveHint"], false);
    assert_eq!(report_tool["annotations"]["idempotentHint"], false);
    assert_eq!(report_tool["inputSchema"]["additionalProperties"], false);
    assert_eq!(report_tool["inputSchema"]["properties"]["claims"]["maxItems"], 32);
    assert!(report_tool["description"]
        .as_str()
        .unwrap()
        .contains("never reruns SQL"));
    let append_tool = tools
        .iter()
        .find(|tool| tool["name"] == "report_append_evidence")
        .expect("the app-managed MCP bridge must expose immutable evidence append");
    assert_eq!(append_tool["inputSchema"]["additionalProperties"], false);
    assert_eq!(
        append_tool["inputSchema"]["properties"]["expectedRevision"]["minimum"],
        1,
    );
    assert!(append_tool["description"]
        .as_str()
        .unwrap()
        .contains("never edits historical evidence"));
    assert!(!tools.iter().any(|tool| tool["name"] == "run"));

    assert_eq!(bridge[2]["result"]["isError"], false);
    assert_eq!(
        bridge[2]["result"]["structuredContent"]["schemas"][0]["name"],
        "public"
    );
    assert_eq!(bridge[3]["result"]["isError"], false);
    assert_eq!(
        bridge[3]["result"]["structuredContent"]["matches"][0]["qualifiedName"],
        "app.public.users"
    );
    assert_eq!(
        bridge[3]["result"]["structuredContent"]["matches"][0]["matchedFields"][0],
        "deleted_at"
    );
    assert!(bridge[3]["result"]["structuredContent"]["matches"][0]
        .get("relation")
        .is_none());

    assert_eq!(bridge[4]["result"]["isError"], false);
    assert_eq!(
        bridge[4]["result"]["structuredContent"]["plan"]["planId"],
        plan_id.to_string()
    );
    assert_eq!(
        bridge[4]["result"]["structuredContent"]["run"]["result"]["rows"][0][0],
        42
    );
    let serialized = serde_json::to_string(&bridge).unwrap();
    assert!(!serialized.contains("must-never-escape"));

    let mut cancellable = process_bound_agent_command(&runtime_file, session_id)
        .arg("mcp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = cancellable.stdin.take().unwrap();
    for message in [
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": 10,
            "method": "initialize",
            "params": { "protocolVersion": "2025-11-25" }
        }),
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": 11,
            "method": "tools/call",
            "params": {
                "name": "catalog_search",
                "arguments": { "database": "app", "query": "users" }
            }
        }),
    ] {
        serde_json::to_writer(&mut input, &message).unwrap();
        input.write_all(b"\n").unwrap();
    }
    input.flush().unwrap();
    cancel_started_rx
        .recv_timeout(StdDuration::from_secs(3))
        .expect("catalog search must reach the Broker before cancellation");
    serde_json::to_writer(
        &mut input,
        &serde_json::json!({
            "jsonrpc": "2.0",
            "method": "notifications/cancelled",
            "params": { "requestId": 11, "reason": "user cancelled" }
        }),
    )
    .unwrap();
    input.write_all(b"\n").unwrap();
    input.flush().unwrap();
    drop(input);

    let deadline = Instant::now() + StdDuration::from_secs(3);
    let status = loop {
        if let Some(status) = cancellable.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            cancellable.kill().unwrap();
            cancellable.wait().unwrap();
            panic!("the MCP bridge did not stop after its active call was cancelled");
        }
        thread::sleep(StdDuration::from_millis(10));
    };
    assert!(status.success());
    let mut stdout = String::new();
    cancellable
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut stdout)
        .unwrap();
    let mut stderr = String::new();
    cancellable
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut stderr)
        .unwrap();
    assert!(stderr.is_empty());
    let responses = stdout
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(responses.len(), 1);
    assert_eq!(responses[0]["id"], 10);
    assert!(!stdout.contains("must-never-escape"));

    server.join().unwrap();

    // Exercise the token-bearing launcher path in the same critical journey so
    // the fixed test budget does not grow. The fake executable stands in for
    // bundled Node and records only its adapter argument and injected CLI path.
    fs::remove_file(&endpoint).unwrap();
    let launcher_runtime_directory = runtime_directory;
    let launcher_runtime_id = Uuid::from_u128(11);
    let launcher_runtime_id_text = launcher_runtime_id.simple().to_string();
    let launcher_endpoint =
        launcher_runtime_directory.join(format!("broker-{}.sock", &launcher_runtime_id_text[..16]));
    let launcher_listener = UnixListener::bind(&launcher_endpoint).unwrap();
    fs::set_permissions(&launcher_endpoint, fs::Permissions::from_mode(0o600)).unwrap();
    let launcher_runtime_file = launcher_runtime_directory.join("runtime.json");
    let launcher_discovery = RuntimeDiscovery::new(
        launcher_runtime_id,
        std::process::id(),
        env!("CARGO_PKG_VERSION"),
        PROTOCOL_MIN,
        PROTOCOL_MAX,
        launcher_endpoint.to_string_lossy(),
        Utc::now(),
    )
    .unwrap();
    fs::write(
        &launcher_runtime_file,
        serde_json::to_vec(&launcher_discovery).unwrap(),
    )
    .unwrap();
    fs::set_permissions(&launcher_runtime_file, fs::Permissions::from_mode(0o600)).unwrap();

    let launcher_target = temp.path().join("verified-node-target");
    fs::write(
        &launcher_target,
        b"#!/bin/sh\nif env | grep -q '^DOPEDB_SESSION_TOKEN='; then exit 91; fi\nprintf '%s\\n%s\\n%s\\n' \"$1\" \"$CODEX_PATH\" \"$DOPEDB_TERMINAL_SESSION_ID\" > \"$DOPEDB_TEST_LAUNCH_OUTPUT\"\n",
    )
    .unwrap();
    fs::set_permissions(&launcher_target, fs::Permissions::from_mode(0o700)).unwrap();
    let launcher = temp.path().join("verified-node");
    symlink(&launcher_target, &launcher).unwrap();
    let launcher_resolved = fs::canonicalize(&launcher).unwrap();
    let launcher_sha256 = hex::encode(Sha256::digest(fs::read(&launcher_resolved).unwrap()));
    let adapter = temp.path().join("codex-adapter.js");
    fs::write(&adapter, b"verified adapter fixture").unwrap();
    let adapter = fs::canonicalize(adapter).unwrap();
    let adapter_sha256 = hex::encode(Sha256::digest(fs::read(&adapter).unwrap()));
    let provider_cli = temp.path().join("codex");
    fs::write(&provider_cli, b"#!/bin/sh\nexit 0\n").unwrap();
    fs::set_permissions(&provider_cli, fs::Permissions::from_mode(0o700)).unwrap();
    let provider_cli_resolved = fs::canonicalize(&provider_cli).unwrap();
    let provider_cli_sha256 =
        hex::encode(Sha256::digest(fs::read(&provider_cli_resolved).unwrap()));
    let launcher_output = temp.path().join("launcher-output.txt");
    let launcher_session_id = Uuid::from_u128(12);
    let expected_launcher = launcher.to_string_lossy().into_owned();
    let expected_resolved_launcher = launcher_resolved.to_string_lossy().into_owned();
    let expected_sha256 = launcher_sha256.clone();
    let expected_adapter = adapter.to_string_lossy().into_owned();
    let expected_adapter_sha256 = adapter_sha256.clone();
    let expected_provider_cli = provider_cli.to_string_lossy().into_owned();
    let expected_provider_cli_resolved = provider_cli_resolved.to_string_lossy().into_owned();
    let expected_provider_cli_sha256 = provider_cli_sha256.clone();
    let launcher_server = thread::spawn(move || {
        let (mut stream, _) = launcher_listener.accept().unwrap();
        let request = read_request(&mut stream);
        assert_eq!(request.command, CommandName::AgentSessionRegister);
        let authentication = request.authentication.as_ref().unwrap();
        assert_eq!(authentication.terminal_session_id, launcher_session_id);
        assert_eq!(authentication.token(), Some("cd".repeat(32).as_str()));
        let arguments: AgentSessionRegisterArguments =
            serde_json::from_value(request.arguments.clone()).unwrap();
        assert_eq!(arguments.plugin_id, AcpPluginId::Codex);
        assert_eq!(arguments.adapter_bundle_version, "1.0.0");
        assert_eq!(arguments.runtime_executable, expected_launcher);
        assert_eq!(
            arguments.runtime_resolved_executable,
            expected_resolved_launcher
        );
        assert_eq!(arguments.runtime_sha256, expected_sha256);
        assert_eq!(arguments.adapter_entrypoint, expected_adapter);
        assert_eq!(arguments.adapter_entrypoint_sha256, expected_adapter_sha256);
        assert_eq!(arguments.provider_cli_executable, expected_provider_cli);
        assert_eq!(
            arguments.provider_cli_resolved_executable,
            expected_provider_cli_resolved
        );
        assert_eq!(arguments.provider_cli_sha256, expected_provider_cli_sha256);
        respond(&mut stream, &request, &EmptyArguments::default());
    });

    let launcher_status = Command::new(env!("CARGO_BIN_EXE_dopedb-agent-bridge"))
        .args([
            "launch",
            AcpPluginId::Codex.as_str(),
            "1.0.0",
            launcher.to_str().unwrap(),
            launcher_resolved.to_str().unwrap(),
            launcher_sha256.as_str(),
            adapter.to_str().unwrap(),
            adapter_sha256.as_str(),
            provider_cli.to_str().unwrap(),
            provider_cli_resolved.to_str().unwrap(),
            provider_cli_sha256.as_str(),
        ])
        .env("DOPEDB_RUNTIME_FILE", &launcher_runtime_file)
        .env(
            "DOPEDB_TERMINAL_SESSION_ID",
            launcher_session_id.to_string(),
        )
        .env("DOPEDB_SESSION_TOKEN", "cd".repeat(32))
        .env("DOPEDB_TEST_LAUNCH_OUTPUT", &launcher_output)
        .status()
        .unwrap();
    assert!(launcher_status.success());
    launcher_server.join().unwrap();
    let inherited = fs::read_to_string(launcher_output).unwrap();
    assert_eq!(
        inherited.lines().collect::<Vec<_>>(),
        [
            adapter.to_string_lossy().as_ref(),
            provider_cli.to_string_lossy().as_ref(),
            launcher_session_id.to_string().as_str(),
        ]
    );
}

}

#[cfg(windows)]
mod platform {
    use std::fs;

    use dopedb_cli::agent_launch_policy::{adapter_command, take_registration_authentication};
    use dopedb_protocol::{AcpPluginId, AgentSessionRegisterArguments};
    use sha2::{Digest, Sha256};
    use tempfile::TempDir;

    pub(super) fn run() {
        let session_id = uuid::Uuid::from_u128(12);
        let bearer = "cd".repeat(32);
        std::env::set_var("DOPEDB_TERMINAL_SESSION_ID", session_id.to_string());
        std::env::set_var("DOPEDB_SESSION_TOKEN", &bearer);
        let authentication = take_registration_authentication().unwrap();
        assert_eq!(authentication.terminal_session_id, session_id);
        assert_eq!(authentication.token(), Some(bearer.as_str()));
        assert!(std::env::var_os("DOPEDB_SESSION_TOKEN").is_none());
        std::env::remove_var("DOPEDB_TERMINAL_SESSION_ID");

        let temp = TempDir::new().unwrap();
        let launcher = temp.path().join("verified-node.cmd");
        fs::write(&launcher, b"@echo off\r\nexit /b 0\r\n").unwrap();
        let launcher_resolved = fs::canonicalize(&launcher).unwrap();
        let adapter = temp.path().join("claude-adapter.js");
        fs::write(&adapter, b"verified adapter fixture").unwrap();
        let provider_cli = temp.path().join("claude.cmd");
        fs::write(&provider_cli, b"@echo off\r\nexit /b 0\r\n").unwrap();
        let provider_cli_resolved = fs::canonicalize(&provider_cli).unwrap();
        let registration = AgentSessionRegisterArguments {
            plugin_id: AcpPluginId::Claude,
            adapter_bundle_version: "1.0.0".into(),
            runtime_executable: launcher.to_string_lossy().into_owned(),
            runtime_resolved_executable: launcher_resolved.to_string_lossy().into_owned(),
            runtime_sha256: hex::encode(Sha256::digest(fs::read(&launcher_resolved).unwrap())),
            adapter_entrypoint: adapter.to_string_lossy().into_owned(),
            adapter_entrypoint_sha256: hex::encode(Sha256::digest(fs::read(&adapter).unwrap())),
            provider_cli_executable: provider_cli.to_string_lossy().into_owned(),
            provider_cli_resolved_executable: provider_cli_resolved.to_string_lossy().into_owned(),
            provider_cli_sha256: hex::encode(Sha256::digest(
                fs::read(&provider_cli_resolved).unwrap(),
            )),
        };
        let command = adapter_command(&registration).unwrap();
        assert_eq!(command.get_program(), launcher.as_os_str());
        assert_eq!(
            command
                .get_args()
                .map(|argument| argument.to_string_lossy().into_owned())
                .collect::<Vec<_>>(),
            [adapter.to_string_lossy().into_owned()]
        );
        assert!(command.get_envs().any(|(name, value)| {
            name == "CLAUDE_CODE_EXECUTABLE" && value == Some(provider_cli.as_os_str())
        }));
        assert!(command
            .get_envs()
            .any(|(name, value)| { name == "DOPEDB_SESSION_TOKEN" && value.is_none() }));

        let mut changed = registration;
        changed.runtime_sha256 = "00".repeat(32);
        assert!(adapter_command(&changed).is_err());
    }
}

#[test]
fn typed_agent_bridge_searches_catalog_and_pins_the_launcher_security_boundary() {
    platform::run();
}
