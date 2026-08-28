//! BigQuery read adapter backed by Google's official `bq` CLI.
//!
//! Authentication remains owned by the user's Google Cloud CLI installation. SQL is
//! sent over stdin (never argv), every read is server dry-run first, and the real job
//! carries a byte-billing ceiling plus an exact id for cancellation.

mod onboarding;
mod runtime;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use semver::Version;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::executor::cancel::CancelHandle;
use crate::features::catalog::{
    Catalog, CatalogOverview, CatalogOverviewDetailState, CatalogOverviewRelation, Column,
    DatabaseObject, Table,
};
use crate::model::{ConnectionProfile, QueryResult};
use crate::process_tree::{ProcessTree, ProcessTreeError};

pub(crate) use onboarding::{
    auth_state, authenticate_google_account, authenticate_service_account,
    cleanup_service_account_auth, discover_datasets, discover_projects, uses_service_account_auth,
    BigQueryAuthState, BigQueryDatasetSummary, BigQueryProjectSummary,
};
pub(crate) use runtime::install_managed_cli;

const MINIMUM_BQ_VERSION: &str = "2.0.29";
pub(crate) const DEFAULT_MAXIMUM_BYTES_BILLED: u64 = 1_073_741_824;
const MAXIMUM_BYTES_BILLED_LIMIT: u64 = 10 * 1024 * 1024 * 1024 * 1024;
const MAX_EXECUTABLE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_SQL_BYTES: usize = 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 32 * 1024 * 1024;
const MAX_ERROR_BYTES: usize = 256 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const QUERY_TIMEOUT: Duration = Duration::from_secs(300);
const CANCEL_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_LIST_RESULTS: u64 = 10_000;

#[derive(Clone)]
pub(crate) struct BigQueryConnection {
    inner: Arc<BigQueryConnectionInner>,
}

struct BigQueryConnectionInner {
    executable: ResolvedSdkExecutable,
    home: PathBuf,
    cloudsdk_config: PathBuf,
    project: String,
    dataset: String,
    location: String,
    maximum_bytes_billed: u64,
}

#[derive(Clone)]
struct ExecutableIdentity {
    canonical_path: PathBuf,
    sha256: String,
    byte_length: u64,
}

#[derive(Clone)]
struct ResolvedSdkExecutable {
    identity: ExecutableIdentity,
    environment: runtime::CommandEnvironment,
}

#[derive(Debug)]
struct CommandOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CommandFailure {
    Unavailable,
    Changed,
    Spawn,
    Isolation,
    Cleanup,
    Output,
    Cancelled,
    TimedOut,
}

#[derive(Debug)]
struct DryRun {
    columns: Vec<String>,
    total_bytes_processed: Option<u64>,
}

/// Synchronous presence probe used by the driver catalog. Connection-time hashing
/// and version validation remain authoritative.
pub(crate) fn is_cli_available() -> bool {
    sdk_roots().into_iter().any(|root| {
        let bq = root
            .join("bin")
            .join(if cfg!(windows) { "bq.cmd" } else { "bq" });
        let gcloud = root.join("bin").join(if cfg!(windows) {
            "gcloud.cmd"
        } else {
            "gcloud"
        });
        audited_candidate_exists(&bq, &root) && audited_candidate_exists(&gcloud, &root)
    })
}

fn audited_candidate_exists(candidate: &Path, root: &Path) -> bool {
    let Ok(canonical_root) = root.canonicalize() else {
        return false;
    };
    let Ok(canonical_candidate) = candidate.canonicalize() else {
        return false;
    };
    let Ok(metadata) = candidate.symlink_metadata() else {
        return false;
    };
    metadata.is_file()
        && !metadata.file_type().is_symlink()
        && metadata.len() > 0
        && metadata.len() <= MAX_EXECUTABLE_BYTES
        && canonical_candidate.starts_with(canonical_root)
}

pub(crate) fn validate_profile(profile: &ConnectionProfile) -> AppResult<()> {
    if !valid_project_id(profile.host.trim()) {
        return Err(AppError::Config(
            "BigQuery project ID must be 6-30 lowercase letters, digits, or hyphens; start with a letter; and not end with a hyphen"
                .into(),
        ));
    }
    if !valid_dataset_id(profile.database.trim()) {
        return Err(AppError::Config(
            "BigQuery dataset ID must contain only letters, digits, or underscores and be at most 1024 characters"
                .into(),
        ));
    }
    if profile.provider != crate::model::Provider::Generic {
        return Err(AppError::Config(
            "BigQuery connections use the generic provider with local Google Cloud CLI authentication"
                .into(),
        ));
    }
    if profile.port != 443 {
        return Err(AppError::Config(
            "BigQuery connections use the fixed HTTPS port 443".into(),
        ));
    }
    if profile.sslmode != "require" {
        return Err(AppError::Config(
            "BigQuery connections require the official HTTPS API endpoint".into(),
        ));
    }
    if !profile.username.trim().is_empty() {
        return Err(AppError::Config(
            "BigQuery credentials are owned by Google Cloud CLI; username must be empty".into(),
        ));
    }
    if profile.allow_writes || !profile.readonly_default {
        return Err(AppError::Blocked {
            reason: "BigQuery is available only through DopeDB's read-only query adapter".into(),
        });
    }
    onboarding::validate_auth_mode(profile)?;
    if profile
        .extra_params
        .keys()
        .any(|key| !matches!(key.as_str(), "authMode" | "location" | "maximumBytesBilled"))
    {
        return Err(AppError::Config(
            "BigQuery accepts only authMode, location, and maximumBytesBilled connection options"
                .into(),
        ));
    }
    if profile
        .extra_params
        .get("location")
        .is_some_and(|value| !valid_location(value.trim()))
    {
        return Err(AppError::Config(
            "BigQuery location must contain only letters, digits, or hyphens".into(),
        ));
    }
    maximum_bytes_billed(profile)?;
    Ok(())
}

