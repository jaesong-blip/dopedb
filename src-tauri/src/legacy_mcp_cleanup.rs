//! Explicit, reviewable cleanup for the retired DopeDB MCP transport.
//!
//! User-owned Claude/Codex configuration is never rewritten wholesale. Inspection
//! computes the exact entry-level edit and a SHA-256 expectation; apply re-reads the
//! same regular file, rejects a changed fingerprint, creates a sibling backup, and
//! atomically replaces only the edited bytes. The app-owned bearer-token metadata is
//! securely truncated and removed without creating a secret-bearing backup.

use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use toml_edit::DocumentMut;
use uuid::Uuid;

use crate::{AppError, AppResult};

const MAX_CONFIG_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LegacyMcpCleanupState {
    Absent,
    Ready,
    ManualReview,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyMcpCleanupTarget {
    pub id: String,
    pub display_name: String,
    pub path: String,
    pub state: LegacyMcpCleanupState,
    pub fingerprint: Option<String>,
    pub redacted_diff: Option<String>,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyMcpCleanupStatus {
    pub targets: Vec<LegacyMcpCleanupTarget>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyMcpCleanupExpectation {
    pub id: String,
    pub fingerprint: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyMcpCleanupBackup {
    pub target_id: String,
    pub path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyMcpCleanupReceipt {
    pub removed_target_ids: Vec<String>,
    pub backups: Vec<LegacyMcpCleanupBackup>,
    pub status: LegacyMcpCleanupStatus,
}

#[derive(Clone, Copy, Debug)]
enum TargetFormat {
    Json,
    Toml,
    AppOwnedSecret,
}

#[derive(Clone, Debug)]
struct TargetSpec {
    id: &'static str,
    display_name: &'static str,
    path: PathBuf,
    format: TargetFormat,
}

#[derive(Debug)]
enum PlannedEdit {
    Absent,
    Replace(Vec<u8>),
    RemoveSecretFile,
}

#[tauri::command]
pub fn legacy_mcp_cleanup_status() -> LegacyMcpCleanupStatus {
    inspect_all()
}

#[tauri::command]
pub fn legacy_mcp_cleanup_apply(
    expectations: Vec<LegacyMcpCleanupExpectation>,
) -> AppResult<LegacyMcpCleanupReceipt> {
    if expectations.is_empty() {
        return Err(AppError::Config(
            "select at least one ready legacy MCP entry".into(),
        ));
    }

    let specs = target_specs();
    let mut selected = Vec::with_capacity(expectations.len());
    for expectation in &expectations {
        if selected
            .iter()
            .any(|(spec, _, _): &(&TargetSpec, Vec<u8>, PlannedEdit)| spec.id == expectation.id)
        {
            return Err(AppError::Config(format!(
                "duplicate cleanup target '{}'",
                expectation.id
            )));
        }
        let spec = specs
            .iter()
            .find(|candidate| candidate.id == expectation.id)
            .ok_or_else(|| {
                AppError::Config(format!("unknown cleanup target '{}'", expectation.id))
            })?;
        let bytes = read_regular_file(&spec.path)?;
        let actual = fingerprint(&bytes);
        if actual != expectation.fingerprint {
            return Err(AppError::Config(format!(
                "{} changed after preview; review the cleanup again",
                spec.display_name
            )));
        }
        let edit = plan_edit(spec.format, &bytes).map_err(|reason| {
            AppError::Config(format!(
                "{} now requires manual review: {reason}",
                spec.display_name
            ))
        })?;
        if matches!(edit, PlannedEdit::Absent) {
            return Err(AppError::Config(format!(
                "{} was already changed; review the cleanup again",
                spec.display_name
            )));
        }
        selected.push((spec, bytes, edit));
    }

    let mut removed_target_ids = Vec::with_capacity(selected.len());
    let mut backups = Vec::new();
    for (spec, original, edit) in selected {
        if read_regular_file(&spec.path)? != original {
            return Err(AppError::Config(format!(
                "{} changed during cleanup; review the cleanup again",
                spec.display_name
            )));
        }
        match edit {
            PlannedEdit::Absent => unreachable!("selected edits were checked above"),
            PlannedEdit::Replace(updated) => {
                let backup = write_backup(&spec.path, &original)?;
                atomic_write_preserving_permissions(&spec.path, &updated)?;
                backups.push(LegacyMcpCleanupBackup {
                    target_id: spec.id.into(),
                    path: backup.display().to_string(),
                });
            }
            PlannedEdit::RemoveSecretFile => {
                securely_remove_app_owned_secret(&spec.path, &original)?;
            }
        }
        removed_target_ids.push(spec.id.into());
    }

    Ok(LegacyMcpCleanupReceipt {
        removed_target_ids,
        backups,
        status: inspect_all(),
    })
}

fn inspect_all() -> LegacyMcpCleanupStatus {
    LegacyMcpCleanupStatus {
        targets: target_specs().iter().map(inspect_target).collect(),
    }
}

fn target_specs() -> Vec<TargetSpec> {
    let mut targets = Vec::new();
    if let Some(home) = dirs::home_dir() {
        targets.push(TargetSpec {
            id: "claude-code",
            display_name: "Claude Code",
            path: home.join(".claude.json"),
            format: TargetFormat::Json,
        });
        targets.push(TargetSpec {
            id: "claude-desktop",
            display_name: "Claude Desktop",
            path: claude_desktop_config_path(&home),
            format: TargetFormat::Json,
        });
        targets.push(TargetSpec {
            id: "codex",
            display_name: "Codex",
            path: std::env::var_os("CODEX_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".codex"))
                .join("config.toml"),
            format: TargetFormat::Toml,
        });
    }
    if let Some(data) = dirs::data_dir() {
        targets.push(TargetSpec {
            id: "dopedb-runtime",
            display_name: "DopeDB legacy runtime",
            path: data.join("dopedb").join("mcp.json"),
            format: TargetFormat::AppOwnedSecret,
        });
    }
    targets
}

fn claude_desktop_config_path(home: &Path) -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        home.join("Library/Application Support/Claude/claude_desktop_config.json")
    }
    #[cfg(windows)]
    {
        dirs::config_dir()
            .unwrap_or_else(|| home.join("AppData/Roaming"))
            .join("Claude/claude_desktop_config.json")
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        dirs::config_dir()
            .unwrap_or_else(|| home.join(".config"))
            .join("Claude/claude_desktop_config.json")
    }
}

fn inspect_target(spec: &TargetSpec) -> LegacyMcpCleanupTarget {
    let base = |state, fingerprint, redacted_diff, reason| LegacyMcpCleanupTarget {
        id: spec.id.into(),
        display_name: spec.display_name.into(),
        path: spec.path.display().to_string(),
        state,
        fingerprint,
        redacted_diff,
        reason,
    };

    match fs::symlink_metadata(&spec.path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return base(LegacyMcpCleanupState::Absent, None, None, None);
        }
        Err(error) => {
            return base(
                LegacyMcpCleanupState::ManualReview,
                None,
                None,
                Some(error.to_string()),
            );
        }
    }
    let bytes = match read_regular_file(&spec.path) {
        Ok(bytes) => bytes,
        Err(error) => {
            return base(
                LegacyMcpCleanupState::ManualReview,
                None,
                None,
                Some(error.to_string()),
            )
        }
    };
    let digest = fingerprint(&bytes);
    match plan_edit(spec.format, &bytes) {
        Ok(PlannedEdit::Absent) => base(LegacyMcpCleanupState::Absent, None, None, None),
        Ok(PlannedEdit::Replace(_)) => base(
            LegacyMcpCleanupState::Ready,
            Some(digest),
            Some("- mcpServers.dopedb (credentials redacted)".into()),
            None,
        ),
        Ok(PlannedEdit::RemoveSecretFile) => base(
            LegacyMcpCleanupState::Ready,
            Some(digest),
            Some("- app-owned MCP runtime metadata (secret redacted)".into()),
            None,
        ),
        Err(reason) => base(
            LegacyMcpCleanupState::ManualReview,
            Some(digest),
            None,
            Some(reason),
        ),
    }
}

fn read_regular_file(path: &Path) -> AppResult<Vec<u8>> {
    let mut file = open_existing_nofollow(path, true, false)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(AppError::Config(format!(
            "{} is not a regular non-symlink file",
            path.display()
        )));
    }
    if metadata.len() > MAX_CONFIG_BYTES {
        return Err(AppError::Config(format!(
            "{} exceeds the 1 MiB cleanup limit",
            path.display()
        )));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn plan_edit(format: TargetFormat, bytes: &[u8]) -> Result<PlannedEdit, String> {
    match format {
        TargetFormat::AppOwnedSecret => Ok(PlannedEdit::RemoveSecretFile),
        TargetFormat::Json => {
            let raw = std::str::from_utf8(bytes)
                .map_err(|_| "configuration is not valid UTF-8".to_string())?;
            remove_json_dopedb_entry(raw).map(|updated| match updated {
                Some(updated) => PlannedEdit::Replace(updated.into_bytes()),
                None => PlannedEdit::Absent,
            })
        }
        TargetFormat::Toml => {
            let raw = std::str::from_utf8(bytes)
                .map_err(|_| "configuration is not valid UTF-8".to_string())?;
            remove_toml_dopedb_entry(raw).map(|updated| match updated {
                Some(updated) => PlannedEdit::Replace(updated.into_bytes()),
                None => PlannedEdit::Absent,
            })
        }
    }
}

fn fingerprint(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn write_backup(path: &Path, bytes: &[u8]) -> AppResult<PathBuf> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::Config("cleanup target has no parent directory".into()))?;
    let file_name = path
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or_else(|| AppError::Config("cleanup target name is not Unicode".into()))?;
    let backup = parent.join(format!(
        "{file_name}.dopedb-mcp-{}.bak",
        Uuid::new_v4().simple()
    ));
    let mut file = create_private_file(&backup)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(backup)
}

fn atomic_write_preserving_permissions(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::Config("cleanup target has no parent directory".into()))?;
    let temporary = parent.join(format!(".dopedb-cleanup-{}.tmp", Uuid::new_v4().simple()));
    let permissions = fs::metadata(path)?.permissions();
    let result = (|| {
        let mut file = create_private_file(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::set_permissions(&temporary, permissions)?;
        atomic_replace(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn securely_remove_app_owned_secret(path: &Path, expected: &[u8]) -> AppResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::Config("cleanup target has no parent directory".into()))?;
    let tombstone = parent.join(format!(".dopedb-retired-{}.tmp", Uuid::new_v4().simple()));
    fs::rename(path, &tombstone)?;

    let observed = match read_regular_file(&tombstone) {
        Ok(observed) if observed == expected => observed,
        Ok(_) => {
            restore_tombstone(&tombstone, path);
            return Err(AppError::Config(
                "legacy runtime metadata changed during cleanup; review again".into(),
            ));
        }
        Err(error) => {
            restore_tombstone(&tombstone, path);
            return Err(error);
        }
    };
    drop(observed);

    let result = (|| {
        let file = open_existing_nofollow(&tombstone, false, true)?;
        file.set_len(0)?;
        file.sync_all()?;
        drop(file);
        fs::remove_file(&tombstone)?;
        Ok(())
    })();
    if result.is_err() {
        restore_tombstone(&tombstone, path);
    }
    result
}

fn restore_tombstone(tombstone: &Path, original: &Path) {
    if !original.exists() {
        let _ = fs::rename(tombstone, original);
    }
}

fn open_existing_nofollow(path: &Path, read: bool, write: bool) -> AppResult<File> {
    let mut options = OpenOptions::new();
    options.read(read).write(write);
    configure_nofollow(&mut options);
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(AppError::Config(format!(
            "{} is not a regular non-symlink file",
            path.display()
        )));
    }
    Ok(file)
}

fn create_private_file(path: &Path) -> AppResult<File> {
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;

        options.mode(0o600);
    }
    let file = options.open(path)?;
    #[cfg(windows)]
    if let Err(error) = crate::broker::restrict_path_to_current_user(path) {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(error);
    }
    Ok(file)
}

#[cfg(unix)]
fn configure_nofollow(options: &mut OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt;

    options.custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK);
}

#[cfg(windows)]
fn configure_nofollow(options: &mut OpenOptions) {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;

    options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
}

#[cfg(not(any(unix, windows)))]
fn configure_nofollow(_options: &mut OpenOptions) {}

#[cfg(unix)]
fn atomic_replace(from: &Path, to: &Path) -> AppResult<()> {
    fs::rename(from, to)?;
    Ok(())
}

#[cfg(windows)]
fn atomic_replace(from: &Path, to: &Path) -> AppResult<()> {
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let from = wide_null(from.as_os_str());
    let to = wide_null(to.as_os_str());
    if unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

#[cfg(windows)]
fn wide_null(value: &OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;

    value.encode_wide().chain(std::iter::once(0)).collect()
}

fn remove_toml_dopedb_entry(raw: &str) -> Result<Option<String>, String> {
    let mut document = raw
        .parse::<DocumentMut>()
        .map_err(|error| format!("configuration is not valid TOML: {error}"))?;
    let Some(servers) = document.get_mut("mcp_servers") else {
        return Ok(None);
    };
    let Some(table) = servers.as_table_mut() else {
        return Err("mcp_servers is not a TOML table".into());
    };
    if table.remove("dopedb").is_none() {
        return Ok(None);
    }
    Ok(Some(document.to_string()))
}

#[derive(Clone, Debug)]
struct JsonMember {
    key: String,
    delimiter_start: usize,
    value_start: usize,
    value_end: usize,
    comma_after: Option<usize>,
}

fn remove_json_dopedb_entry(raw: &str) -> Result<Option<String>, String> {
    serde_json::from_str::<serde_json::Value>(raw)
        .map_err(|error| format!("configuration is not valid JSON: {error}"))?;
    let bytes = raw.as_bytes();
    let root_start =
        first_non_whitespace(bytes, 0).ok_or_else(|| "configuration is empty".to_string())?;
    if bytes[root_start] != b'{' {
        return Err("configuration root is not an object".into());
    }
    let root = json_object_members(raw, root_start)?;
    let server_indexes: Vec<usize> = root
        .iter()
        .enumerate()
        .filter_map(|(index, member)| (member.key == "mcpServers").then_some(index))
        .collect();
    if server_indexes.len() > 1 {
        return Err("configuration contains duplicate mcpServers keys".into());
    }
    let Some(server_index) = server_indexes.first().copied() else {
        return Ok(None);
    };
    let server = &root[server_index];
    if bytes.get(server.value_start) != Some(&b'{') {
        return Err("mcpServers is not an object".into());
    }
    let servers = json_object_members(raw, server.value_start)?;
    let dopedb_indexes: Vec<usize> = servers
        .iter()
        .enumerate()
        .filter_map(|(index, member)| (member.key == "dopedb").then_some(index))
        .collect();
    if dopedb_indexes.len() > 1 {
        return Err("configuration contains duplicate dopedb MCP entries".into());
    }
    let Some(index) = dopedb_indexes.first().copied() else {
        return Ok(None);
    };
    let target = &servers[index];
    let (start, end) = if let Some(comma) = target.comma_after {
        (target.delimiter_start, comma + 1)
    } else if index > 0 {
        (
            servers[index - 1]
                .comma_after
                .ok_or_else(|| "invalid preceding JSON member delimiter".to_string())?,
            target.value_end,
        )
    } else {
        (target.delimiter_start, target.value_end)
    };
    let mut updated = String::with_capacity(raw.len() - (end - start));
    updated.push_str(&raw[..start]);
    updated.push_str(&raw[end..]);
    Ok(Some(updated))
}

fn json_object_members(raw: &str, object_start: usize) -> Result<Vec<JsonMember>, String> {
    let bytes = raw.as_bytes();
    if bytes.get(object_start) != Some(&b'{') {
        return Err("expected a JSON object".into());
    }
    let mut members = Vec::new();
    let mut cursor = object_start + 1;
    loop {
        let delimiter_start = cursor;
        cursor = first_non_whitespace(bytes, cursor)
            .ok_or_else(|| "unterminated JSON object".to_string())?;
        if bytes[cursor] == b'}' {
            return Ok(members);
        }
        let key = parse_json_string(raw, &mut cursor)?;
        cursor = first_non_whitespace(bytes, cursor)
            .ok_or_else(|| "missing JSON object colon".to_string())?;
        if bytes[cursor] != b':' {
            return Err("missing JSON object colon".into());
        }
        cursor += 1;
        cursor = first_non_whitespace(bytes, cursor)
            .ok_or_else(|| "missing JSON object value".to_string())?;
        let value_start = cursor;
        skip_json_value(raw, &mut cursor)?;
        let value_end = cursor;
        cursor = first_non_whitespace(bytes, cursor)
            .ok_or_else(|| "unterminated JSON object".to_string())?;
        let comma_after = if bytes[cursor] == b',' {
            let comma = cursor;
            cursor += 1;
            Some(comma)
        } else if bytes[cursor] == b'}' {
            None
        } else {
            return Err("expected a comma or object terminator".into());
        };
        members.push(JsonMember {
            key,
            delimiter_start,
            value_start,
            value_end,
            comma_after,
        });
        if comma_after.is_none() {
            return Ok(members);
        }
    }
}

fn first_non_whitespace(bytes: &[u8], mut cursor: usize) -> Option<usize> {
    while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
        cursor += 1;
    }
    (cursor < bytes.len()).then_some(cursor)
}

fn parse_json_string(raw: &str, cursor: &mut usize) -> Result<String, String> {
    let bytes = raw.as_bytes();
    let start = *cursor;
    if bytes.get(start) != Some(&b'"') {
        return Err("expected a JSON string".into());
    }
    *cursor += 1;
    let mut escaped = false;
    while let Some(byte) = bytes.get(*cursor).copied() {
        *cursor += 1;
        if escaped {
            escaped = false;
        } else if byte == b'\\' {
            escaped = true;
        } else if byte == b'"' {
            return serde_json::from_str(&raw[start..*cursor])
                .map_err(|error| format!("invalid JSON string: {error}"));
        }
    }
    Err("unterminated JSON string".into())
}

fn skip_json_value(raw: &str, cursor: &mut usize) -> Result<(), String> {
    let bytes = raw.as_bytes();
    match bytes.get(*cursor).copied() {
        Some(b'"') => {
            parse_json_string(raw, cursor)?;
        }
        Some(b'{') => {
            *cursor += 1;
            loop {
                *cursor = first_non_whitespace(bytes, *cursor)
                    .ok_or_else(|| "unterminated JSON object".to_string())?;
                if bytes[*cursor] == b'}' {
                    *cursor += 1;
                    break;
                }
                parse_json_string(raw, cursor)?;
                *cursor = first_non_whitespace(bytes, *cursor)
                    .ok_or_else(|| "missing JSON object colon".to_string())?;
                if bytes[*cursor] != b':' {
                    return Err("missing JSON object colon".into());
                }
                *cursor += 1;
                *cursor = first_non_whitespace(bytes, *cursor)
                    .ok_or_else(|| "missing JSON object value".to_string())?;
                skip_json_value(raw, cursor)?;
                *cursor = first_non_whitespace(bytes, *cursor)
                    .ok_or_else(|| "unterminated JSON object".to_string())?;
                match bytes[*cursor] {
                    b',' => *cursor += 1,
                    b'}' => {
                        *cursor += 1;
                        break;
                    }
                    _ => return Err("invalid JSON object delimiter".into()),
                }
            }
        }
        Some(b'[') => {
            *cursor += 1;
            loop {
                *cursor = first_non_whitespace(bytes, *cursor)
                    .ok_or_else(|| "unterminated JSON array".to_string())?;
                if bytes[*cursor] == b']' {
                    *cursor += 1;
                    break;
                }
                skip_json_value(raw, cursor)?;
                *cursor = first_non_whitespace(bytes, *cursor)
                    .ok_or_else(|| "unterminated JSON array".to_string())?;
                match bytes[*cursor] {
                    b',' => *cursor += 1,
                    b']' => {
                        *cursor += 1;
                        break;
                    }
                    _ => return Err("invalid JSON array delimiter".into()),
                }
            }
        }
        Some(_) => {
            while bytes.get(*cursor).is_some_and(|byte| {
                !byte.is_ascii_whitespace() && !matches!(byte, b',' | b'}' | b']')
            }) {
                *cursor += 1;
            }
        }
        None => return Err("missing JSON value".into()),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_cleanup_preserves_unrelated_bytes_and_formatting() {
        let raw = "{\n  \"theme\": \"dark\",\n  \"mcpServers\": {\n    \"dopedb\": {\"token\":\"secret\"},\n    \"other\": { \"command\": \"keep\" }\n  },\n  \"tail\": true\n}\n";
        let updated = remove_json_dopedb_entry(raw).unwrap().unwrap();
        assert_eq!(
            updated,
            "{\n  \"theme\": \"dark\",\n  \"mcpServers\": {\n    \"other\": { \"command\": \"keep\" }\n  },\n  \"tail\": true\n}\n"
        );
        assert!(!updated.contains("secret"));
    }

    #[test]
    fn json_cleanup_handles_only_entry_and_rejects_duplicate_target() {
        let raw = "{\"mcpServers\": { \"dopedb\": {\"token\":\"secret\"} }, \"keep\":1}";
        assert_eq!(
            remove_json_dopedb_entry(raw).unwrap().unwrap(),
            "{\"mcpServers\": { }, \"keep\":1}"
        );
        let duplicate = "{\"mcpServers\":{\"dopedb\":{},\"dopedb\":{\"token\":\"secret\"}}}";
        assert!(remove_json_dopedb_entry(duplicate)
            .unwrap_err()
            .contains("duplicate"));
    }

    #[test]
    fn toml_cleanup_preserves_other_tables_and_comments() {
        let raw = "# keep this comment\n[model]\nname = \"gpt\"\n\n[mcp_servers.dopedb]\ncommand = \"/secret/path\"\n\n[mcp_servers.other]\ncommand = \"keep\"\n";
        let updated = remove_toml_dopedb_entry(raw).unwrap().unwrap();
        assert!(updated.contains("# keep this comment"));
        assert!(updated.contains("[model]"));
        assert!(updated.contains("[mcp_servers.other]"));
        assert!(!updated.contains("mcp_servers.dopedb"));
        assert!(!updated.contains("/secret/path"));
    }

    #[test]
    fn preview_diff_never_contains_original_credentials() {
        let spec = TargetSpec {
            id: "test",
            display_name: "Test",
            path: PathBuf::from("not-used"),
            format: TargetFormat::Json,
        };
        let bytes = br#"{"mcpServers":{"dopedb":{"token":"top-secret"}}}"#;
        let edit = plan_edit(spec.format, bytes).unwrap();
        assert!(matches!(edit, PlannedEdit::Replace(_)));
        let diff = "- mcpServers.dopedb (credentials redacted)";
        assert!(!diff.contains("top-secret"));
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_never_follows_a_symlink() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("target.json");
        let link = directory.path().join("config.json");
        fs::write(&target, br#"{"token":"keep"}"#).unwrap();
        symlink(&target, &link).unwrap();

        assert!(read_regular_file(&link).is_err());
        assert_eq!(fs::read(&target).unwrap(), br#"{"token":"keep"}"#);
    }

    #[cfg(unix)]
    #[test]
    fn private_backup_never_inherits_world_readable_permissions() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.json");
        fs::write(&path, br#"{"token":"secret"}"#).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();

        let backup = write_backup(&path, br#"{"token":"secret"}"#).unwrap();

        assert_eq!(fs::metadata(backup).unwrap().mode() & 0o777, 0o600);
    }

    #[test]
    fn app_owned_secret_is_removed_without_a_backup_copy() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("mcp.json");
        let secret = br#"{"token":"retired-secret"}"#;
        fs::write(&path, secret).unwrap();

        securely_remove_app_owned_secret(&path, secret).unwrap();

        assert!(!path.exists());
        assert!(fs::read_dir(directory.path()).unwrap().next().is_none());
    }
}
