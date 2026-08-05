//! SQLite row projections and stable enum/string codecs.

use super::*;

pub(super) fn row_to_active_resource_scope(
    row: &sqlx::sqlite::SqliteRow,
) -> AppResult<ActiveResourceScope> {
    let generation = parse_scope_generation(
        row.try_get::<String, _>("pinned_scope_generation")?
            .as_str(),
    )?;
    let workspace_kind = parse_workspace_kind(row.try_get("pinned_workspace_kind")?)?;
    let selected_account_id: Option<String> = row.try_get("pinned_selected_account_id")?;
    let account_scope_key: String = row.try_get("pinned_account_scope")?;
    let account_scope = account_scope_from_parts(
        workspace_kind,
        selected_account_id.as_deref(),
        &account_scope_key,
    )?;
    Ok(ActiveResourceScope {
        workspace_id: parse_uuid(row.try_get("pinned_workspace_id")?)?,
        workspace_kind,
        selected_account_id,
        account_scope,
        generation,
    })
}

// ── row → model mappers ─────────────────────────────────────────────────────

pub(super) fn row_to_connection(r: &sqlx::sqlite::SqliteRow) -> AppResult<ConnectionProfile> {
    let extra_raw: String = r.try_get("extra_params")?;
    let extra_params: HashMap<String, String> =
        serde_json::from_str(&extra_raw).unwrap_or_default();
    let provider_target = r
        .try_get::<Option<String>, _>("provider_target")
        .unwrap_or(None)
        .map(|value| serde_json::from_str(&value))
        .transpose()?;
    Ok(ConnectionProfile {
        id: parse_uuid(r.try_get("id")?)?,
        name: r.try_get("name")?,
        engine: parse_engine(r.try_get("engine")?)?,
        provider: parse_provider(r.try_get("provider").unwrap_or_else(|_| "auto".to_string()))?,
        driver_id: r.try_get("driver_id").unwrap_or(None),
        host: r.try_get("host")?,
        port: r.try_get::<i64, _>("port")? as u16,
        database: r.try_get("db_name")?,
        username: r.try_get("username")?,
        sslmode: r.try_get("sslmode")?,
        extra_params,
        readonly_default: r.try_get("readonly_default")?,
        allow_writes: r.try_get("allow_writes")?,
        secret_ref: r.try_get("secret_ref")?,
        env: r.try_get("env").unwrap_or(None),
        schema_group: r.try_get("schema_group").unwrap_or(None),
        workspace_access: parse_workspace_access(
            r.try_get("workspace_access")
                .unwrap_or_else(|_| "local".to_string()),
        )?,
        credential_mode: parse_credential_mode(
            r.try_get("credential_mode")
                .unwrap_or_else(|_| "local".to_string()),
        )?,
        provider_target,
    })
}

pub(super) fn row_to_connection_with_binding(
    r: &sqlx::sqlite::SqliteRow,
) -> AppResult<ConnectionProfile> {
    let mut profile = row_to_connection(r)?;
    if profile.workspace_access != WorkspaceConnectionAccess::Local {
        if profile.credential_mode == WorkspaceCredentialMode::MemberLocal {
            profile.username = r
                .try_get::<Option<String>, _>("binding_username")?
                .unwrap_or_default();
            profile.extra_params = r
                .try_get::<Option<String>, _>("binding_extra_params")?
                .and_then(|value| serde_json::from_str(&value).ok())
                .unwrap_or_default();
            profile.secret_ref = r.try_get("binding_secret_ref")?;
        } else {
            profile.username.clear();
            profile.extra_params.clear();
            profile.secret_ref = None;
        }
        profile.workspace_access = r
            .try_get::<Option<String>, _>("binding_workspace_access")?
            .map(parse_workspace_access)
            .transpose()?
            .unwrap_or(WorkspaceConnectionAccess::View);
        profile.allow_writes = r
            .try_get::<Option<bool>, _>("binding_allow_writes")?
            .unwrap_or(false)
            && profile.workspace_access.can_write();
    }
    Ok(profile)
}