pub(crate) async fn connect(profile: &ConnectionProfile) -> AppResult<BigQueryConnection> {
    validate_profile(profile)?;
    let home = dirs::home_dir().ok_or_else(|| {
        AppError::Config("the user home directory is unavailable for Google Cloud CLI".into())
    })?;
    let cloudsdk_config = onboarding::cloudsdk_config(profile, &home)?;
    let executable = discover_executable().await?;
    let provisional = BigQueryConnection {
        inner: Arc::new(BigQueryConnectionInner {
            executable,
            home,
            cloudsdk_config,
            project: profile.host.trim().to_owned(),
            dataset: profile.database.trim().to_owned(),
            location: profile
                .extra_params
                .get("location")
                .map(|value| value.trim().to_owned())
                .unwrap_or_default(),
            maximum_bytes_billed: maximum_bytes_billed(profile)?,
        }),
    };
    provisional.verify_version().await?;
    let metadata = provisional.dataset_metadata().await?;
    let location = exact_string(&metadata, &["location"])
        .filter(|location| valid_location(location))
        .ok_or_else(|| AppError::Config("BigQuery returned an invalid dataset location".into()))?
        .to_owned();
    validate_dataset_reference(&metadata, provisional.project(), provisional.dataset())?;
    if !provisional.inner.location.is_empty()
        && !provisional.inner.location.eq_ignore_ascii_case(&location)
    {
        return Err(AppError::Config(format!(
            "BigQuery dataset location is {location}, not {}",
            provisional.inner.location
        )));
    }
    Ok(BigQueryConnection {
        inner: Arc::new(BigQueryConnectionInner {
            location,
            executable: provisional.inner.executable.clone(),
            home: provisional.inner.home.clone(),
            cloudsdk_config: provisional.inner.cloudsdk_config.clone(),
            project: provisional.inner.project.clone(),
            dataset: provisional.inner.dataset.clone(),
            maximum_bytes_billed: provisional.inner.maximum_bytes_billed,
        }),
    })
}

impl BigQueryConnection {
    pub(crate) fn project(&self) -> &str {
        &self.inner.project
    }

    pub(crate) fn dataset(&self) -> &str {
        &self.inner.dataset
    }

    pub(crate) fn location(&self) -> &str {
        &self.inner.location
    }

    pub(crate) async fn ping(&self) -> AppResult<()> {
        let metadata = self.dataset_metadata().await?;
        validate_dataset_reference(&metadata, self.project(), self.dataset())?;
        Ok(())
    }

    pub(crate) async fn query(
        &self,
        sql: &str,
        max_rows: u64,
        cancellation: Option<&CancelHandle>,
    ) -> AppResult<QueryResult> {
        self.query_with_timeout(sql, max_rows, cancellation, QUERY_TIMEOUT)
            .await
    }

    pub(crate) async fn query_byte_capped(
        &self,
        sql: &str,
        max_rows: u64,
        max_bytes: usize,
        cancellation: Option<&CancelHandle>,
    ) -> AppResult<QueryResult> {
        let mut result = self.query(sql, max_rows, cancellation).await?;
        let mut retained = 0usize;
        let mut keep = result.rows.len();
        for (index, row) in result.rows.iter().enumerate() {
            let bytes = serde_json::to_vec(row)?.len();
            if bytes > max_bytes {
                return Err(AppError::Blocked {
                    reason: format!(
                        "one export row exceeds the {} MiB batch safety limit",
                        max_bytes / 1024 / 1024
                    ),
                });
            }
            if retained.saturating_add(bytes) > max_bytes {
                keep = index;
                result.truncated = true;
                break;
            }
            retained += bytes;
        }
        result.rows.truncate(keep);
        result.row_count = result.rows.len();
        Ok(result)
    }

    pub(crate) async fn dry_run_bytes(&self, sql: &str) -> AppResult<Option<u64>> {
        Ok(self.dry_run(sql, None).await?.total_bytes_processed)
    }

