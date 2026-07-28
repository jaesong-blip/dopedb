//! Private input snapshots and renderer-safe output capabilities.

use std::collections::HashSet;
use std::ffi::OsStr;
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use chrono::Utc;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::model::Engine;

use super::super::ports::{InputReview, JobFilePort, PreparedJobFile};
use super::super::{JobFormat, JobInputInspection};
use super::format;

const MAX_INPUT_BYTES: u64 = 100 * 1024 * 1024 * 1024;

#[derive(Clone, Copy)]
pub(in crate::features::jobs) struct LocalJobFiles;

impl JobFilePort for LocalJobFiles {
    async fn snapshot_input(&self, path: PathBuf) -> AppResult<PreparedJobFile> {
        tokio::task::spawn_blocking(move || snapshot_input(path))
            .await
            .map_err(|_| AppError::Config("input file inspection stopped".into()))?
    }

    async fn prepare_output(&self, path: PathBuf) -> AppResult<PreparedJobFile> {
        tokio::task::spawn_blocking(move || canonical_output(path))
            .await
            .map_err(|_| AppError::Config("output file inspection stopped".into()))?
    }

    async fn inspect_input(
        &self,
        path: PathBuf,
        format: JobFormat,
        engine: Engine,
        expected_hash: String,
    ) -> AppResult<JobInputInspection> {
        tokio::task::spawn_blocking(move || {
            format::inspect_input_verified(&path, format, engine, &expected_hash)
        })
        .await
        .map_err(|_| AppError::Config("input inspection stopped unexpectedly".into()))?
    }

    async fn review_input(
        &self,
        path: PathBuf,
        format: JobFormat,
        engine: Engine,
        expected_hash: String,
    ) -> AppResult<InputReview> {
        tokio::task::spawn_blocking(move || {
            format::review_input_verified(&path, format, engine, &expected_hash)
        })
        .await
        .map_err(|_| AppError::Config("input validation stopped unexpectedly".into()))?
    }

    async fn remove_private_input(&self, path: PathBuf) -> AppResult<()> {
        tokio::task::spawn_blocking(move || remove_staged_input(&path))
            .await
            .map_err(|_| AppError::Config("private input cleanup stopped unexpectedly".into()))?
    }

    async fn sweep_private_inputs(&self, active_paths: Vec<PathBuf>) -> AppResult<()> {
        tokio::task::spawn_blocking(move || sweep_staged_inputs(active_paths))
            .await
            .map_err(|_| AppError::Config("private input sweep stopped unexpectedly".into()))?
    }
}

fn snapshot_input(path: PathBuf) -> AppResult<PreparedJobFile> {
    let directory = job_input_directory()?;
    std::fs::create_dir_all(&directory)?;
    let metadata = std::fs::symlink_metadata(&directory)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(AppError::Blocked {
            reason: "job input storage is not a regular app-owned directory".into(),
        });
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))?;
    }
    snapshot_input_to(path, &directory)
}

fn job_input_directory() -> AppResult<PathBuf> {
    Ok(dirs::data_dir()
        .ok_or_else(|| AppError::Config("no OS data directory".into()))?
        .join("dopedb")
        .join("job-inputs"))
}

fn remove_staged_input(path: &Path) -> AppResult<()> {
    let directory = job_input_directory()?;
    remove_staged_input_from(&directory, path)
}

