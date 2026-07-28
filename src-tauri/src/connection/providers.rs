//! Per-provider connection-string normalization. We do NOT bundle any external CA files — a custom CA can be
//! supplied per connection via `extra_params["sslrootcert"]` (documented, not shipped).

use std::time::Duration;

use sqlx::mysql::{MySqlConnectOptions, MySqlSslMode};
use sqlx::postgres::PgConnectOptions;

use crate::model::{ConnectionProfile, Engine, Provider};

/// Classify a profile by host. Cheap substring match — hosts are provider-fixed.
pub fn detect(p: &ConnectionProfile) -> Provider {
    let h = p.host.to_ascii_lowercase();
    if h.contains("neon.tech") {
        Provider::Neon
    } else if h.contains("psdb.cloud") {
        Provider::PlanetScale
    } else if h.ends_with(".sql.goog")
        || h.ends_with(".sql-psa.goog")
        || h.ends_with(".sql-psc.goog")
    {
        Provider::GcpCloudSql
    } else {
        Provider::Generic
    }
}

/// Resolve `Auto` to a concrete provider without conflating that provider with an engine.
pub fn resolve(p: &ConnectionProfile) -> Provider {
    match p.provider {
        Provider::Auto => detect(p),
        explicit => explicit,
    }
}

/// PlanetScale/Vitess is sharded — its FK metadata in `information_schema` is
/// unreliable, so introspection skips it.
pub fn skip_fk_metadata(p: &ConnectionProfile) -> bool {
    p.engine == Engine::Mysql && resolve(p) == Provider::PlanetScale
}

/// Pool acquire timeout. Neon scales to zero, so cold connects need slack.
pub fn connect_timeout(p: &ConnectionProfile) -> Duration {
    match resolve(p) {
        Provider::Neon | Provider::GcpCloudSql => Duration::from_secs(30),
        _ => Duration::from_secs(15),
    }
}

/// Apply Postgres per-provider tuning to freshly-built connect options.
pub fn apply_pg_tuning(p: &ConnectionProfile, mut opts: PgConnectOptions) -> PgConnectOptions {
    if p.host.to_ascii_lowercase().contains("pooler.supabase.com") {
        // Supavisor transaction mode multiplexes server-side prepared statements;
        // client-side statement caching breaks connections → disable it.
        opts = opts.statement_cache_capacity(0);
    }
    // Neon negotiates channel_binding via SCRAM automatically; its cold-start
    // penalty is handled by connect_timeout(), not an option here.

    // Custom CA (e.g. RDS global CA, ISRG roots) — user-supplied, never bundled.
    if let Some(ca) = p.extra_params.get("sslrootcert") {
        opts = opts.ssl_root_cert(ca);
    }
    if let Some(ca) = p.extra_params.get("sslrootcert_pem") {
        opts = opts.ssl_root_cert_from_pem(ca.as_bytes().to_vec());
    }
    if let Some(cert) = p.extra_params.get("sslcert") {
        opts = opts.ssl_client_cert(cert);
    }
    if let Some(cert) = p.extra_params.get("sslcert_pem") {
        opts = opts.ssl_client_cert_from_pem(cert.as_bytes());
    }
    if let Some(key) = p.extra_params.get("sslkey") {
        opts = opts.ssl_client_key(key);
    }
    if let Some(key) = p.extra_params.get("sslkey_pem") {
        opts = opts.ssl_client_key_from_pem(key.as_bytes());
    }
    opts
}

/// Apply MySQL per-provider tuning.
pub fn apply_mysql_tuning(
    p: &ConnectionProfile,
    mut opts: MySqlConnectOptions,
) -> MySqlConnectOptions {
    if resolve(p) == Provider::PlanetScale {
        // PlanetScale requires TLS with identity verification.
        opts = opts.ssl_mode(MySqlSslMode::VerifyIdentity);
    }
    if let Some(ca) = p.extra_params.get("sslrootcert") {
        opts = opts.ssl_ca(ca);
    }
    if let Some(ca) = p.extra_params.get("sslrootcert_pem") {
        opts = opts.ssl_ca_from_pem(ca.as_bytes().to_vec());
    }
    if let Some(cert) = p.extra_params.get("sslcert") {
        opts = opts.ssl_client_cert(cert);
    }
    if let Some(cert) = p.extra_params.get("sslcert_pem") {
        opts = opts.ssl_client_cert_from_pem(cert.as_bytes());
    }
    if let Some(key) = p.extra_params.get("sslkey") {
        opts = opts.ssl_client_key(key);
    }
    if let Some(key) = p.extra_params.get("sslkey_pem") {
        opts = opts.ssl_client_key_from_pem(key.as_bytes());
    }
    if resolve(p) == Provider::GcpCloudSql
        && matches!(
            p.sslmode.as_str(),
            "verify-ca" | "verify-full" | "verify-identity"
        )
        && p.extra_params.contains_key("sslrootcert_pem")
    {
        // Cloud SQL IAM authentication uses mysql_clear_password only inside the
        // CA-verified TLS tunnel assembled from the one-time lease response.
        opts = opts.enable_cleartext_plugin(true);
    }
    opts
}
