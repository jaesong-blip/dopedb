//! Focused hosted-provider authority adapter tests.

use super::{
    append_bounded_inventory_body, bounded_inventory_body_capacity, parse_integration,
    parse_inventory_body, read_bounded_inventory_body, RemoteIntegration, RemoteVerificationTarget,
    MAX_INVENTORY_BODY_BYTES,
};
use reqwest::{redirect::Policy, Client, Response};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

async fn local_response(raw: Vec<u8>) -> Response {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind inventory fixture");
    let address = listener.local_addr().expect("fixture address");
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.expect("accept inventory fixture");
        let mut request = Vec::with_capacity(1024);
        while !request.windows(4).any(|window| window == b"\r\n\r\n") {
            assert!(
                request.len() < 16 * 1024,
                "inventory fixture request exceeds the test cap"
            );
            let mut chunk = [0_u8; 1024];
            let read = stream
                .read(&mut chunk)
                .await
                .expect("read inventory fixture request");
            assert_ne!(read, 0, "inventory fixture request ended before headers");
            request.extend_from_slice(&chunk[..read]);
        }
        stream
            .write_all(&raw)
            .await
            .expect("write inventory fixture");
        stream.flush().await.expect("flush inventory fixture");
        stream.shutdown().await.expect("close inventory fixture");
    });
    let response = Client::builder()
        .redirect(Policy::none())
        .build()
        .expect("fixture client")
        .get(format!("http://{address}/inventory"))
        .send()
        .await
        .expect("get inventory fixture");
    server.await.expect("join inventory fixture");
    response
}

#[test]
fn inventory_body_cap_rejects_declared_or_streamed_oversize_without_trusting_headers() {
    assert!(bounded_inventory_body_capacity(Some(MAX_INVENTORY_BODY_BYTES as u64 + 1)).is_err());
    assert_eq!(bounded_inventory_body_capacity(None).unwrap(), 0);

    let mut body = Vec::new();
    append_bounded_inventory_body(&mut body, &vec![b'x'; MAX_INVENTORY_BODY_BYTES])
        .expect("an exact-sized streamed chunk is retained");
    assert_eq!(body.len(), MAX_INVENTORY_BODY_BYTES);
    assert!(append_bounded_inventory_body(&mut body, b"x").is_err());

    // A missing or false small Content-Length follows the same chunk cap.
    let mut missing_length_body = Vec::new();
    append_bounded_inventory_body(
        &mut missing_length_body,
        &vec![b'x'; MAX_INVENTORY_BODY_BYTES - 1],
    )
    .unwrap();
    assert!(append_bounded_inventory_body(&mut missing_length_body, b"xx").is_err());
}

#[tokio::test]
async fn inventory_reader_enforces_content_length_and_streaming_caps() {
    Box::pin(crate::features::providers::provisioning::assert_repository_fences()).await;
    Box::pin(crate::features::providers::provisioning::assert_process_boundary()).await;
    Box::pin(crate::features::providers::provisioning::assert_restart_resume_lifecycle()).await;
    Box::pin(crate::features::providers::provisioning::assert_live_gcloud_inventory()).await;

    let declared_oversize = local_response(
        format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            MAX_INVENTORY_BODY_BYTES + 1
        )
        .into_bytes(),
    )
    .await;
    assert!(read_bounded_inventory_body(declared_oversize)
        .await
        .is_err());

    let streamed_oversize = local_response(
        format!(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{0:X}\r\n{1}\r\n1\r\nx\r\n0\r\n\r\n",
            MAX_INVENTORY_BODY_BYTES,
            "x".repeat(MAX_INVENTORY_BODY_BYTES),
        )
        .into_bytes(),
    )
    .await;
    assert!(read_bounded_inventory_body(streamed_oversize)
        .await
        .is_err());

    let exact_body = vec![b' '; MAX_INVENTORY_BODY_BYTES];
    let mut exact_wire = format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        exact_body.len()
    )
    .into_bytes();
    exact_wire.extend_from_slice(&exact_body);
    assert_eq!(
        read_bounded_inventory_body(local_response(exact_wire).await)
            .await
            .expect("exact boundary is accepted"),
        exact_body
    );
}

