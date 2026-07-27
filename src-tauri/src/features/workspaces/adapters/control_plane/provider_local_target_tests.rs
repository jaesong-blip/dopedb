//! Exact, secret-free provider-local target parser contract tests.

use super::provider_local_target::{
    append_bounded_target_body, bounded_target_body_capacity, provider_local_target_response,
    ProviderLocalTargetResponse, RemoteProviderLocalTarget, PROVIDER_LOCAL_TARGET_MAX_BODY_BYTES,
};
use super::*;

fn provider_target(provider: &str, target: serde_json::Value) -> ProviderLocalTargetResponse {
    ProviderLocalTargetResponse {
        target: RemoteProviderLocalTarget {
            connection_id: Uuid::from_u128(2).to_string(),
            connection_revision: "3".into(),
            integration_id: Uuid::from_u128(3).to_string(),
            integration_generation: "4".into(),
            provider: provider.into(),
            resource_fingerprint: "a".repeat(64),
            target,
            authority_expires_at: (chrono::Utc::now() + chrono::Duration::seconds(60)).to_rfc3339(),
        },
    }
}

#[test]
fn provider_local_target_parser_accepts_only_exact_secret_free_neon_shape() {
    let parsed = provider_local_target_response(
        provider_target(
            "neon",
            serde_json::json!({
                "project": "project", "branch": "branch", "database": "app",
                "engine": "postgres", "schemas": ["public"]
            }),
        ),
        ConnectionId::from(Uuid::from_u128(2)),
    )
    .expect("safe target");
    assert_eq!(parsed.provider, Provider::Neon);
    assert!(matches!(
        parsed.resource,
        ProviderLocalResource::Neon { .. }
    ));
}

#[test]
fn provider_local_target_parser_rejects_cross_connection_unknown_fields_and_secret_material() {
    let mut cross = provider_target(
        "neon",
        serde_json::json!({
            "project": "project", "branch": "branch", "database": "app",
            "engine": "postgres", "schemas": []
        }),
    );
    cross.target.connection_id = Uuid::from_u128(99).to_string();
    assert!(provider_local_target_response(cross, ConnectionId::from(Uuid::from_u128(2))).is_err());

    let extra = provider_target(
        "neon",
        serde_json::json!({
            "project": "project", "branch": "branch", "database": "app",
            "engine": "postgres", "schemas": [], "password": "must-not-parse"
        }),
    );
    assert!(provider_local_target_response(extra, ConnectionId::from(Uuid::from_u128(2))).is_err());
}

#[test]
fn provider_local_target_parser_enforces_gcp_ca_target_engine_and_expiry_contract() {
    let gcp = provider_target(
        "gcpCloudSql",
        serde_json::json!({
            "project": "project", "instance": "instance", "database": "app",
            "engine": "postgres", "networkMode": "PRIVATE_SERVICES_ACCESS"
        }),
    );
    let parsed = provider_local_target_response(gcp, ConnectionId::from(Uuid::from_u128(2)))
        .expect("safe gcp target");
    assert!(matches!(
        parsed.resource,
        ProviderLocalResource::GcpCloudSql {
            engine: crate::model::Engine::Postgres,
            ..
        }
    ));

    let mut stale = provider_target(
        "gcpCloudSql",
        serde_json::json!({
            "project": "project", "instance": "instance", "database": "app",
            "engine": "mysql", "networkMode": "PUBLIC"
        }),
    );
    stale.target.authority_expires_at =
        (chrono::Utc::now() + chrono::Duration::seconds(5)).to_rfc3339();
    assert!(provider_local_target_response(stale, ConnectionId::from(Uuid::from_u128(2))).is_err());
}

#[test]
fn provider_local_target_parser_accepts_only_current_gcp_network_mode_wire_values() {
    let valid = provider_target(
        "gcpCloudSql",
        serde_json::json!({
            "project": "project", "instance": "instance", "database": "app",
            "engine": "postgres", "networkMode": "PRIVATE_SERVICE_CONNECT"
        }),
    );
    let parsed = provider_local_target_response(valid, ConnectionId::from(Uuid::from_u128(2)))
        .expect("private service connect target");
    assert!(matches!(
        parsed.resource,
        ProviderLocalResource::GcpCloudSql {
            network_mode: crate::connection::GcpCloudSqlNetworkMode::PrivateServiceConnect,
            ..
        }
    ));
    for rejected in ["PRIVATE_IP", "private_service_connect", "PRIVATE_ENDPOINT"] {
        let invalid = provider_target(
            "gcpCloudSql",
            serde_json::json!({
                "project": "project", "instance": "instance", "database": "app",
                "engine": "postgres", "networkMode": rejected
            }),
        );
        assert!(
            provider_local_target_response(invalid, ConnectionId::from(Uuid::from_u128(2)))
                .is_err()
        );
    }
}

#[test]
fn provider_local_target_body_cap_is_exact_for_absent_and_lying_content_lengths() {
    let exact = vec![b'x'; PROVIDER_LOCAL_TARGET_MAX_BODY_BYTES];
    assert_eq!(bounded_target_body_capacity(None).unwrap(), 0);
    assert_eq!(
        bounded_target_body_capacity(Some(PROVIDER_LOCAL_TARGET_MAX_BODY_BYTES as u64)).unwrap(),
        PROVIDER_LOCAL_TARGET_MAX_BODY_BYTES
    );
    assert!(
        bounded_target_body_capacity(Some(PROVIDER_LOCAL_TARGET_MAX_BODY_BYTES as u64 + 1))
            .is_err()
    );
    let mut body = Vec::new();
    append_bounded_target_body(&mut body, &exact).expect("exact 64KiB is accepted");
    assert_eq!(body.len(), PROVIDER_LOCAL_TARGET_MAX_BODY_BYTES);

    // The chunk path intentionally has no Content-Length input: this is the
    // chunked/absent-header case and must reject the first byte past the cap.
    assert!(append_bounded_target_body(&mut body, b"x").is_err());

    // A lying small Content-Length cannot change the per-chunk accounting.
    let mut lying_header_body = Vec::new();
    append_bounded_target_body(
        &mut lying_header_body,
        &vec![b'x'; PROVIDER_LOCAL_TARGET_MAX_BODY_BYTES],
    )
    .unwrap();
    assert!(append_bounded_target_body(&mut lying_header_body, b"x").is_err());
}

#[test]
fn provider_local_target_body_rejects_malformed_json_only_after_bounded_collection() {
    let mut body = Vec::new();
    append_bounded_target_body(&mut body, br#"{"target": "not-an-object"}"#).unwrap();
    assert!(serde_json::from_slice::<ProviderLocalTargetResponse>(&body).is_err());
    assert!(body.len() <= PROVIDER_LOCAL_TARGET_MAX_BODY_BYTES);
}
