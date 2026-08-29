//! Managed BigQuery runtime marker verification and command environments.

use super::*;

pub(super) fn write_marker(runtime: &Path, sdk_artifact: Artifact) -> AppResult<()> {
    let sdk = runtime.join("google-cloud-sdk");
    let gcloud = sdk.join("bin").join(if cfg!(windows) {
        "gcloud.cmd"
    } else {
        "gcloud"
    });
    let bq = sdk
        .join("bin")
        .join(if cfg!(windows) { "bq.cmd" } else { "bq" });
    let python = managed_python_path(runtime);
    let marker = InstalledMarker {
        schema_version: MARKER_SCHEMA_VERSION,
        sdk_version: SDK_VERSION.into(),
        platform: platform_id().unwrap_or("unsupported").into(),
        sdk_archive_sha256: sdk_artifact.sha256.into(),
        python_archive_sha256: cfg!(target_os = "macos").then(|| PYTHON_ARCHIVE.sha256.into()),
        gcloud_sha256: sha256_regular_file(&gcloud, MAX_ARCHIVE_FILE_BYTES)?,
        bq_sha256: sha256_regular_file(&bq, MAX_ARCHIVE_FILE_BYTES)?,
        python_sha256: sha256_regular_file(&python, MAX_ARCHIVE_FILE_BYTES)?,
        python_library_sha256: managed_python_library(runtime)
            .map(|path| sha256_regular_file(&path, MAX_ARCHIVE_FILE_BYTES))
            .transpose()?,
        launcher_sha256: managed_launcher(runtime)
            .map(|path| sha256_regular_file(&path, MAX_ARCHIVE_FILE_BYTES))
            .transpose()?,
    };
    let mut bytes = serde_json::to_vec_pretty(&marker)?;
    bytes.push(b'\n');
    let path = runtime.join("installed.json");
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&path)?;
    use std::io::Write;
    output.write_all(&bytes)?;
    output.sync_all()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

pub(super) fn verify_installed(runtime: &Path) -> AppResult<()> {
    let metadata = fs::symlink_metadata(runtime)
        .map_err(|_| AppError::Config("the managed Google Cloud CLI is not installed".into()))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(AppError::Blocked {
            reason: "the managed Google Cloud CLI directory has an unsafe file type".into(),
        });
    }
    let marker_path = runtime.join("installed.json");
    checked_regular_file(&marker_path, MAX_MARKER_BYTES)?;
    let marker: InstalledMarker = serde_json::from_slice(&fs::read(&marker_path)?)?;
    let artifact = sdk_artifact().ok_or_else(|| {
        AppError::Config("the current platform has no managed Google Cloud CLI artifact".into())
    })?;
    if marker.schema_version != MARKER_SCHEMA_VERSION
        || marker.sdk_version != SDK_VERSION
        || marker.platform != platform_id().unwrap_or("unsupported")
        || marker.sdk_archive_sha256 != artifact.sha256
        || marker.python_archive_sha256
            != cfg!(target_os = "macos").then(|| PYTHON_ARCHIVE.sha256.into())
    {
        return Err(AppError::Blocked {
            reason: "the managed Google Cloud CLI installation marker is invalid".into(),
        });
    }
    validate_sdk_layout(runtime)?;
    let sdk = runtime.join("google-cloud-sdk");
    let gcloud = sdk.join("bin").join(if cfg!(windows) {
        "gcloud.cmd"
    } else {
        "gcloud"
    });
    let bq = sdk
        .join("bin")
        .join(if cfg!(windows) { "bq.cmd" } else { "bq" });
    if sha256_regular_file(&gcloud, MAX_ARCHIVE_FILE_BYTES)? != marker.gcloud_sha256
        || sha256_regular_file(&bq, MAX_ARCHIVE_FILE_BYTES)? != marker.bq_sha256
        || sha256_regular_file(&managed_python_path(runtime), MAX_ARCHIVE_FILE_BYTES)?
            != marker.python_sha256
        || managed_python_library(runtime)
            .map(|path| sha256_regular_file(&path, MAX_ARCHIVE_FILE_BYTES))
            .transpose()?
            != marker.python_library_sha256
        || managed_launcher(runtime)
            .map(|path| sha256_regular_file(&path, MAX_ARCHIVE_FILE_BYTES))
            .transpose()?
            != marker.launcher_sha256
    {
        return Err(AppError::Blocked {
            reason: "the managed Google Cloud CLI entrypoints changed after verification".into(),
        });
    }
    Ok(())
}

