use super::*;

pub(crate) fn assert_planetscale_cli_contract() {
    let classified = [
        ProvisioningProcessFailure::AuthenticationRequired,
        ProvisioningProcessFailure::MultiFactorRequired,
        ProvisioningProcessFailure::PermissionDenied,
        ProvisioningProcessFailure::RateLimited,
        ProvisioningProcessFailure::NetworkUnavailable,
    ]
    .map(|failure| process_error(failure).to_string());
    assert_eq!(
        classified
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        classified.len()
    );
    assert_eq!(
        parse_version(&serde_json::json!({
            "version": "v0.308.0",
            "commit": "855a3174d5c61abc4363b34bf966ed5032a416a5",
            "build_date": "2026-07-31T00:00:00Z"
        }))
        .unwrap(),
        MINIMUM_PSCALE_VERSION,
    );
    assert_eq!(
        compare_versions("0.307.0", MINIMUM_PSCALE_VERSION).unwrap(),
        std::cmp::Ordering::Less,
    );
    assert!(parse_version(&serde_json::json!({
        "version": "v0.308.0", "commit": "x", "build_date": "x", "token": "secret"
    }))
    .is_err());

    let auth = parse_auth_check(&serde_json::json!({
        "status": "ok",
        "authenticated": true,
        "auth_method": "oauth",
        "organization": "acme",
        "api_url": "cli-selected-endpoint",
        "agent_guide_command": "pscale agent-guide --format json",
        "next_steps": ["pscale database list --org acme --format json"]
    }))
    .unwrap();
    assert!(auth.authenticated);
    assert_eq!(auth.organization.as_deref(), Some("acme"));
    let oversized_api_metadata = "x".repeat(513);
    assert!(parse_auth_check(&serde_json::json!({
        "status": "ok",
        "authenticated": true,
        "auth_method": "oauth",
        "organization": "acme",
        "api_url": oversized_api_metadata,
        "agent_guide_command": "pscale agent-guide --format json"
    }))
    .is_err());

    let organizations = parse_organizations(&serde_json::json!([{
        "name": "acme", "created_at": 1, "updated_at": 2, "current": true
    }]))
    .unwrap();
    assert_eq!(organizations[0].name, "acme");

    let database = parse_database(&serde_json::json!({
        "name": "app", "kind": "postgresql", "state": "ready",
        "notes": "", "region": {"slug": "us-east"},
        "html_url": "https://app.planetscale.com/acme/app",
        "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z"
    }))
    .unwrap();
    assert_eq!(database.engine, Engine::Postgres);
    assert!(parse_database(&serde_json::json!({
        "name": "app", "kind": "mysql", "state": "ready", "password": "must-not-project"
    }))
    .is_err());

    let mysql = parse_branch(
        &serde_json::json!({
            "id": "br-main-123", "name": "main", "ready": true,
            "production": true, "safe_migrations": true,
            "actor": {"id": "user-1"}, "region": {"slug": "us-east"}
        }),
        Engine::Mysql,
    )
    .unwrap();
    assert_eq!(mysql.safe_migrations, Some(true));
    let postgres = parse_branch(
        &serde_json::json!({
            "id": "br-main-456", "name": "main", "ready": true,
            "production": false, "state": "ready"
        }),
        Engine::Postgres,
    )
    .unwrap();
    assert_eq!(postgres.safe_migrations, None);
    assert!(parse_branch(
        &serde_json::json!({
            "id": "br-main-456", "name": "main", "ready": true,
            "production": false, "access_token": "must-not-project"
        }),
        Engine::Postgres
    )
    .is_err());
}