    async fn query_with_timeout(
        &self,
        sql: &str,
        max_rows: u64,
        cancellation: Option<&CancelHandle>,
        timeout: Duration,
    ) -> AppResult<QueryResult> {
        validate_sql(sql)?;
        if cancellation.is_some_and(CancelHandle::is_cancelled) {
            return Err(AppError::Safety("query cancelled".into()));
        }
        let started = Instant::now();
        let dry_run = self.dry_run(sql, cancellation).await?;
        let job_id = format!(
            "dopedb_{}",
            cancellation
                .map(CancelHandle::id)
                .unwrap_or_else(Uuid::new_v4)
                .simple()
        );
        let max_rows = max_rows.min(MAX_LIST_RESULTS);
        let fetch_rows = max_rows.saturating_add(1);
        let job_timeout_ms = timeout
            .saturating_sub(Duration::from_secs(5))
            .as_millis()
            .min(u128::from(u64::MAX)) as u64;
        let mut args = self.global_args(true);
        args.extend([
            "query".into(),
            "--use_legacy_sql=false".into(),
            format!("--max_rows={fetch_rows}"),
            format!("--maximum_bytes_billed={}", self.inner.maximum_bytes_billed),
            format!("--job_timeout_ms={job_timeout_ms}"),
            format!("--job_id={job_id}"),
        ]);
        let output = match self
            .run_command(&args, Some(sql.as_bytes()), cancellation, timeout)
            .await
        {
            Ok(output) => output,
            Err(CommandFailure::Cancelled) => {
                self.confirm_cancelled_job(&job_id).await?;
                return Err(AppError::Safety("query cancelled".into()));
            }
            Err(CommandFailure::TimedOut) => {
                self.confirm_cancelled_job(&job_id).await?;
                return Err(AppError::Timeout(format!(
                    "BigQuery job exceeded the {} second query limit and was cancelled",
                    timeout.as_secs()
                )));
            }
            Err(CommandFailure::Cleanup) => {
                return Err(AppError::OutcomeUnknown(
                    "the BigQuery client process could not be fully stopped; inspect the exact job in Google Cloud before retrying"
                        .into(),
                ));
            }
            Err(error) => return Err(command_failure(error)),
        };
        ensure_success(&output)?;
        let mut rows = parse_query_rows(&output.stdout, &dry_run.columns)?;
        let truncated = rows.len() > max_rows as usize;
        if truncated {
            rows.truncate(max_rows as usize);
        }
        Ok(QueryResult {
            row_count: rows.len(),
            columns: dry_run.columns,
            rows,
            truncated,
            duration_ms: started.elapsed().as_millis() as u64,
        })
    }

    async fn dry_run(&self, sql: &str, cancellation: Option<&CancelHandle>) -> AppResult<DryRun> {
        validate_sql(sql)?;
        let mut args = self.global_args(true);
        args.extend([
            "query".into(),
            "--use_legacy_sql=false".into(),
            "--dry_run=true".into(),
            format!("--maximum_bytes_billed={}", self.inner.maximum_bytes_billed),
        ]);
        let output = self
            .run_command(&args, Some(sql.as_bytes()), cancellation, CONNECT_TIMEOUT)
            .await
            .map_err(command_failure)?;
        ensure_success(&output)?;
        parse_dry_run(&output.stdout)
    }

    async fn verify_version(&self) -> AppResult<()> {
        let mut args = self.global_args(false);
        args.push("version".into());
        let output = self
            .run_command(&args, None, None, CONNECT_TIMEOUT)
            .await
            .map_err(command_failure)?;
        ensure_success(&output)?;
        let text = String::from_utf8(output.stdout).map_err(|_| {
            AppError::Config("BigQuery CLI returned non-UTF-8 version output".into())
        })?;
        let version = text
            .split_ascii_whitespace()
            .find_map(|part| {
                Version::parse(part.trim_matches(|c: char| !c.is_ascii_digit() && c != '.')).ok()
            })
            .ok_or_else(|| AppError::Config("BigQuery CLI version could not be verified".into()))?;
        let minimum = Version::parse(MINIMUM_BQ_VERSION).expect("valid BigQuery minimum version");
        if version < minimum {
            return Err(AppError::Config(format!(
                "BigQuery CLI {version} is too old; update Google Cloud CLI to provide bq {minimum} or newer"
            )));
        }
        Ok(())
    }

    async fn dataset_metadata(&self) -> AppResult<Value> {
        let mut args = self.global_args(false);
        args.extend([
            "show".into(),
            "--dataset=true".into(),
            format!("{}:{}", self.project(), self.dataset()),
        ]);
        let output = self
            .run_command(&args, None, None, CONNECT_TIMEOUT)
            .await
            .map_err(command_failure)?;
        ensure_success(&output)?;
        parse_json(&output.stdout, "dataset metadata")
    }

