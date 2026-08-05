//! Private, capability-bound disk storage for desktop SQL result pages.
//!
//! Result rows never enter the application SQLite database, audit/history, or a
//! renderer-owned aggregate. Each page is an independently bounded JSON file;
//! the immutable manifest is published only after the producer receipt matches
//! every page written by this store.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Duration, Utc};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::executor::read::DESKTOP_STREAM_BATCH_MAX_BYTES;
use crate::kernel::identity::OperationId;
use crate::store::PinnedConnection;

use super::super::domain::{
    DesktopSqlResultExportFormat, DesktopSqlResultExportProgress, DesktopSqlResultExportReceipt,
    DesktopSqlStreamBatch, DesktopSqlStreamSinkError,
};

const RESULT_STORE_SCHEMA_VERSION: u32 = 1;
const RESULT_PAGE_ROWS: usize = 256;
const MAX_MANIFEST_BYTES: u64 = 2 * 1024 * 1024;
const MAX_RETAINED_RESULTS: usize = 40;
const RESULT_RETENTION_DAYS: i64 = 7;

#[derive(Debug, Clone)]
pub(crate) struct DesktopSqlResultAuthority {
    pub(crate) workspace_id: Uuid,
    pub(crate) account_scope: String,
    pub(crate) connection_id: Uuid,
    pub(crate) connection_revision: i64,
    pub(crate) page_count: usize,
    pub(crate) columns: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResultPageMeta {
    sequence: u64,
    row_start: usize,
    row_count: usize,
    encoded_bytes: usize,
    sha256: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResultManifest {
    schema_version: u32,
    operation_id: Uuid,
    workspace_id: Uuid,
    account_scope: String,
    connection_id: Uuid,
    connection_revision: i64,
    owner_webview: String,
    capability_sha256: String,
    columns: Vec<String>,
    page_rows: usize,
    pages: Vec<ResultPageMeta>,
    row_count: usize,
    truncated: bool,
    duration_ms: u64,
    completed_at: DateTime<Utc>,
}

pub(super) struct DesktopSqlResultWriter {
    operation_id: OperationId,
    partial_directory: PathBuf,
    final_directory: PathBuf,
    workspace_id: Uuid,
    account_scope: String,
    connection_id: Uuid,
    connection_revision: i64,
    owner_webview: String,
    capability_sha256: String,
    columns: Vec<String>,
    pages: Vec<ResultPageMeta>,
    row_count: usize,
    published: bool,
}

#[derive(Clone, Default)]
pub(crate) struct DesktopSqlResultStore {
    exports: Arc<Mutex<HashMap<Uuid, ActiveExport>>>,
}

struct ActiveExport {
    operation_id: OperationId,
    owner_webview: String,
    capability_sha256: String,
    cancelled: Arc<AtomicBool>,
}

impl DesktopSqlResultWriter {
    pub(super) fn begin(
        operation_id: OperationId,
        pin: &PinnedConnection,
        owner_webview: &str,
        capability: &str,
    ) -> Result<Self, DesktopSqlStreamSinkError> {
        let root = result_root().map_err(|_| DesktopSqlStreamSinkError::ResultStoreUnavailable)?;
        sweep_result_root(&root).map_err(|_| DesktopSqlStreamSinkError::ResultStoreUnavailable)?;
        let operation_uuid = Uuid::from(operation_id);
        let partial_directory = root.join(format!("{operation_uuid}.partial"));
        let final_directory = root.join(operation_uuid.to_string());
        if partial_directory.exists() || final_directory.exists() {
            return Err(DesktopSqlStreamSinkError::StreamAlreadyActive);
        }
        fs::create_dir(&partial_directory)
            .map_err(|_| DesktopSqlStreamSinkError::ResultStoreUnavailable)?;
        set_private_directory_permissions(&partial_directory)
            .map_err(|_| DesktopSqlStreamSinkError::ResultStoreUnavailable)?;
        Ok(Self {
            operation_id,
            partial_directory,
            final_directory,
            workspace_id: pin.scope.workspace_id,
            account_scope: pin.scope.account_scope.storage_key().to_string(),
            connection_id: pin.connection_id,
            connection_revision: pin.connection_revision,
            owner_webview: owner_webview.to_string(),
            capability_sha256: capability_hash(capability),
            columns: Vec::new(),
            pages: Vec::new(),
            row_count: 0,
            published: false,
        })
    }

    pub(super) fn write_page(
        &mut self,
        batch: &DesktopSqlStreamBatch,
        encoded: &[u8],
    ) -> Result<(), DesktopSqlStreamSinkError> {
        if batch.operation_id != self.operation_id
            || batch.sequence != self.pages.len() as u64
            || batch.rows.len() > RESULT_PAGE_ROWS
            || encoded.len() > DESKTOP_STREAM_BATCH_MAX_BYTES
            || batch
                .rows
                .iter()
                .any(|row| row.len() != batch.columns.len())
        {
            return Err(DesktopSqlStreamSinkError::BatchTooLarge);
        }
        if self.columns.is_empty() {
            self.columns = batch.columns.clone();
        } else if self.columns != batch.columns {
            return Err(DesktopSqlStreamSinkError::InvalidAcknowledgement);
        }
        let path = page_path(&self.partial_directory, batch.sequence);
        write_new_file_atomically(&path, encoded)
            .map_err(|_| DesktopSqlStreamSinkError::ResultStoreUnavailable)?;
        self.pages.push(ResultPageMeta {
            sequence: batch.sequence,
            row_start: self.row_count,
            row_count: batch.rows.len(),
            encoded_bytes: encoded.len(),
            sha256: bytes_sha256(encoded),
        });
        self.row_count = self.row_count.saturating_add(batch.rows.len());
        Ok(())
    }

    pub(super) fn read_page(
        &self,
        sequence: u64,
    ) -> Result<DesktopSqlStreamBatch, DesktopSqlStreamSinkError> {
        let meta = self
            .pages
            .get(sequence as usize)
            .filter(|meta| meta.sequence == sequence)
            .ok_or(DesktopSqlStreamSinkError::InvalidAcknowledgement)?;
        read_verified_page(
            &self.partial_directory,
            meta,
            &self.columns,
            self.operation_id,
        )
    }

    pub(super) fn complete(
        &mut self,
        row_count: usize,
        truncated: bool,
        duration_ms: u64,
    ) -> Result<(), DesktopSqlStreamSinkError> {
        if self.row_count != row_count
            || self
                .pages
                .iter()
                .enumerate()
                .any(|(index, page)| page.sequence != index as u64)
        {
            return Err(DesktopSqlStreamSinkError::ResultReceiptMismatch);
        }
        let manifest = ResultManifest {
            schema_version: RESULT_STORE_SCHEMA_VERSION,
            operation_id: Uuid::from(self.operation_id),
            workspace_id: self.workspace_id,
            account_scope: self.account_scope.clone(),
            connection_id: self.connection_id,
            connection_revision: self.connection_revision,
            owner_webview: self.owner_webview.clone(),
            capability_sha256: self.capability_sha256.clone(),
            columns: self.columns.clone(),
            page_rows: RESULT_PAGE_ROWS,
            pages: self.pages.clone(),
            row_count,
            truncated,
            duration_ms,
            completed_at: Utc::now(),
        };
        let encoded = serde_json::to_vec(&manifest)
            .map_err(|_| DesktopSqlStreamSinkError::ResultStoreUnavailable)?;
        if encoded.len() as u64 > MAX_MANIFEST_BYTES {
            return Err(DesktopSqlStreamSinkError::ResultStoreUnavailable);
        }
        write_new_file_atomically(&self.partial_directory.join("manifest.json"), &encoded)
            .map_err(|_| DesktopSqlStreamSinkError::ResultStoreUnavailable)?;
        fs::rename(&self.partial_directory, &self.final_directory)
            .map_err(|_| DesktopSqlStreamSinkError::ResultStoreUnavailable)?;
        self.published = true;
        Ok(())
    }
}

impl Drop for DesktopSqlResultWriter {
    fn drop(&mut self) {
        if !self.published {
            let _ = remove_result_directory(&self.partial_directory);
        }
    }
}

impl DesktopSqlResultStore {
    pub(super) fn authority(
        &self,
        operation_id: OperationId,
        capability: &str,
        owner_webview: &str,
    ) -> AppResult<DesktopSqlResultAuthority> {
        let manifest = load_authorized_manifest(operation_id, capability, owner_webview)?;
        Ok(DesktopSqlResultAuthority {
            workspace_id: manifest.workspace_id,
            account_scope: manifest.account_scope,
            connection_id: manifest.connection_id,
            connection_revision: manifest.connection_revision,
            page_count: manifest.pages.len(),
            columns: manifest.columns,
        })
    }

    pub(super) fn read_page(
        &self,
        operation_id: OperationId,
        sequence: u64,
        capability: &str,
        owner_webview: &str,
    ) -> AppResult<DesktopSqlStreamBatch> {
        let manifest = load_authorized_manifest(operation_id, capability, owner_webview)?;
        let page = manifest
            .pages
            .get(sequence as usize)
            .filter(|page| page.sequence == sequence)
            .ok_or_else(|| AppError::NotFound("SQL result page".into()))?;
        read_verified_page(
            &completed_directory(operation_id)?,
            page,
            &manifest.columns,
            operation_id,
        )
        .map_err(|error| AppError::Safety(error.to_string()))
    }

    pub(super) fn start_export(
        &self,
        export_id: Uuid,
        operation_id: OperationId,
        capability: &str,
        owner_webview: &str,
    ) -> AppResult<Arc<AtomicBool>> {
        let _ = load_authorized_manifest(operation_id, capability, owner_webview)?;
        let mut exports = lock_exports(&self.exports);
        if exports.contains_key(&export_id) {
            return Err(AppError::Blocked {
                reason: "SQL result export is already active".into(),
            });
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        exports.insert(
            export_id,
            ActiveExport {
                operation_id,
                owner_webview: owner_webview.to_string(),
                capability_sha256: capability_hash(capability),
                cancelled: Arc::clone(&cancelled),
            },
        );
        Ok(cancelled)
    }

    pub(super) fn finish_export(&self, export_id: Uuid) {
        lock_exports(&self.exports).remove(&export_id);
    }

    pub(super) fn cancel_export(
        &self,
        export_id: Uuid,
        operation_id: OperationId,
        capability: &str,
        owner_webview: &str,
    ) -> bool {
        let exports = lock_exports(&self.exports);
        let Some(export) = exports.get(&export_id) else {
            return false;
        };
        if export.operation_id != operation_id
            || export.owner_webview != owner_webview
            || !hash_matches(&export.capability_sha256, capability)
        {
            return false;
        }
        export.cancelled.store(true, Ordering::Release);
        true
    }

    pub(super) fn export_to_path(
        &self,
        export_id: Uuid,
        operation_id: OperationId,
        capability: &str,
        owner_webview: &str,
        format: DesktopSqlResultExportFormat,
        destination: PathBuf,
        cancelled: Arc<AtomicBool>,
        mut progress: impl FnMut(DesktopSqlResultExportProgress) -> AppResult<()>,
    ) -> AppResult<DesktopSqlResultExportReceipt> {
        let manifest = load_authorized_manifest(operation_id, capability, owner_webview)?;
        let parent = destination.parent().ok_or_else(|| AppError::Blocked {
            reason: "SQL result export destination has no parent directory".into(),
        })?;
        ensure_real_directory(parent)?;
        if let Ok(metadata) = fs::symlink_metadata(&destination) {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(AppError::Blocked {
                    reason: "SQL result export destination is not a regular file".into(),
                });
            }
        }
        let partial = parent.join(format!(".dopedb-result-{export_id}.partial"));
        if partial.exists() {
            return Err(AppError::Blocked {
                reason: "SQL result export partial file already exists".into(),
            });
        }
        let result = export_manifest(
            export_id,
            &manifest,
            operation_id,
            format,
            &partial,
            &cancelled,
            &mut progress,
        );
        match result {
            Ok(rows_written) => {
                replace_file(&partial, &destination)?;
                Ok(DesktopSqlResultExportReceipt {
                    export_id,
                    operation_id,
                    rows_written,
                })
            }
            Err(error) => {
                let _ = fs::remove_file(&partial);
                Err(error)
            }
        }
    }
}

fn export_manifest(
    export_id: Uuid,
    manifest: &ResultManifest,
    operation_id: OperationId,
    format: DesktopSqlResultExportFormat,
    partial: &Path,
    cancelled: &AtomicBool,
    progress: &mut impl FnMut(DesktopSqlResultExportProgress) -> AppResult<()>,
) -> AppResult<usize> {
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(partial)?;
    let mut rows_written = 0_usize;
    match format {
        DesktopSqlResultExportFormat::Csv => {
            let mut writer = csv::WriterBuilder::new()
                .has_headers(false)
                .from_writer(BufWriter::new(file));
            writer.write_record(&manifest.columns).map_err(csv_error)?;
            for page in &manifest.pages {
                ensure_export_open(cancelled)?;
                let batch = read_verified_page(
                    &completed_directory(operation_id)?,
                    page,
                    &manifest.columns,
                    operation_id,
                )
                .map_err(|error| AppError::Safety(error.to_string()))?;
                for row in batch.rows {
                    writer
                        .write_record(row.iter().map(csv_cell))
                        .map_err(csv_error)?;
                    rows_written = rows_written.saturating_add(1);
                }
                progress(DesktopSqlResultExportProgress {
                    export_id,
                    operation_id,
                    rows_written,
                    total_rows: manifest.row_count,
                })?;
            }
            writer.flush()?;
            let writer = writer
                .into_inner()
                .map_err(|error| AppError::Io(error.into_error()))?;
            writer.get_ref().sync_all()?;
        }
        DesktopSqlResultExportFormat::Json => {
            let mut writer = BufWriter::new(file);
            writer.write_all(b"[")?;
            for page in &manifest.pages {
                ensure_export_open(cancelled)?;
                let batch = read_verified_page(
                    &completed_directory(operation_id)?,
                    page,
                    &manifest.columns,
                    operation_id,
                )
                .map_err(|error| AppError::Safety(error.to_string()))?;
                for row in batch.rows {
                    if rows_written > 0 {
                        writer.write_all(b",")?;
                    }
                    let object = manifest
                        .columns
                        .iter()
                        .cloned()
                        .zip(row.into_iter())
                        .collect::<serde_json::Map<_, _>>();
                    serde_json::to_writer(&mut writer, &object)?;
                    rows_written = rows_written.saturating_add(1);
                }
                progress(DesktopSqlResultExportProgress {
                    export_id,
                    operation_id,
                    rows_written,
                    total_rows: manifest.row_count,
                })?;
            }
            writer.write_all(b"]")?;
            writer.flush()?;
            writer.get_ref().sync_all()?;
        }
    }
    ensure_export_open(cancelled)?;
    if rows_written != manifest.row_count {
        return Err(AppError::OutcomeUnknown(
            "stored SQL result row count changed during export".into(),
        ));
    }
    Ok(rows_written)
}

fn csv_cell(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => String::new(),
        serde_json::Value::String(value) => value.clone(),
        other => other.to_string(),
    }
}

fn csv_error(error: csv::Error) -> AppError {
    match error.into_kind() {
        csv::ErrorKind::Io(error) => AppError::Io(error),
        other => AppError::Config(format!("SQL result CSV export failed: {other:?}")),
    }
}

fn ensure_export_open(cancelled: &AtomicBool) -> AppResult<()> {
    if cancelled.load(Ordering::Acquire) {
        Err(AppError::Safety("SQL result export cancelled".into()))
    } else {
        Ok(())
    }
}

fn result_root() -> AppResult<PathBuf> {
    let root = dirs::data_dir()
        .ok_or_else(|| AppError::Config("no OS data directory".into()))?
        .join("dopedb")
        .join("query-results-v1");
    fs::create_dir_all(&root)?;
    ensure_real_directory(&root)?;
    set_private_directory_permissions(&root)?;
    Ok(root)
}

fn completed_directory(operation_id: OperationId) -> AppResult<PathBuf> {
    Ok(result_root()?.join(Uuid::from(operation_id).to_string()))
}

fn load_authorized_manifest(
    operation_id: OperationId,
    capability: &str,
    owner_webview: &str,
) -> AppResult<ResultManifest> {
    let directory = completed_directory(operation_id)?;
    ensure_real_directory(&directory)?;
    let path = directory.join("manifest.json");
    let metadata = fs::symlink_metadata(&path)?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_MANIFEST_BYTES
    {
        return Err(AppError::Blocked {
            reason: "SQL result manifest is not a bounded regular file".into(),
        });
    }
    let manifest: ResultManifest = serde_json::from_reader(File::open(path)?)?;
    if manifest.schema_version != RESULT_STORE_SCHEMA_VERSION
        || manifest.operation_id != Uuid::from(operation_id)
        || manifest.page_rows != RESULT_PAGE_ROWS
        || manifest.owner_webview != owner_webview
        || !hash_matches(&manifest.capability_sha256, capability)
        || manifest.row_count
            != manifest
                .pages
                .iter()
                .map(|page| page.row_count)
                .sum::<usize>()
        || manifest.pages.iter().enumerate().any(|(index, page)| {
            page.sequence != index as u64
                || page.encoded_bytes > DESKTOP_STREAM_BATCH_MAX_BYTES
                || page.row_count > RESULT_PAGE_ROWS
        })
        || !page_ranges_are_contiguous(&manifest.pages)
    {
        return Err(AppError::Blocked {
            reason: "SQL result capability or manifest is invalid".into(),
        });
    }
    Ok(manifest)
}

fn page_ranges_are_contiguous(pages: &[ResultPageMeta]) -> bool {
    let mut expected_start = 0_usize;
    for page in pages {
        if page.row_start != expected_start {
            return false;
        }
        expected_start = expected_start.saturating_add(page.row_count);
    }
    true
}

fn read_verified_page(
    directory: &Path,
    meta: &ResultPageMeta,
    columns: &[String],
    operation_id: OperationId,
) -> Result<DesktopSqlStreamBatch, DesktopSqlStreamSinkError> {
    let path = page_path(directory, meta.sequence);
    let metadata = fs::symlink_metadata(&path)
        .map_err(|_| DesktopSqlStreamSinkError::ResultStoreUnavailable)?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() as usize != meta.encoded_bytes
        || metadata.len() as usize > DESKTOP_STREAM_BATCH_MAX_BYTES
    {
        return Err(DesktopSqlStreamSinkError::ResultStoreUnavailable);
    }
    let encoded = fs::read(path).map_err(|_| DesktopSqlStreamSinkError::ResultStoreUnavailable)?;
    if bytes_sha256(&encoded) != meta.sha256 {
        return Err(DesktopSqlStreamSinkError::ResultStoreUnavailable);
    }
    let batch: DesktopSqlStreamBatch = serde_json::from_slice(&encoded)
        .map_err(|_| DesktopSqlStreamSinkError::ResultStoreUnavailable)?;
    if batch.operation_id != operation_id
        || batch.sequence != meta.sequence
        || batch.columns != columns
        || batch.rows.len() != meta.row_count
        || batch.rows.iter().any(|row| row.len() != columns.len())
    {
        return Err(DesktopSqlStreamSinkError::ResultStoreUnavailable);
    }
    Ok(batch)
}

fn page_path(directory: &Path, sequence: u64) -> PathBuf {
    directory.join(format!("page-{sequence:020}.json"))
}

fn write_new_file_atomically(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let partial = path.with_extension("tmp");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&partial)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    fs::rename(partial, path)
}