pub(super) fn row_to_history(r: &sqlx::sqlite::SqliteRow) -> AppResult<HistoryEntry> {
    Ok(HistoryEntry {
        id: parse_uuid(r.try_get("id")?)?,
        connection_id: parse_uuid(r.try_get("connection_id")?)?,
        sql: r.try_get("sql")?,
        kind: parse_kind(r.try_get("kind")?)?,
        status: r.try_get("status")?,
        row_count: r.try_get("row_count")?,
        duration_ms: r.try_get("duration_ms")?,
        error: r.try_get("error")?,
        executed_at: r.try_get("executed_at")?,
        origin: r.try_get("origin")?,
    })
}

pub(super) fn row_to_dashboard(r: &sqlx::sqlite::SqliteRow) -> AppResult<Dashboard> {
    let visualization_json: String = r.try_get("visualization_json")?;
    let visualization = serde_json::from_str(&visualization_json)?;
    validate_visualization(&visualization)?;
    Ok(Dashboard {
        id: DashboardId::from(parse_uuid(r.try_get("id")?)?),
        connection_id: ConnectionId::from(parse_uuid(r.try_get("connection_id")?)?),
        title: r.try_get("title")?,
        description: r.try_get("description")?,
        sql: r.try_get("sql")?,
        visualization,
        state: DashboardState::parse(r.try_get("state")?)?,
        sync_status: DashboardSyncStatus::parse(r.try_get("sync_status")?)?,
        owner_member_id: r.try_get("owner_member_id")?,
        updated_by_member_id: r.try_get("updated_by_member_id")?,
        revision: r.try_get("revision")?,
        remote_revision: r.try_get("remote_revision")?,
        created_at: r.try_get("created_at")?,
        updated_at: r.try_get("updated_at")?,
    })
}

// ── enum ⇄ text (kept in sync with model.rs serde `camelCase`) ──────────────

pub(crate) fn engine_str(e: Engine) -> &'static str {
    match e {
        Engine::Postgres => "postgres",
        Engine::Mysql => "mysql",
        Engine::Sqlite => "sqlite",
        Engine::Mongodb => "mongodb",
    }
}

pub(crate) fn parse_engine(s: String) -> AppResult<Engine> {
    match s.as_str() {
        "postgres" => Ok(Engine::Postgres),
        "mysql" => Ok(Engine::Mysql),
        "sqlite" => Ok(Engine::Sqlite),
        "mongodb" => Ok(Engine::Mongodb),
        other => Err(AppError::Config(format!("unknown engine '{other}'"))),
    }
}

pub(crate) fn provider_str(provider: Provider) -> &'static str {
    match provider {
        Provider::Auto => "auto",
        Provider::Generic => "generic",
        Provider::Neon => "neon",
        Provider::PlanetScale => "planetScale",
        Provider::GcpCloudSql => "gcpCloudSql",
    }
}

pub(crate) fn parse_provider(s: String) -> AppResult<Provider> {
    match s.as_str() {
        "auto" => Ok(Provider::Auto),
        "generic" => Ok(Provider::Generic),
        "neon" => Ok(Provider::Neon),
        "planetScale" => Ok(Provider::PlanetScale),
        "gcpCloudSql" => Ok(Provider::GcpCloudSql),
        other => Err(AppError::Config(format!("unknown provider '{other}'"))),
    }
}

pub(crate) fn kind_str(k: QueryKind) -> &'static str {
    match k {
        QueryKind::Read => "read",
        QueryKind::Write => "write",
        QueryKind::Ddl => "ddl",
        QueryKind::Privilege => "privilege",
    }
}

pub(crate) fn parse_kind(s: String) -> AppResult<QueryKind> {
    match s.as_str() {
        "read" => Ok(QueryKind::Read),
        "write" => Ok(QueryKind::Write),
        "ddl" => Ok(QueryKind::Ddl),
        "privilege" => Ok(QueryKind::Privilege),
        other => Err(AppError::Config(format!("unknown query kind '{other}'"))),
    }
}

pub(crate) fn parse_uuid(s: String) -> AppResult<Uuid> {
    Uuid::from_str(&s).map_err(|e| AppError::Config(format!("bad uuid '{s}': {e}")))
}

pub(crate) fn parse_uuid_opt(s: Option<String>) -> AppResult<Option<Uuid>> {
    s.map(parse_uuid).transpose()
}