    pub(crate) async fn databases(&self) -> AppResult<Vec<String>> {
        let mut args = self.global_args(false);
        args.extend([
            "ls".into(),
            "--datasets=true".into(),
            format!("--max_results={MAX_LIST_RESULTS}"),
            self.project().into(),
        ]);
        let output = self
            .run_command(&args, None, None, CONNECT_TIMEOUT)
            .await
            .map_err(command_failure)?;
        ensure_success(&output)?;
        let value = parse_json(&output.stdout, "dataset list")?;
        let rows = value
            .as_array()
            .ok_or_else(|| AppError::Config("BigQuery returned an invalid dataset list".into()))?;
        if rows.len() > MAX_LIST_RESULTS as usize {
            return Err(AppError::Config(
                "BigQuery dataset list exceeded its bound".into(),
            ));
        }
        let mut datasets = Vec::with_capacity(rows.len());
        for row in rows {
            let reference = row
                .get("datasetReference")
                .and_then(Value::as_object)
                .ok_or_else(|| AppError::Config("BigQuery dataset reference is missing".into()))?;
            let project = reference
                .get("projectId")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::Config("BigQuery dataset project is missing".into()))?;
            let dataset = reference
                .get("datasetId")
                .and_then(Value::as_str)
                .filter(|dataset| valid_dataset_id(dataset))
                .ok_or_else(|| AppError::Config("BigQuery dataset ID is invalid".into()))?;
            if project != self.project() {
                return Err(AppError::Config(
                    "BigQuery returned a dataset outside the configured project".into(),
                ));
            }
            datasets.push(dataset.to_owned());
        }
        Ok(datasets)
    }

    pub(crate) async fn overview(&self) -> AppResult<CatalogOverview> {
        let mut args = self.global_args(true);
        args.extend([
            "ls".into(),
            format!("--max_results={MAX_LIST_RESULTS}"),
            format!("{}:{}", self.project(), self.dataset()),
        ]);
        let output = self
            .run_command(&args, None, None, CONNECT_TIMEOUT)
            .await
            .map_err(command_failure)?;
        ensure_success(&output)?;
        let value = parse_json(&output.stdout, "table list")?;
        let rows = value
            .as_array()
            .ok_or_else(|| AppError::Config("BigQuery returned an invalid table list".into()))?;
        if rows.len() > MAX_LIST_RESULTS as usize {
            return Err(AppError::Config(
                "BigQuery table list exceeded its bound".into(),
            ));
        }
        let mut relations = Vec::with_capacity(rows.len());
        for row in rows {
            let reference = validated_table_reference(row, self.project(), self.dataset())?;
            let table_id = reference
                .get("tableId")
                .and_then(Value::as_str)
                .expect("validated table id");
            let raw_type = row.get("type").and_then(Value::as_str).unwrap_or("TABLE");
            relations.push(CatalogOverviewRelation {
                schema: Some(self.dataset().into()),
                name: table_id.into(),
                kind: relation_kind(raw_type).into(),
                native_id: Some(format!(
                    "{}:{}.{}",
                    self.project(),
                    self.dataset(),
                    table_id
                )),
                comment: None,
                row_estimate: None,
                parent: None,
            });
        }
        relations.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(CatalogOverview {
            database: Some(self.dataset().into()),
            namespaces: vec![self.dataset().into()],
            relations,
            detail_state: CatalogOverviewDetailState::Deferred,
        })
    }

    pub(crate) async fn introspect(&self) -> AppResult<Catalog> {
        let qualified = format!("{}.{}", self.project(), self.dataset());
        let sql = format!(
            "SELECT t.table_name, t.table_type, c.column_name, c.data_type, \
             c.is_nullable, c.ordinal_position \
             FROM `{qualified}.INFORMATION_SCHEMA.TABLES` AS t \
             LEFT JOIN `{qualified}.INFORMATION_SCHEMA.COLUMNS` AS c \
             USING (table_catalog, table_schema, table_name) \
             ORDER BY t.table_name, c.ordinal_position"
        );
        let result = self.query(&sql, MAX_LIST_RESULTS, None).await?;
        if result.truncated {
            return Err(AppError::Config(
                "BigQuery schema exceeds the 10,000-column introspection bound".into(),
            ));
        }
        let indexes = column_indexes(
            &result.columns,
            &[
                "table_name",
                "table_type",
                "column_name",
                "data_type",
                "is_nullable",
                "ordinal_position",
            ],
        )?;
        let mut order = Vec::<String>::new();
        let mut tables = HashMap::<String, (String, Vec<Column>)>::new();
        for row in &result.rows {
            let name = cell_string(row, indexes[0], "table_name")?;
            if !valid_table_id(&name) {
                return Err(AppError::Config(
                    "BigQuery returned an invalid table ID".into(),
                ));
            }
            let table_type = cell_string(row, indexes[1], "table_type")?;
            if !tables.contains_key(&name) {
                order.push(name.clone());
                tables.insert(name.clone(), (table_type.clone(), Vec::new()));
            }
            let Some(column_name) = cell_optional_string(row, indexes[2])? else {
                continue;
            };
            if !valid_table_id(&column_name) {
                return Err(AppError::Config(
                    "BigQuery returned an invalid column name".into(),
                ));
            }
            let data_type = cell_string(row, indexes[3], "data_type")?;
            let nullable = cell_string(row, indexes[4], "is_nullable")? == "YES";
            let ordinal = cell_u32(row, indexes[5], "ordinal_position")?;
            tables
                .get_mut(&name)
                .expect("table inserted above")
                .1
                .push(Column {
                    name: column_name,
                    data_type,
                    nullable,
                    ordinal,
                    ..Column::default()
                });
        }
        let mut relations = Vec::new();
        let mut objects = Vec::new();
        for name in order {
            let (table_type, mut columns) = tables
                .remove(&name)
                .expect("ordered BigQuery table remains in map");
            columns.sort_by_key(|column| column.ordinal);
            let native_id = format!("{}:{}.{}", self.project(), self.dataset(), name);
            if table_type.eq_ignore_ascii_case("MATERIALIZED VIEW") {
                objects.push(DatabaseObject {
                    schema: Some(self.dataset().into()),
                    name,
                    kind: "materialized_view".into(),
                    native_id: Some(native_id),
                    ..DatabaseObject::default()
                });
                continue;
            }
            relations.push(Table {
                database: Some(self.dataset().into()),
                schema: Some(self.dataset().into()),
                name,
                kind: if table_type.eq_ignore_ascii_case("VIEW") {
                    "view"
                } else {
                    "table"
                }
                .into(),
                native_id: Some(native_id),
                columns,
                foreign_keys: Vec::new(),
                constraints: Vec::new(),
                indexes: Vec::new(),
                row_estimate: None,
                ..Table::default()
            });
        }
        Ok(Catalog {
            tables: relations,
            objects,
        })
    }

    fn global_args(&self, include_dataset: bool) -> Vec<String> {
        let mut args = vec![
            format!("--bigqueryrc={}", null_device()),
            "--api=https://bigquery.googleapis.com".into(),
            "--format=json".into(),
            "--headless=true".into(),
            "--quiet=true".into(),
            "--debug_mode=false".into(),
            "--disable_ssl_validation=false".into(),
            "--httplib2_debuglevel=0".into(),
            "--synchronous_mode=true".into(),
            format!("--project_id={}", self.project()),
        ];
        if include_dataset {
            args.push(format!(
                "--dataset_id={}:{}",
                self.project(),
                self.dataset()
            ));
            if !self.location().is_empty() {
                args.push(format!("--location={}", self.location()));
            }
        }
        args
    }

    async fn confirm_cancelled_job(&self, job_id: &str) -> AppResult<()> {
        let mut args = self.global_args(false);
        args.extend([
            "cancel".into(),
            format!("--location={}", self.location()),
            format!("{}:{job_id}", self.project()),
        ]);
        match self.run_command(&args, None, None, CANCEL_TIMEOUT).await {
            Ok(output) if output.status.success() => Ok(()),
            _ => Err(AppError::OutcomeUnknown(format!(
                "BigQuery job {job_id} could not be confirmed cancelled; inspect it in Google Cloud before retrying"
            ))),
        }
    }

    async fn run_command(
        &self,
        args: &[String],
        stdin: Option<&[u8]>,
        cancellation: Option<&CancelHandle>,
        timeout: Duration,
    ) -> Result<CommandOutput, CommandFailure> {
        let executable = self.inner.executable.identity.revalidate().await?;
        let mut command = Command::new(executable);
        command
            .args(args)
            .env_clear()
            .env("PATH", safe_path())
            .env("HOME", &self.inner.home)
            .env("CLOUDSDK_CONFIG", &self.inner.cloudsdk_config)
            .env("CLOUDSDK_CORE_DISABLE_PROMPTS", "1")
            .env("CLOUDSDK_CORE_DISABLE_USAGE_REPORTING", "true")
            .env("CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK", "1")
            .env("CLOUDSDK_CORE_LOG_HTTP", "false")
            .env("PYTHONIOENCODING", "utf-8")
            .kill_on_drop(true)
            .stdin(if stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        self.inner.executable.environment.apply(&mut command);
        #[cfg(unix)]
        command.process_group(0);
        #[cfg(windows)]
        command.creation_flags(
            windows_sys::Win32::System::Threading::CREATE_NO_WINDOW
                | windows_sys::Win32::System::Threading::CREATE_NEW_PROCESS_GROUP,
        );
        let mut child = command.spawn().map_err(|_| CommandFailure::Spawn)?;
        let mut tree = match ProcessTree::attach(&child) {
            Ok(tree) => tree,
            Err(_) => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                return Err(CommandFailure::Isolation);
            }
        };
        let stdout = child.stdout.take().ok_or(CommandFailure::Output)?;
        let stderr = child.stderr.take().ok_or(CommandFailure::Output)?;
        let mut child_stdin = child.stdin.take();
        let input = stdin.map(ToOwned::to_owned);
        let io = async move {
            let write = async move {
                if let (Some(mut handle), Some(input)) = (child_stdin.take(), input) {
                    handle
                        .write_all(&input)
                        .await
                        .map_err(|_| CommandFailure::Output)?;
                    handle
                        .shutdown()
                        .await
                        .map_err(|_| CommandFailure::Output)?;
                }
                Ok::<(), CommandFailure>(())
            };
            let read = async move {
                tokio::try_join!(
                    read_bounded(stdout, MAX_OUTPUT_BYTES),
                    read_bounded(stderr, MAX_ERROR_BYTES)
                )
            };
            let (_, (stdout, stderr)) = tokio::try_join!(write, read)?;
            Ok::<_, CommandFailure>((stdout, stderr))
        };
        let result = tokio::select! {
            biased;
            _ = async {
                match cancellation {
                    Some(handle) => handle.cancelled().await,
                    None => std::future::pending::<()>().await,
                }
            } => Err(CommandFailure::Cancelled),
            result = tokio::time::timeout(timeout, io) => match result {
                Ok(result) => result,
                Err(_) => Err(CommandFailure::TimedOut),
            },
        };
        let status = tree
            .terminate_and_reap(&mut child)
            .await
            .map_err(map_process_tree_error)?;
        let (stdout, stderr) = result?;
        Ok(CommandOutput {
            status,
            stdout,
            stderr,
        })
    }
}