fn ensure_real_directory(path: &Path) -> AppResult<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(AppError::Blocked {
            reason: "SQL result storage is not an app-owned directory".into(),
        });
    }
    Ok(())
}

#[cfg(unix)]
fn set_private_directory_permissions(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn set_private_directory_permissions(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

fn remove_result_directory(path: &Path) -> AppResult<()> {
    let root = result_root()?;
    if path.parent() != Some(root.as_path()) {
        return Err(AppError::Blocked {
            reason: "refusing to remove a directory outside SQL result storage".into(),
        });
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            Err(AppError::Blocked {
                reason: "refusing to remove an invalid SQL result directory".into(),
            })
        }
        Ok(_) => {
            fs::remove_dir_all(path)?;
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn sweep_result_root(root: &Path) -> AppResult<()> {
    let cutoff = Utc::now() - Duration::days(RESULT_RETENTION_DAYS);
    let mut completed = Vec::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.ends_with(".partial") {
            let modified = metadata.modified().ok().map(DateTime::<Utc>::from);
            if modified.is_some_and(|value| value < Utc::now() - Duration::hours(24)) {
                remove_result_directory(&path)?;
            }
            continue;
        }
        if Uuid::parse_str(&name).is_err() {
            continue;
        }
        let manifest = match fs::symlink_metadata(path.join("manifest.json")) {
            Ok(manifest)
                if !manifest.file_type().is_symlink()
                    && manifest.is_file()
                    && manifest.len() <= MAX_MANIFEST_BYTES =>
            {
                manifest
            }
            Ok(_) | Err(_) => {
                // A crash or local corruption in one exact app-owned result
                // directory must not block every later query. Keep recent
                // evidence, then let the ordinary 24-hour partial window reap it.
                let modified = metadata.modified().ok().map(DateTime::<Utc>::from);
                if modified.is_some_and(|value| value < Utc::now() - Duration::hours(24)) {
                    remove_result_directory(&path)?;
                }
                continue;
            }
        };
        let modified = manifest
            .modified()
            .ok()
            .map(DateTime::<Utc>::from)
            .unwrap_or_else(Utc::now);
        completed.push((modified, path));
    }
    completed.sort_by_key(|(modified, _)| *modified);
    let excess = completed.len().saturating_sub(MAX_RETAINED_RESULTS);
    for (index, (modified, path)) in completed.into_iter().enumerate() {
        if modified < cutoff || index < excess {
            remove_result_directory(&path)?;
        }
    }
    Ok(())
}

fn capability_hash(capability: &str) -> String {
    bytes_sha256(capability.as_bytes())
}

fn bytes_sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn hash_matches(expected: &str, capability: &str) -> bool {
    let actual = capability_hash(capability);
    expected.len() == actual.len() && bool::from(expected.as_bytes().ct_eq(actual.as_bytes()))
}

fn lock_exports(
    exports: &Mutex<HashMap<Uuid, ActiveExport>>,
) -> std::sync::MutexGuard<'_, HashMap<Uuid, ActiveExport>> {
    exports
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(windows)]
fn replace_file(partial: &Path, output: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let partial = partial
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let output = output
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let moved = unsafe {
        MoveFileExW(
            partial.as_ptr(),
            output.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(partial: &Path, output: &Path) -> std::io::Result<()> {
    fs::rename(partial, output)
}
