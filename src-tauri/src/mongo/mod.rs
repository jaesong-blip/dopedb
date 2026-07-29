//! MongoDB document-database adapter. Deliberately separate from the sqlx pool
//! stack (`connection::pool`): MongoDB has no server-enforced read-only session
//! equivalent to L2, so safety here is structural — data access happens ONLY
//! through the typed [`crate::model::DocumentQuery`] API in [`query`], which
//! calls the driver's `find`/`aggregate`/`count_documents` and never
//! `run_command`. Users are still advised to grant the DB account the `read`
//! role; the client allowlist is not presented as a substitute for it.

pub mod introspect;
pub mod query;

use mongodb::bson::doc;
use mongodb::options::ClientOptions;
use mongodb::Client;

use crate::connection::providers;
use crate::error::{AppError, AppResult};
use crate::model::ConnectionProfile;

/// A live MongoDB client bound to the profile's database. Cheap to clone —
/// `Client` is an `Arc` handle over its own connection pool.
#[derive(Clone)]
pub struct MongoConnection {
    client: Client,
    db_name: String,
}

impl MongoConnection {
    /// The profile's database handle. All reads and introspection scope to it.
    pub fn database(&self) -> mongodb::Database {
        self.client.database(&self.db_name)
    }

    /// Liveness probe. `ping` is a stateless no-op command — the sole
    /// `run_command` in this module; the query path never uses raw commands.
    pub async fn ping(&self) -> AppResult<()> {
        self.database().run_command(doc! { "ping": 1 }).await?;
        Ok(())
    }
}

/// Open (and verify with a ping) a MongoDB connection for `profile`.
pub(crate) async fn connect(
    profile: &ConnectionProfile,
    secret: &str,
) -> AppResult<MongoConnection> {
    let uri = build_uri(profile, secret)?;
    let mut options = ClientOptions::parse(&uri)
        .await
        .map_err(|e| sanitize(e, secret))?;
    let runtime = providers::connection_runtime_options(profile)?;
    options.app_name = Some("DopeDB".into());
    options.server_selection_timeout = Some(providers::connect_timeout(profile));
    options.max_idle_time = runtime.auto_disconnect_timeout;
    let client = Client::with_options(options).map_err(|e| sanitize(e, secret))?;
    let conn = MongoConnection {
        client,
        db_name: profile.database.clone(),
    };
    // The client is lazy; ping so connect fails eagerly like the sqlx pools do.
    conn.ping().await?;
    Ok(conn)
}

/// Assemble a `mongodb://` / `mongodb+srv://` URI from the decomposed profile.
///
/// Conventions (no store schema change needed):
/// - `extra_params["srv"] == "true"` selects the `mongodb+srv` scheme (port unused).
/// - `host` passes through verbatim, so a comma-separated replica-set list or an
///   explicit `host:port` works; the profile port is appended only to a bare host.
/// - Every other `extra_params` entry becomes a URI option (`authSource`,
///   `replicaSet`, `tls`, `tlsCAFile`, …) — the official driver parses/validates.
fn build_uri(profile: &ConnectionProfile, secret: &str) -> AppResult<String> {
    let srv = profile
        .extra_params
        .get("srv")
        .is_some_and(|v| v.trim().eq_ignore_ascii_case("true"));
    let host = profile.host.trim();
    let host = if host.is_empty() { "localhost" } else { host };

    let database = profile.database.trim();
    if database.is_empty() {
        return Err(AppError::Config(
            "MongoDB connections need a database name".into(),
        ));
    }
    if database.contains(['/', '\\', '?', '#', '@', ' ']) {
        return Err(AppError::Config(format!(
            "invalid MongoDB database name {database:?}"
        )));
    }

    let scheme = if srv { "mongodb+srv" } else { "mongodb" };
    let authority = if srv || host.contains(',') || host.contains(':') {
        host.to_string()
    } else {
        format!("{host}:{}", profile.port)
    };

    let mut uri = format!("{scheme}://");
    if !profile.username.is_empty() {
        uri.push_str(&encode_component(&profile.username));
        if !secret.is_empty() {
            uri.push(':');
            uri.push_str(&encode_component(secret));
        }
        uri.push('@');
    }
    uri.push_str(&authority);
    uri.push('/');
    uri.push_str(database);

    let mut params: Vec<(&String, &String)> = profile
        .extra_params
        .iter()
        .filter(|(k, _)| k.as_str() != "srv" && !k.starts_with("dopedb."))
        .collect();
    params.sort();
    for (i, (k, v)) in params.iter().enumerate() {
        uri.push(if i == 0 { '?' } else { '&' });
        uri.push_str(&encode_component(k));
        uri.push('=');
        uri.push_str(&encode_component(v));
    }
    Ok(uri)
}

/// Percent-encode everything outside RFC 3986 unreserved characters.
fn encode_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Driver config errors can echo parts of the connection string. The secret must
/// never reach logs, the UI, or the append-only audit chain — scrub both its raw
/// and percent-encoded spellings before the message leaves this module.
fn sanitize(e: mongodb::error::Error, secret: &str) -> AppError {
    AppError::Config(format!(
        "MongoDB connection failed: {}",
        scrub(e.to_string(), secret)
    ))
}

fn scrub(mut msg: String, secret: &str) -> String {
    if !secret.is_empty() {
        msg = msg.replace(secret, "***");
        msg = msg.replace(&encode_component(secret), "***");
    }
    msg
}
