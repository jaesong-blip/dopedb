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

    let home = crate::app_paths::optional_home_dir();
    if let Some(home) = home.as_ref() {
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
            directories.push(home.join("AppData/Local/Volta/bin"));
        }
    }
    #[cfg(windows)]
    directories.extend(windows_cli_runtime_directories(home.as_deref(), |key| {
        std::env::var_os(key)
    }));
    if let Some(path) = std::env::var_os("PATH") {
        directories.extend(std::env::split_paths(&path));
    }
    directories.extend(node_runtime_directories());

    let mut seen = BTreeSet::new();
    directories.retain(|directory| directory.is_absolute() && seen.insert(path_key(directory)));
    std::env::join_paths(&directories).unwrap_or_default()
}

/// npm and pnpm install `claude` and `codex` as shims that re-exec `node`, so a
/// search path that finds the shim but not the Node runtime fails after launch.
/// These come last, leaving an inherited PATH free to pick the active runtime.
#[cfg(windows)]
fn node_runtime_directories() -> Vec<PathBuf> {
    let mut directories = Vec::new();
    for variable in ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(root) = non_empty_var(variable) {
            directories.push(PathBuf::from(root).join("nodejs"));
        }
    }
    // nvm-windows keeps the selected runtime behind this symlink directory.
    if let Some(symlink) = non_empty_var("NVM_SYMLINK") {
        directories.push(PathBuf::from(symlink));
    }
    directories
}

/// Unix package managers place `node` in the shared bin directories already
/// listed above, and shebang shims resolve it through the same search path.
#[cfg(not(windows))]
fn node_runtime_directories() -> Vec<PathBuf> {
    Vec::new()
}

#[cfg(windows)]
fn non_empty_var(name: &str) -> Option<OsString> {
    std::env::var_os(name).filter(|value| !value.is_empty())
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

#[cfg(any(windows, test))]
fn windows_cli_runtime_directories(
    home: Option<&Path>,
    mut environment: impl FnMut(&str) -> Option<OsString>,
) -> Vec<PathBuf> {
    let mut directories = Vec::new();
    if let Some(home) = home {
        directories.push(home.join(".volta/bin"));
        directories.push(home.join("AppData/Local/Programs/nodejs"));
        directories.push(home.join("AppData/Roaming/nvm"));
    }
    for variable in ["NVM_SYMLINK", "NVM_HOME", "FNM_MULTISHELL_PATH"] {
        if let Some(path) = environment(variable).filter(|value| !value.is_empty()) {
            directories.push(PathBuf::from(path));
        }
    }
    if let Some(path) = environment("VOLTA_HOME").filter(|value| !value.is_empty()) {
        directories.push(PathBuf::from(path).join("bin"));
    }
    if let Some(path) = environment("LOCALAPPDATA").filter(|value| !value.is_empty()) {
        directories.push(PathBuf::from(path).join("Programs/nodejs"));
    }
    for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(path) = environment(variable).filter(|value| !value.is_empty()) {
            directories.push(PathBuf::from(path).join("nodejs"));
        }
    }
    directories
}

#[cfg(test)]
pub(crate) fn assert_cli_environment_contract() {
    let root = Path::new("/fixture/home");
    let directories = windows_cli_runtime_directories(Some(root), |key| match key {
        "NVM_SYMLINK" => Some(OsString::from("/fixture/nvm-link")),
        "VOLTA_HOME" => Some(OsString::from("/fixture/volta")),
        "ProgramFiles" => Some(OsString::from("/fixture/program-files")),
        _ => None,
    });
    assert!(directories.contains(&root.join(".volta/bin")));
    assert!(directories.contains(&root.join("AppData/Local/Programs/nodejs")));
    assert!(directories.contains(&PathBuf::from("/fixture/nvm-link")));
    assert!(directories.contains(&PathBuf::from("/fixture/volta/bin")));
    assert!(directories.contains(&PathBuf::from("/fixture/program-files/nodejs")));
}
