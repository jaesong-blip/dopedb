//! Runtime discovery path, atomic publication, and owner-only permissions.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use dopedb_protocol::{RuntimeDiscovery, RUNTIME_DIRECTORY_NAME, RUNTIME_FILE_NAME};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::kernel::identity::RuntimeId;

const PRODUCTION_APP_IDENTIFIER: &str = "dev.dopedb.desktop";
const DEVELOPMENT_APP_IDENTIFIER: &str = "dev.dopedb.desktop.dev";
#[cfg(feature = "packaged-benchmark")]
const BENCHMARK_APP_IDENTIFIER: &str = "dev.dopedb.desktop.benchmark";

pub(crate) fn runtime_file_for_identifier(app_identifier: &str) -> AppResult<PathBuf> {
    #[cfg(feature = "packaged-benchmark")]
    if app_identifier == BENCHMARK_APP_IDENTIFIER {
        return Ok(crate::app_paths::data_root()?
            .join(RUNTIME_DIRECTORY_NAME)
            .join(RUNTIME_FILE_NAME));
    }
    let data_directory = match app_identifier {
        PRODUCTION_APP_IDENTIFIER => "dopedb",
        DEVELOPMENT_APP_IDENTIFIER => "dopedb-dev",
        _ => {
            return Err(AppError::Config(
                "the app identifier has no Broker runtime namespace".into(),
            ));
        }
    };
    let base = dirs::data_dir()
        .ok_or_else(|| AppError::Config("no OS data directory is available".into()))?;
    Ok(base
        .join(data_directory)
        .join(RUNTIME_DIRECTORY_NAME)
        .join(RUNTIME_FILE_NAME))
}

pub(crate) fn runtime_directory(runtime_file: &Path) -> AppResult<&Path> {
    runtime_file
        .parent()
        .ok_or_else(|| AppError::Config("runtime discovery file has no parent directory".into()))
}

pub(crate) fn prepare_runtime_directory(runtime_file: &Path) -> AppResult<PathBuf> {
    let directory = runtime_directory(runtime_file)?;
    fs::create_dir_all(directory)?;
    restrict(directory, true)?;
    Ok(directory.to_path_buf())
}

pub(crate) fn publish(runtime_file: &Path, discovery: &RuntimeDiscovery) -> AppResult<()> {
    discovery
        .validate()
        .map_err(|_| AppError::Config("runtime discovery metadata is invalid".into()))?;
    let directory = prepare_runtime_directory(runtime_file)?;

    let temporary = directory.join(format!(".runtime-{}.tmp", Uuid::new_v4()));
    let write_result = (|| -> AppResult<()> {
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        serde_json::to_writer(&mut file, discovery)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        restrict(&temporary, false)?;
        atomic_replace(&temporary, runtime_file)?;
        restrict(runtime_file, false)?;
        if let Ok(directory_file) = OpenOptions::new().read(true).open(&directory) {
            let _ = directory_file.sync_all();
        }
        Ok(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result
}

pub(crate) fn remove_if_owned(runtime_file: &Path, runtime_id: RuntimeId) {
    let owned = fs::read(runtime_file)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<RuntimeDiscovery>(&bytes).ok())
        .is_some_and(|discovery| RuntimeId::from(discovery.runtime_id()) == runtime_id);
    if owned {
        let _ = fs::remove_file(runtime_file);
    }
}

#[cfg(unix)]
fn restrict(path: &Path, directory: bool) -> AppResult<()> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(
        path,
        fs::Permissions::from_mode(if directory { 0o700 } else { 0o600 }),
    )?;
    Ok(())
}

#[cfg(windows)]
fn restrict(path: &Path, _directory: bool) -> AppResult<()> {
    super::peer::restrict_path_to_current_user(path)
}

#[cfg(unix)]
fn atomic_replace(from: &Path, to: &Path) -> AppResult<()> {
    fs::rename(from, to)?;
    Ok(())
}

#[cfg(windows)]
fn atomic_replace(from: &Path, to: &Path) -> AppResult<()> {
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let from = from
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let to = to
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let moved = unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}