#[test]
fn inventory_parser_accepts_exact_boundary_and_rejects_truncated_unknown_or_foreign_scope() {
    crate::features::providers::provisioning::assert_gcloud_cli_contract();
    crate::features::providers::provisioning::assert_gcp_driver_contract();
    crate::connection::assert_gcp_mysql_grant_contract();
    crate::features::providers::provisioning::assert_planetscale_cli_contract();
    crate::features::providers::provisioning::assert_planetscale_driver_contract();
    crate::features::providers::provisioning::assert_neon_driver_contract();
    super::super::provisioning_authority::assert_target_projection_contract();
    let mut exact = br#"{"integrations":[]}"#.to_vec();
    exact.resize(MAX_INVENTORY_BODY_BYTES, b' ');
    assert!(parse_inventory_body(&exact).is_ok());

    let secret = "provider-secret-must-not-escape";
    for body in [
        br#"{"integrations":["#.as_slice(),
        br#"{"integrations":[],"providerError":"provider-secret-must-not-escape"}"#.as_slice(),
        br#"{"integrations":[],"workspaceId":"00000000-0000-0000-0000-000000000002"}"#.as_slice(),
    ] {
        let error = match parse_inventory_body(body) {
            Ok(_) => panic!("untrusted inventory is denied"),
            Err(error) => error,
        };
        assert!(!error.to_string().contains(secret));
    }
}

#[test]
fn rejects_untyped_or_non_decimal_remote_inventory() {
    assert!(parse_integration(RemoteIntegration {
        id: "not-a-uuid".into(),
        provider: "neon".into(),
        display_name: "x".into(),
        status: "active".into(),
        generation: "1".into(),
        granted_scope: "projects:1:x".into(),
        reconnect_required: false,
        verification_target: None,
    })
    .is_err());
    assert!(parse_integration(RemoteIntegration {
        id: uuid::Uuid::new_v4().to_string(),
        provider: "neon".into(),
        display_name: "x".into(),
        status: "active".into(),
        generation: "1:stale".into(),
        granted_scope: "projects:1:x".into(),
        reconnect_required: false,
        verification_target: None,
    })
    .is_err());
}

#[test]
fn accepts_only_the_exact_gcp_target_receipt() {
    crate::features::providers::provisioning::assert_mock_provider_lifecycle();

    let base = || RemoteIntegration {
        id: uuid::Uuid::new_v4().to_string(),
        provider: "gcpCloudSql".into(),
        display_name: "GCP read access".into(),
        status: "active".into(),
        generation: "9007199254740993".into(),
        granted_scope: "adcWif".into(),
        reconnect_required: false,
        verification_target: Some(RemoteVerificationTarget::GcpCloudSql {
            project_id: "sample-project-123".into(),
            instance_id: "instance-one".into(),
        }),
    };
    assert!(parse_integration(base()).is_ok());
    let mut missing = base();
    missing.verification_target = None;
    assert!(parse_integration(missing).is_err());
    let mut wrong_scope = base();
    wrong_scope.granted_scope = "adcWif:guessed".into();
    assert!(parse_integration(wrong_scope).is_err());
}

#[test]
fn keeps_legacy_gcp_rows_visible_only_as_reconnect_required() {
    let legacy = RemoteIntegration {
        id: uuid::Uuid::new_v4().to_string(),
        provider: "gcpCloudSql".into(),
        display_name: "GCP read access".into(),
        status: "reconnect_required".into(),
        generation: "7".into(),
        granted_scope: "adcWif".into(),
        reconnect_required: true,
        verification_target: None,
    };
    let parsed = parse_integration(legacy).expect("legacy target is reconnect-only");
    assert_eq!(
        parsed.state,
        crate::features::providers::domain::ProviderIntegrationState::ReconnectRequired
    );
    assert!(parsed.verification_target.is_none());

    let active_without_target = RemoteIntegration {
        status: "active".into(),
        reconnect_required: false,
        ..RemoteIntegration {
            id: uuid::Uuid::new_v4().to_string(),
            provider: "gcpCloudSql".into(),
            display_name: "GCP read access".into(),
            status: "reconnect_required".into(),
            generation: "7".into(),
            granted_scope: "adcWif".into(),
            reconnect_required: true,
            verification_target: None,
        }
    };
    assert!(parse_integration(active_without_target).is_err());
}