pub(super) fn managed_python_path(runtime: &Path) -> PathBuf {
    #[cfg(target_os = "macos")]
    return runtime
        .join("python/Python.framework/Versions")
        .join(PYTHON_VERSION)
        .join("bin/python3.14");
    #[cfg(windows)]
    return runtime.join("google-cloud-sdk/platform/bundledpython/python.exe");
    #[allow(unreachable_code)]
    runtime.join("unsupported-python")
}

pub(super) fn managed_python_library(runtime: &Path) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    return Some(
        runtime
            .join("python/Python.framework/Versions")
            .join(PYTHON_VERSION)
            .join("Python"),
    );
    #[allow(unreachable_code)]
    None
}

pub(super) fn managed_launcher(runtime: &Path) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    return Some(runtime.join("bin/python-launcher.sh"));
    #[allow(unreachable_code)]
    None
}

pub(super) fn managed_environment(runtime: &Path) -> CommandEnvironment {
    let mut environment = sdk_environment(&runtime.join("google-cloud-sdk"));
    #[cfg(target_os = "macos")]
    {
        let version = runtime
            .join("python/Python.framework/Versions")
            .join(PYTHON_VERSION);
        environment.variables.extend([
            (
                OsString::from("CLOUDSDK_PYTHON"),
                runtime.join("bin/python-launcher.sh").into_os_string(),
            ),
            (
                OsString::from("DOPEDB_MANAGED_PYTHON"),
                version.join("bin/python3.14").into_os_string(),
            ),
            (
                OsString::from("DOPEDB_MANAGED_FRAMEWORK_PATH"),
                runtime.join("python").into_os_string(),
            ),
            (
                OsString::from("DOPEDB_MANAGED_LIBRARY_PATH"),
                version.join("lib").into_os_string(),
            ),
        ]);
    }
    environment
}

pub(super) fn sdk_environment(sdk_root: &Path) -> CommandEnvironment {
    let mut paths = vec![sdk_root.join("bin")];
    #[cfg(windows)]
    let mut variables = Vec::new();
    #[cfg(windows)]
    if let Some((system_root, system_directory, command_processor)) =
        audited_windows_system_environment()
    {
        paths.push(system_directory);
        variables.extend([
            (
                OsString::from("SystemRoot"),
                system_root.clone().into_os_string(),
            ),
            (OsString::from("WINDIR"), system_root.into_os_string()),
            (
                OsString::from("ComSpec"),
                command_processor.into_os_string(),
            ),
        ]);
        let temporary = std::env::temp_dir();
        if audited_windows_directory(&temporary) {
            variables.extend([
                (OsString::from("TEMP"), temporary.clone().into_os_string()),
                (OsString::from("TMP"), temporary.into_os_string()),
            ]);
        }
    }
    #[cfg(not(windows))]
    let mut variables = Vec::new();
    #[cfg(not(windows))]
    paths.extend([
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
        PathBuf::from("/usr/sbin"),
        PathBuf::from("/sbin"),
    ]);
    if let Ok(path) = std::env::join_paths(paths) {
        variables.push((OsString::from("PATH"), path));
    }
    CommandEnvironment { variables }
}

#[cfg(windows)]
pub(super) fn audited_windows_system_environment() -> Option<(PathBuf, PathBuf, PathBuf)> {
    let system_root = windows_environment_value("SystemRoot").map(PathBuf::from)?;
    if !audited_windows_directory(&system_root) {
        return None;
    }
    let system_directory = system_root.join("System32");
    let command_processor = system_directory.join("cmd.exe");
    let command_metadata = fs::symlink_metadata(&command_processor).ok()?;
    if !audited_windows_directory(&system_directory)
        || !command_metadata.is_file()
        || command_metadata.file_type().is_symlink()
    {
        return None;
    }
    Some((system_root, system_directory, command_processor))
}

#[cfg(windows)]
pub(super) fn audited_windows_directory(path: &Path) -> bool {
    if !path.is_absolute() || path_has_unsafe_characters(path) {
        return false;
    }
    fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
}

#[cfg(windows)]
pub(super) fn windows_environment_value(name: &str) -> Option<OsString> {
    std::env::vars_os()
        .find(|(key, _)| key.to_string_lossy().eq_ignore_ascii_case(name))
        .map(|(_, value)| value)
}

#[cfg(windows)]
pub(super) fn path_has_unsafe_characters(path: &Path) -> bool {
    path.to_string_lossy().chars().any(|value| {
        value.is_control()
            || matches!(
                value,
                '\u{061c}'
                    | '\u{200e}'
                    | '\u{200f}'
                    | '\u{202a}'..='\u{202e}'
                    | '\u{2066}'..='\u{2069}'
                    | '\u{feff}'
            )
    })
}
