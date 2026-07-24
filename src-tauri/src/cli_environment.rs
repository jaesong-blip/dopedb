//! Shared, credential-free CLI executable discovery for GUI-launched processes.

use std::collections::BTreeSet;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

pub(crate) fn executable_search_path(first: Option<&Path>) -> OsString {
    let mut directories = Vec::new();
    if let Some(first) = first {
        directories.push(first.to_path_buf());
    }

    #[cfg(not(windows))]
    directories.extend(
        ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
            .into_iter()
            .map(PathBuf::from),
    );

    if let Some(home) = dirs::home_dir() {
        #[cfg(not(windows))]
        for relative in [
            ".local/bin",
            ".bun/bin",
            ".npm-global/bin",
            ".volta/bin",
            ".cargo/bin",
            ".local/share/pnpm",
            "Library/pnpm",
        ] {
            directories.push(home.join(relative));
        }

        #[cfg(windows)]
        {
            directories.push(home.join(".local/bin"));
            directories.push(home.join("AppData/Local/Programs/OpenAI/Codex/bin"));
            directories.push(home.join("AppData/Local/Microsoft/WindowsApps"));
            directories.push(home.join("AppData/Roaming/npm"));
            directories.push(home.join("AppData/Local/pnpm"));
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        directories.extend(std::env::split_paths(&path));
    }

    let mut seen = BTreeSet::new();
    directories.retain(|directory| directory.is_absolute() && seen.insert(path_key(directory)));
    std::env::join_paths(&directories).unwrap_or_default()
}

pub(crate) fn find_executable(binary: &str) -> Option<PathBuf> {
    find_in_path(&executable_search_path(None), binary)
}

pub(crate) fn find_in_path(path: &OsStr, binary: &str) -> Option<PathBuf> {
    let names = binary_names(binary);
    std::env::split_paths(path)
        .flat_map(|directory| names.iter().map(move |name| directory.join(name)))
        .find(|candidate| is_executable(candidate))
}

pub(crate) fn binary_names(binary: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        if Path::new(binary).extension().is_some() {
            return vec![binary.to_owned()];
        }
        ["exe", "cmd", "bat"]
            .into_iter()
            .map(|extension| format!("{binary}.{extension}"))
            .chain(std::iter::once(binary.to_owned()))
            .collect()
    }

    #[cfg(not(windows))]
    {
        vec![binary.to_owned()]
    }
}

fn is_executable(candidate: &Path) -> bool {
    let Ok(metadata) = candidate.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(windows)]
    {
        true
    }
}

#[cfg(windows)]
fn path_key(path: &Path) -> String {
    path.to_string_lossy().to_lowercase()
}

#[cfg(not(windows))]
fn path_key(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use std::fs;

    use super::*;

    #[test]
    fn search_path_keeps_the_requested_directory_first_and_unique() {
        let directory = std::env::temp_dir().join("dopedb-cli-path-fixture");
        let path = executable_search_path(Some(&directory));
        let paths = std::env::split_paths(&path).collect::<Vec<_>>();
        assert_eq!(paths.first(), Some(&directory));
        assert_eq!(
            paths
                .iter()
                .filter(|candidate| path_key(candidate) == path_key(&directory))
                .count(),
            1
        );
    }

    #[test]
    fn search_path_never_inherits_relative_executable_directories() {
        let path = executable_search_path(Some(Path::new("relative-cli-directory")));
        assert!(
            std::env::split_paths(&path).all(|directory| directory.is_absolute()),
            "a GUI-launched Terminal must not resolve executables relative to its cwd"
        );
    }

    #[cfg(unix)]
    #[test]
    fn lookup_requires_an_executable_file() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let binary = directory.path().join("fixture");
        fs::write(&binary, b"#!/bin/sh\n").unwrap();
        let path = std::env::join_paths([directory.path()]).unwrap();
        assert!(find_in_path(&path, "fixture").is_none());
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(find_in_path(&path, "fixture"), Some(binary));
    }
}