impl ExecutableIdentity {
    async fn audit_named(
        path: &Path,
        allowed_root: &Path,
        allowed_names: &[&str],
    ) -> Result<Self, CommandFailure> {
        let canonical_path = tokio::fs::canonicalize(path)
            .await
            .map_err(|_| CommandFailure::Unavailable)?;
        let canonical_root = tokio::fs::canonicalize(allowed_root)
            .await
            .map_err(|_| CommandFailure::Unavailable)?;
        if !canonical_path.starts_with(&canonical_root)
            || canonical_path
                .file_name()
                .and_then(|name| name.to_str())
                .is_none_or(|name| !allowed_names.contains(&name))
        {
            return Err(CommandFailure::Unavailable);
        }
        let (sha256, byte_length) = hash_regular_file(&canonical_path).await?;
        Ok(Self {
            canonical_path,
            sha256,
            byte_length,
        })
    }

    async fn revalidate(&self) -> Result<PathBuf, CommandFailure> {
        let canonical = tokio::fs::canonicalize(&self.canonical_path)
            .await
            .map_err(|_| CommandFailure::Changed)?;
        if canonical != self.canonical_path {
            return Err(CommandFailure::Changed);
        }
        let (sha256, byte_length) = hash_regular_file(&canonical).await?;
        if sha256 != self.sha256 || byte_length != self.byte_length {
            return Err(CommandFailure::Changed);
        }
        Ok(canonical)
    }
}