fn remove_staged_input_from(directory: &Path, path: &Path) -> AppResult<()> {
    let metadata = match std::fs::symlink_metadata(directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    let filename = path
        .file_name()
        .and_then(|value| value.to_str())
        .and_then(|value| value.strip_suffix(".input"))
        .and_then(|value| Uuid::parse_str(value).ok());
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || path.parent() != Some(directory)
        || filename.is_none()
    {
        return Err(AppError::Blocked {
            reason: "refusing to remove a file outside private job input storage".into(),
        });
    }
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => Err(AppError::Blocked {
            reason: "private job input was replaced by a directory".into(),
        }),
        Ok(_) => {
            std::fs::remove_file(path)?;
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn sweep_staged_inputs(active_paths: Vec<PathBuf>) -> AppResult<()> {
    let directory = job_input_directory()?;
    sweep_staged_inputs_in(&directory, active_paths)
}

fn sweep_staged_inputs_in(directory: &Path, active_paths: Vec<PathBuf>) -> AppResult<()> {
    let metadata = match std::fs::symlink_metadata(directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(AppError::Blocked {
            reason: "job input storage is not a regular app-owned directory".into(),
        });
    }
    let active_paths = active_paths.into_iter().collect::<HashSet<_>>();
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        let is_private_input = path
            .file_name()
            .and_then(OsStr::to_str)
            .and_then(|value| value.strip_suffix(".input"))
            .is_some_and(|value| Uuid::parse_str(value).is_ok());
        if is_private_input && !active_paths.contains(&path) {
            remove_staged_input_from(directory, &path)?;
        }
    }
    Ok(())
}

fn snapshot_input_to(path: PathBuf, directory: &Path) -> AppResult<PreparedJobFile> {
    let path = std::fs::canonicalize(path)?;
    let display_name = display_name(&path)?;
    let mut input_options = OpenOptions::new();
    input_options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        input_options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        input_options
            .custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let mut input = input_options.open(&path)?;
    let metadata = input.metadata()?;
    if !metadata.is_file() || metadata.len() > MAX_INPUT_BYTES {
        return Err(AppError::Config(
            "input must be a regular file no larger than 100 GiB".into(),
        ));
    }
    let modified_at = metadata
        .modified()
        .ok()
        .map(chrono::DateTime::<Utc>::from)
        .map(|value| value.to_rfc3339());
    let snapshot_path = directory.join(format!("{}.input", Uuid::new_v4()));
    let result = (|| -> AppResult<PreparedJobFile> {
        let mut output_options = OpenOptions::new();
        output_options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            output_options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            output_options.custom_flags(
                windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT,
            );
        }
        let mut output = output_options.open(&snapshot_path)?;
        let mut hasher = Sha256::new();
        let mut size_bytes = 0_u64;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = input.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            size_bytes = size_bytes
                .checked_add(read as u64)
                .ok_or_else(|| AppError::Config("input file size overflowed".into()))?;
            if size_bytes > MAX_INPUT_BYTES {
                return Err(AppError::Config(
                    "input must be a regular file no larger than 100 GiB".into(),
                ));
            }
            hasher.update(&buffer[..read]);
            output.write_all(&buffer[..read])?;
        }
        output.flush()?;
        output.sync_all()?;
        Ok(PreparedJobFile {
            path: snapshot_path.clone(),
            display_name,
            size_bytes,
            modified_at,
            source_sha256: Some(hex::encode(hasher.finalize())),
        })
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&snapshot_path);
    }
    result
}

fn canonical_output(path: PathBuf) -> AppResult<PreparedJobFile> {
    let filename = path
        .file_name()
        .ok_or_else(|| AppError::Config("output filename is missing".into()))?
        .to_owned();
    let parent = std::fs::canonicalize(
        path.parent()
            .ok_or_else(|| AppError::Config("output directory is missing".into()))?,
    )?;
    if !std::fs::metadata(&parent)?.is_dir() {
        return Err(AppError::Config("output parent is not a directory".into()));
    }
    let path = parent.join(filename);
    if std::fs::symlink_metadata(&path)
        .is_ok_and(|metadata| metadata.file_type().is_symlink() || metadata.is_dir())
    {
        return Err(AppError::Blocked {
            reason: "output cannot replace a symlink or directory".into(),
        });
    }
    Ok(PreparedJobFile {
        display_name: display_name(&path)?,
        path,
        size_bytes: 0,
        modified_at: None,
        source_sha256: None,
    })
}

fn display_name(path: &Path) -> AppResult<String> {
    path.file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| AppError::Config("selected filename is not valid Unicode".into()))
}
