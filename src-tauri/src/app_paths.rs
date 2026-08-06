//! Application-owned filesystem roots.
//!
//! Production uses the OS directories exactly as before. The packaged performance
//! harness compiles a separate feature and must provide isolated directories below
//! the OS temp root so it can never open the user's DopeDB store or home-owned files.

use std::path::PathBuf;

#[cfg(feature = "packaged-benchmark")]
use std::path::{Component, Path};

use crate::error::{AppError, AppResult};

#[cfg(feature = "packaged-benchmark")]
const BENCHMARK_PREFIX: &str = "dopedb-packaged-benchmark-";

pub(crate) fn data_root() -> AppResult<PathBuf> {
    #[cfg(feature = "packaged-benchmark")]
    {
        isolated_directory("DOPEDB_PACKAGED_BENCHMARK_DATA_DIR")
    }
    #[cfg(not(feature = "packaged-benchmark"))]
    {
        Ok(dirs::data_dir()
            .ok_or_else(|| AppError::Config("no OS data directory is available".into()))?
            .join("dopedb"))
    }
}

pub(crate) fn home_dir() -> AppResult<PathBuf> {
    #[cfg(feature = "packaged-benchmark")]
    {
        isolated_directory("DOPEDB_PACKAGED_BENCHMARK_HOME_DIR")
    }
    #[cfg(not(feature = "packaged-benchmark"))]
    {
        dirs::home_dir().ok_or_else(|| AppError::Config("no home directory is available".into()))
    }
}

pub(crate) fn local_data_root() -> AppResult<PathBuf> {
    #[cfg(feature = "packaged-benchmark")]
    {
        data_root()
    }
    #[cfg(not(feature = "packaged-benchmark"))]
    {
        Ok(dirs::data_local_dir()
            .or_else(dirs::data_dir)
            .ok_or_else(|| {
                AppError::Config("no local application-data directory is available".into())
            })?
            .join("dopedb"))
    }
}

pub(crate) fn optional_home_dir() -> Option<PathBuf> {
    home_dir().ok()
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn optional_config_dir() -> Option<PathBuf> {
    #[cfg(feature = "packaged-benchmark")]
    {
        optional_home_dir().map(|home| home.join(".config"))
    }
    #[cfg(not(feature = "packaged-benchmark"))]
    {
        dirs::config_dir()
    }
}

#[cfg(feature = "packaged-benchmark")]
fn isolated_directory(variable: &'static str) -> AppResult<PathBuf> {
    let raw = std::env::var_os(variable)
        .ok_or_else(|| AppError::Config(format!("{variable} is required")))?;
    let requested = PathBuf::from(raw);
    if !requested.is_absolute()
        || requested
            .components()
            .any(|part| matches!(part, Component::CurDir | Component::ParentDir))
    {
        return Err(AppError::Config(format!("{variable} is invalid")));
    }
    let canonical = std::fs::canonicalize(&requested)
        .map_err(|_| AppError::Config(format!("{variable} is unavailable")))?;
    let temporary = std::fs::canonicalize(std::env::temp_dir())
        .map_err(|_| AppError::Config("the OS temp directory is unavailable".into()))?;
    let relative = canonical
        .strip_prefix(&temporary)
        .map_err(|_| AppError::Config(format!("{variable} must be below the OS temp directory")))?;
    let root = relative
        .components()
        .next()
        .and_then(|component| match component {
            Component::Normal(value) => value.to_str(),
            _ => None,
        });
    let metadata = std::fs::symlink_metadata(&canonical)?;
    if !metadata.is_dir()
        || root.is_none_or(|name| !name.starts_with(BENCHMARK_PREFIX))
        || path_has_controls(&canonical)
    {
        return Err(AppError::Config(format!(
            "{variable} is not an isolated benchmark directory"
        )));
    }
    Ok(canonical)
}

#[cfg(feature = "packaged-benchmark")]
fn path_has_controls(path: &Path) -> bool {
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