async fn discover_executable() -> AppResult<ResolvedSdkExecutable> {
    discover_sdk_executable(&["bq", "bq.cmd"], "BigQuery CLI").await
}

async fn discover_sdk_executable(
    allowed_names: &[&str],
    label: &str,
) -> AppResult<ResolvedSdkExecutable> {
    let file_name = if cfg!(windows) {
        allowed_names
            .iter()
            .find(|name| name.ends_with(".cmd"))
            .copied()
    } else {
        allowed_names
            .iter()
            .find(|name| !name.ends_with(".cmd"))
            .copied()
    }
    .ok_or_else(|| AppError::Config(format!("the {label} executable name is invalid")))?;
    for root in sdk_roots() {
        let candidate = root.join("bin").join(file_name);
        if !candidate.is_file() {
            continue;
        }
        if let Ok(identity) =
            ExecutableIdentity::audit_named(&candidate, &root, allowed_names).await
        {
            return Ok(ResolvedSdkExecutable {
                identity,
                environment: runtime::command_environment_for_sdk_root(&root),
            });
        }
    }
    Err(AppError::Config(format!(
        "{label} is unavailable; reconnect so DopeDB can prepare the official Google tools"
    )))
}

fn sdk_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home) = dirs::home_dir() {
        roots.extend([
            home.join("google-cloud-sdk"),
            home.join(".local/share/google-cloud-sdk"),
            home.join("Library/google-cloud-sdk"),
        ]);
    }
    #[cfg(not(windows))]
    roots.extend([
        PathBuf::from("/opt/homebrew/Caskroom/google-cloud-sdk/latest/google-cloud-sdk"),
        PathBuf::from("/usr/local/Caskroom/google-cloud-sdk/latest/google-cloud-sdk"),
        PathBuf::from("/usr/lib/google-cloud-sdk"),
        PathBuf::from("/opt/google-cloud-sdk"),
    ]);
    #[cfg(windows)]
    if let Some(local) = dirs::data_local_dir() {
        roots.push(local.join("Google/Cloud SDK/google-cloud-sdk"));
    }
    if let Some(managed) = runtime::managed_sdk_root_if_ready() {
        roots.push(managed);
    }
    roots
}

fn default_cloudsdk_config(home: &Path) -> AppResult<PathBuf> {
    #[cfg(windows)]
    let config = dirs::config_dir()
        .map(|directory| directory.join("gcloud"))
        .ok_or_else(|| {
            AppError::Config("the Google Cloud CLI configuration directory is unavailable".into())
        })?;
    #[cfg(not(windows))]
    let config = home.join(".config/gcloud");
    Ok(config)
}

async fn hash_regular_file(path: &Path) -> Result<(String, u64), CommandFailure> {
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|_| CommandFailure::Unavailable)?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_EXECUTABLE_BYTES {
        return Err(CommandFailure::Unavailable);
    }
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|_| CommandFailure::Unavailable)?;
    if bytes.len() as u64 != metadata.len() {
        return Err(CommandFailure::Changed);
    }
    Ok((hex::encode(Sha256::digest(&bytes)), metadata.len()))
}

async fn read_bounded<R: AsyncRead + Unpin>(
    mut reader: R,
    maximum: usize,
) -> Result<Vec<u8>, CommandFailure> {
    let mut output = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        let count = reader
            .read(&mut buffer)
            .await
            .map_err(|_| CommandFailure::Output)?;
        if count == 0 {
            return Ok(output);
        }
        if output.len().saturating_add(count) > maximum {
            return Err(CommandFailure::Output);
        }
        output.extend_from_slice(&buffer[..count]);
    }
}

fn ensure_success(output: &CommandOutput) -> AppResult<()> {
    if output.status.success() {
        return Ok(());
    }
    Err(safe_cli_error(&output.stderr))
}

fn safe_cli_error(stderr: &[u8]) -> AppError {
    let text = String::from_utf8_lossy(stderr).to_ascii_lowercase();
    if text.contains("reauthentication failed")
        || text.contains("gcloud auth login")
        || text.contains("invalid_grant")
        || text.contains("login required")
    {
        return AppError::Config(
            "Google Cloud CLI authentication expired; run `gcloud auth login`, then retry".into(),
        );
    }
    if text.contains("access denied")
        || text.contains("permission denied")
        || text.contains("does not have") && text.contains("permission")
    {
        return AppError::Blocked {
            reason:
                "the active Google Cloud CLI account is not allowed to read this BigQuery dataset"
                    .into(),
        };
    }
    if text.contains("not found") || text.contains("notfound") {
        return AppError::Config(
            "the BigQuery project or dataset was not found in the active Google Cloud CLI account"
                .into(),
        );
    }
    if text.contains("maximum bytes billed") || text.contains("bytes billed limit") {
        return AppError::Blocked {
            reason: "the query exceeds this connection's maximum bytes billed limit; no billed query was started"
                .into(),
        };
    }
    AppError::Config(
        "BigQuery CLI rejected the request; verify `bq version`, the active gcloud account, project, dataset, and location"
            .into(),
    )
}

