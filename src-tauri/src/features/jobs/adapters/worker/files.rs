use std::fs::File;
use std::path::{Path, PathBuf};

use dopedb_protocol::ObjectRef;

use crate::error::{AppError, AppResult};
use crate::kernel::identity::JobId;
use crate::model::Engine;

pub(super) fn quoted_relation(engine: Engine, relation: &ObjectRef) -> String {
    let name = quote_identifier(engine, &relation.name);
    match relation.namespace.as_deref() {
        Some(namespace) if !namespace.is_empty() && engine != Engine::Sqlite => {
            format!("{}.{}", quote_identifier(engine, namespace), name)
        }
        _ => name,
    }
}

pub(super) fn quote_identifier(engine: Engine, value: &str) -> String {
    if engine == Engine::Mysql {
        format!("`{}`", value.replace('`', "``"))
    } else {
        format!("\"{}\"", value.replace('"', "\"\""))
    }
}

pub(super) fn partial_path(path: &Path, job_id: JobId) -> AppResult<PathBuf> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::Config("output path has no parent directory".into()))?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| AppError::Config("output filename is invalid".into()))?;
    Ok(parent.join(format!(".{name}.dopedb-{job_id}.part")))
}

pub(super) fn finalize_output(partial: &Path, output: &Path) -> AppResult<()> {
    validate_output_parent(output)?;
    if std::fs::symlink_metadata(output)
        .is_ok_and(|metadata| metadata.file_type().is_symlink() || metadata.is_dir())
    {
        return Err(AppError::Blocked {
            reason: "output destination changed to a symlink or directory".into(),
        });
    }
    replace_file(partial, output).map_err(|error| {
        AppError::Config(format!(
            "could not atomically publish the output file; the partial file was retained: {error}"
        ))
    })?;
    #[cfg(unix)]
    if let Some(parent) = output.parent() {
        File::open(parent)?.sync_all()?;
    }
    Ok(())
}

pub(super) fn validate_output_parent(output: &Path) -> AppResult<()> {
    let parent = output
        .parent()
        .ok_or_else(|| AppError::Config("output path has no parent directory".into()))?;
    let canonical = parent.canonicalize()?;
    if canonical != parent || !std::fs::symlink_metadata(parent)?.is_dir() {
        return Err(AppError::Blocked {
            reason: "output directory changed after the file permission was issued".into(),
        });
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_file(partial: &Path, output: &Path) -> std::io::Result<()> {
    std::fs::rename(partial, output)
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

pub(super) fn error_artifact_path(job_id: JobId) -> AppResult<PathBuf> {
    let directory = dirs::data_dir()
        .ok_or_else(|| AppError::Config("no OS data directory".into()))?
        .join("dopedb")
        .join("job-artifacts");
    std::fs::create_dir_all(&directory)?;
    let metadata = std::fs::symlink_metadata(&directory)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(AppError::Blocked {
            reason: "job artifact storage is not a regular app-owned directory".into(),
        });
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(directory.join(format!("{job_id}.errors.ndjson")))
}

pub(super) fn file_len(path: &Path) -> AppResult<u64> {
    Ok(std::fs::metadata(path)?.len())
}