fn command_failure(error: CommandFailure) -> AppError {
    match error {
        CommandFailure::Unavailable => AppError::Config(
            "the verified BigQuery CLI executable is no longer available".into(),
        ),
        CommandFailure::Changed => AppError::Blocked {
            reason: "the BigQuery CLI executable changed after verification; restart DopeDB before using it"
                .into(),
        },
        CommandFailure::Spawn => {
            AppError::Config("the verified BigQuery CLI could not be started".into())
        }
        CommandFailure::Isolation => AppError::Blocked {
            reason: "the BigQuery CLI process could not be isolated safely".into(),
        },
        CommandFailure::Cleanup => AppError::OutcomeUnknown(
            "the BigQuery CLI process tree could not be proven stopped".into(),
        ),
        CommandFailure::Output => AppError::Blocked {
            reason: "BigQuery CLI output exceeded the local safety bound or was incomplete".into(),
        },
        CommandFailure::Cancelled => AppError::Safety("query cancelled".into()),
        CommandFailure::TimedOut => {
            AppError::Timeout("BigQuery CLI exceeded its bounded execution time".into())
        }
    }
}

fn map_process_tree_error(error: ProcessTreeError) -> CommandFailure {
    match error {
        ProcessTreeError::Isolation => CommandFailure::Isolation,
        ProcessTreeError::Cleanup => CommandFailure::Cleanup,
    }
}

fn parse_json(bytes: &[u8], label: &str) -> AppResult<Value> {
    serde_json::from_slice(bytes)
        .map_err(|_| AppError::Config(format!("BigQuery returned invalid {label} JSON")))
}

fn parse_dry_run(bytes: &[u8]) -> AppResult<DryRun> {
    let value = parse_json(bytes, "dry-run")?;
    let query = value
        .get("statistics")
        .and_then(|value| value.get("query"))
        .ok_or_else(|| AppError::Config("BigQuery dry-run statistics are missing".into()))?;
    let statement_type = query
        .get("statementType")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Config("BigQuery dry-run statement type is missing".into()))?;
    if statement_type != "SELECT" {
        return Err(AppError::Blocked {
            reason: format!(
                "BigQuery server classified this statement as {statement_type}, not SELECT"
            ),
        });
    }
    let fields = query
        .get("schema")
        .and_then(|value| value.get("fields"))
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::Config("BigQuery dry-run result schema is missing".into()))?;
    let mut seen = HashSet::new();
    let mut columns = Vec::with_capacity(fields.len());
    for field in fields {
        let name = field
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| valid_table_id(name))
            .ok_or_else(|| AppError::Config("BigQuery returned an invalid result column".into()))?;
        if !seen.insert(name.to_owned()) {
            return Err(AppError::Blocked {
                reason: "BigQuery result columns must have unique names".into(),
            });
        }
        columns.push(name.to_owned());
    }
    let total_bytes_processed = query
        .get("totalBytesProcessed")
        .and_then(value_u64)
        .or_else(|| {
            value
                .pointer("/statistics/totalBytesProcessed")
                .and_then(value_u64)
        });
    Ok(DryRun {
        columns,
        total_bytes_processed,
    })
}

fn parse_query_rows(bytes: &[u8], columns: &[String]) -> AppResult<Vec<Vec<Value>>> {
    let value = parse_json(bytes, "query result")?;
    let rows = value
        .as_array()
        .ok_or_else(|| AppError::Config("BigQuery query result is not an array".into()))?;
    let expected = columns.iter().map(String::as_str).collect::<HashSet<_>>();
    rows.iter()
        .map(|row| {
            let object = row.as_object().ok_or_else(|| {
                AppError::Config("BigQuery query result contains a non-object row".into())
            })?;
            if object.keys().any(|key| !expected.contains(key.as_str())) {
                return Err(AppError::Config(
                    "BigQuery query result does not match its dry-run schema".into(),
                ));
            }
            Ok(columns
                .iter()
                .map(|column| object.get(column).cloned().unwrap_or(Value::Null))
                .collect())
        })
        .collect()
}

fn validate_dataset_reference(value: &Value, project: &str, dataset: &str) -> AppResult<()> {
    let reference = value
        .get("datasetReference")
        .and_then(Value::as_object)
        .ok_or_else(|| AppError::Config("BigQuery dataset reference is missing".into()))?;
    if reference.get("projectId").and_then(Value::as_str) != Some(project)
        || reference.get("datasetId").and_then(Value::as_str) != Some(dataset)
    {
        return Err(AppError::Config(
            "BigQuery returned metadata for a different project or dataset".into(),
        ));
    }
    Ok(())
}

fn validated_table_reference<'a>(
    row: &'a Value,
    project: &str,
    dataset: &str,
) -> AppResult<&'a serde_json::Map<String, Value>> {
    let reference = row
        .get("tableReference")
        .and_then(Value::as_object)
        .ok_or_else(|| AppError::Config("BigQuery table reference is missing".into()))?;
    if reference.get("projectId").and_then(Value::as_str) != Some(project)
        || reference.get("datasetId").and_then(Value::as_str) != Some(dataset)
        || !reference
            .get("tableId")
            .and_then(Value::as_str)
            .is_some_and(valid_table_id)
    {
        return Err(AppError::Config(
            "BigQuery returned a table outside the configured dataset".into(),
        ));
    }
    Ok(reference)
}

fn exact_string<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    path.iter()
        .try_fold(value, |current, segment| current.get(*segment))?
        .as_str()
}

fn column_indexes(columns: &[String], required: &[&str]) -> AppResult<Vec<usize>> {
    required
        .iter()
        .map(|name| {
            columns
                .iter()
                .position(|column| column == name)
                .ok_or_else(|| {
                    AppError::Config(format!("BigQuery schema result is missing {name}"))
                })
        })
        .collect()
}

fn cell_string(row: &[Value], index: usize, field: &str) -> AppResult<String> {
    row.get(index)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| AppError::Config(format!("BigQuery schema {field} is invalid")))
}

fn cell_optional_string(row: &[Value], index: usize) -> AppResult<Option<String>> {
    match row.get(index) {
        Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        _ => Err(AppError::Config(
            "BigQuery schema column name is invalid".into(),
        )),
    }
}

fn cell_u32(row: &[Value], index: usize, field: &str) -> AppResult<u32> {
    row.get(index)
        .and_then(value_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| AppError::Config(format!("BigQuery schema {field} is invalid")))
}

fn value_u64(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_str().and_then(|value| value.parse().ok()))
}

fn maximum_bytes_billed(profile: &ConnectionProfile) -> AppResult<u64> {
    let value = match profile.extra_params.get("maximumBytesBilled") {
        Some(value) => value.parse::<u64>().ok(),
        None => Some(DEFAULT_MAXIMUM_BYTES_BILLED),
    }
    .filter(|value| (1..=MAXIMUM_BYTES_BILLED_LIMIT).contains(value))
    .ok_or_else(|| {
        AppError::Config(
            "BigQuery maximum bytes billed must be an integer between 1 byte and 10 TiB".into(),
        )
    })?;
    Ok(value)
}

fn validate_sql(sql: &str) -> AppResult<()> {
    if sql.trim().is_empty() || sql.len() > MAX_SQL_BYTES || sql.as_bytes().contains(&0) {
        return Err(AppError::Blocked {
            reason: "BigQuery SQL must be non-empty, NUL-free, and at most 1 MiB".into(),
        });
    }
    Ok(())
}

fn valid_project_id(value: &str) -> bool {
    (6..=30).contains(&value.len())
        && value.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        && !value.ends_with('-')
}

fn valid_dataset_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 1024
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn valid_table_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 1024
        && !value.chars().any(char::is_control)
        && !value.contains(['`', '\n', '\r'])
}

fn valid_location(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn relation_kind(value: &str) -> &'static str {
    if value.eq_ignore_ascii_case("VIEW") {
        "view"
    } else if value.eq_ignore_ascii_case("MATERIALIZED_VIEW")
        || value.eq_ignore_ascii_case("MATERIALIZED VIEW")
    {
        "materialized_view"
    } else {
        "table"
    }
}

#[cfg(windows)]
fn null_device() -> &'static str {
    "NUL"
}

#[cfg(not(windows))]
fn null_device() -> &'static str {
    "/dev/null"
}

#[cfg(windows)]
fn safe_path() -> &'static str {
    r"C:\Windows\System32"
}

#[cfg(not(windows))]
fn safe_path() -> &'static str {
    "/usr/bin:/bin:/usr/sbin:/sbin"
}

#[cfg(test)]
pub(crate) fn assert_bigquery_contract() {
    onboarding::assert_onboarding_contract();
    runtime::assert_runtime_contract();
    assert!(valid_project_id("campfire-460003"));
    assert!(!valid_project_id("Campfire-460003"));
    assert!(valid_dataset_id("analytics_2026"));
    assert!(!valid_dataset_id("analytics-prod"));
    assert!(valid_location("asia-northeast3"));
    let profile = ConnectionProfile {
        id: Uuid::new_v4(),
        name: "BigQuery fixture".into(),
        engine: crate::model::Engine::Bigquery,
        provider: crate::model::Provider::Generic,
        driver_id: Some("google-bq-cli".into()),
        host: "campfire-460003".into(),
        port: 443,
        database: "analytics_2026".into(),
        username: String::new(),
        sslmode: "require".into(),
        extra_params: HashMap::new(),
        readonly_default: true,
        allow_writes: false,
        secret_ref: None,
        env: None,
        schema_group: None,
        workspace_access: crate::model::WorkspaceConnectionAccess::Local,
        credential_mode: crate::model::WorkspaceCredentialMode::Local,
        provider_target: None,
    };
    assert!(validate_profile(&profile).is_ok());
    assert_eq!(
        maximum_bytes_billed(&profile).expect("default billing ceiling"),
        DEFAULT_MAXIMUM_BYTES_BILLED,
    );
    assert!(validate_profile(&ConnectionProfile {
        sslmode: "disable".into(),
        ..profile.clone()
    })
    .is_err());
    assert!(validate_profile(&ConnectionProfile {
        allow_writes: true,
        ..profile
    })
    .is_err());
    let dry_run = parse_dry_run(
        br#"{
          "statistics": {"query": {
            "statementType": "SELECT",
            "totalBytesProcessed": "42",
            "schema": {"fields": [{"name":"count","type":"INTEGER"}]}
          }}
        }"#,
    )
    .expect("valid dry-run fixture");
    assert_eq!(dry_run.columns, ["count"]);
    assert_eq!(dry_run.total_bytes_processed, Some(42));
    let rows = parse_query_rows(br#"[{"count":"9007199254740993"}]"#, &dry_run.columns)
        .expect("valid row fixture");
    assert_eq!(rows, vec![vec![Value::String("9007199254740993".into())]]);
    assert!(matches!(
        parse_dry_run(
            br#"{"statistics":{"query":{"statementType":"INSERT","schema":{"fields":[]}}}}"#
        ),
        Err(AppError::Blocked { .. })
    ));
}
