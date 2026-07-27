use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path};

use dopedb_protocol::{SkillGuideFile, SkillSummary, SkillsGetResult, SkillsListResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

use crate::error::{AppError, AppResult};

const CURRENT_MANIFEST_JSON: &str = include_str!("../../resources/skills/current-manifest.json");
const SNAPSHOT_REGISTRY_JSON: &str = include_str!("../../resources/skills/snapshot-registry.json");
const RELEASE_MAPPING_JSON: &str = include_str!("../../resources/skills/release-mapping.json");
const GUIDE: &str = include_str!("../../../skills/dopedb-cli/SKILL.md");
const SAFETY_REFERENCE: &str = include_str!("../../../skills/dopedb-cli/references/safety.md");
const QUERIES_REFERENCE: &str = include_str!("../../../skills/dopedb-cli/references/queries.md");
const DOCUMENTS_REFERENCE: &str =
    include_str!("../../../skills/dopedb-cli/references/documents.md");
const DASHBOARDS_REFERENCE: &str =
    include_str!("../../../skills/dopedb-cli/references/dashboards.md");
const OPERATIONS_REFERENCE: &str =
    include_str!("../../../skills/dopedb-cli/references/operations.md");

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CurrentManifest {
    pub schema_version: u64,
    pub skill_name: String,
    pub release_revision: u64,
    pub source_path: String,
    pub app_version: String,
    pub source_files: Vec<ManifestFile>,
    pub install_files: Vec<ManifestFile>,
    pub package_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ManifestFile {
    pub path: String,
    pub source_path: String,
    pub size: u64,
    pub executable: bool,
    pub sha256: String,
    pub normalized_text_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SnapshotRegistry {
    schema_version: u64,
    skill_name: String,
    snapshots: Vec<SkillSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SkillSnapshot {
    pub release_revision: u64,
    pub app_version: String,
    pub package_digest: String,
    pub files: Vec<ManifestFile>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReleaseMapping {
    schema_version: u64,
    skill_name: String,
    releases: Vec<ReleaseRecord>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReleaseRecord {
    app_version: String,
    release_revision: u64,
    package_digest: String,
}

#[derive(Debug, Clone)]
pub(super) struct SkillBundle {
    pub current: CurrentManifest,
    pub snapshots: Vec<SkillSnapshot>,
}

impl SkillBundle {
    pub fn load() -> AppResult<Self> {
        let current: CurrentManifest = serde_json::from_str(CURRENT_MANIFEST_JSON)?;
        let registry: SnapshotRegistry = serde_json::from_str(SNAPSHOT_REGISTRY_JSON)?;
        let releases: ReleaseMapping = serde_json::from_str(RELEASE_MAPPING_JSON)?;

        validate_current_manifest(&current)?;
        if registry.schema_version != 1
            || registry.skill_name != current.skill_name
            || releases.schema_version != 1
            || releases.skill_name != current.skill_name
        {
            return Err(AppError::Config(
                "the embedded Skill registries are incompatible".into(),
            ));
        }

        let mut revisions = registry
            .snapshots
            .iter()
            .map(|snapshot| snapshot.release_revision)
            .collect::<Vec<_>>();
        revisions.sort_unstable();
        revisions.dedup();
        if revisions.len() != registry.snapshots.len() {
            return Err(AppError::Config(
                "the embedded Skill snapshot revisions are not unique".into(),
            ));
        }
        for snapshot in &registry.snapshots {
            validate_snapshot(snapshot)?;
        }
        let mut mapped_versions = BTreeSet::new();
        for release in &releases.releases {
            if !mapped_versions.insert(&release.app_version)
                || !registry.snapshots.iter().any(|snapshot| {
                    snapshot.app_version == release.app_version
                        && snapshot.release_revision == release.release_revision
                        && snapshot.package_digest == release.package_digest
                })
            {
                return Err(AppError::Config(
                    "an embedded Skill release mapping is ambiguous or unknown".into(),
                ));
            }
        }

        let current_snapshot = registry
            .snapshots
            .iter()
            .find(|snapshot| snapshot.release_revision == current.release_revision)
            .ok_or_else(|| {
                AppError::Config("the current Skill snapshot is missing from the registry".into())
            })?;
        let expected_files = current
            .install_files
            .iter()
            .cloned()
            .map(|mut file| {
                file.content = None;
                file
            })
            .collect::<Vec<_>>();
        if current_snapshot.app_version != current.app_version
            || current_snapshot.package_digest != current.package_digest
            || current_snapshot.files != expected_files
        {
            return Err(AppError::Config(
                "the current Skill snapshot does not match its manifest".into(),
            ));
        }

        let release = releases
            .releases
            .iter()
            .find(|release| release.app_version == current.app_version)
            .ok_or_else(|| {
                AppError::Config("the current app has no Skill release mapping".into())
            })?;
        if release.release_revision != current.release_revision
            || release.package_digest != current.package_digest
        {
            return Err(AppError::Config(
                "the current Skill release mapping is inconsistent".into(),
            ));
        }

        Ok(Self {
            current,
            snapshots: registry.snapshots,
        })
    }

    pub fn summary(&self) -> SkillSummary {
        SkillSummary {
            name: self.current.skill_name.clone(),
            release_revision: self.current.release_revision,
            app_version: self.current.app_version.clone(),
            package_digest: self.current.package_digest.clone(),
        }
    }

    pub fn list(&self) -> SkillsListResult {
        SkillsListResult {
            skills: vec![self.summary()],
        }
    }

    pub fn guide(&self, name: &str, full: bool) -> AppResult<SkillsGetResult> {
        if name != self.current.skill_name {
            return Err(AppError::NotFound("the requested Skill guide".into()));
        }
        Ok(SkillsGetResult {
            skill: self.summary(),
            guide: GUIDE.into(),
            references: if full {
                vec![
                    SkillGuideFile {
                        path: "references/safety.md".into(),
                        content: SAFETY_REFERENCE.into(),
                    },
                    SkillGuideFile {
                        path: "references/queries.md".into(),
                        content: QUERIES_REFERENCE.into(),
                    },
                    SkillGuideFile {
                        path: "references/documents.md".into(),
                        content: DOCUMENTS_REFERENCE.into(),
                    },
                    SkillGuideFile {
                        path: "references/dashboards.md".into(),
                        content: DASHBOARDS_REFERENCE.into(),
                    },
                    SkillGuideFile {
                        path: "references/operations.md".into(),
                        content: OPERATIONS_REFERENCE.into(),
                    },
                ]
            } else {
                Vec::new()
            },
        })
    }
}

fn validate_current_manifest(manifest: &CurrentManifest) -> AppResult<()> {
    if manifest.schema_version != 1
        || manifest.skill_name != "dopedb-cli"
        || manifest.source_path != "skills/dopedb-cli"
        || manifest.app_version != env!("CARGO_PKG_VERSION")
        || manifest.release_revision == 0
        || !valid_digest(&manifest.package_digest)
        || manifest.source_files.is_empty()
        || manifest.install_files.len() != 1
    {
        return Err(AppError::Config(
            "the embedded current Skill manifest is invalid".into(),
        ));
    }

    let mut raw: Value = serde_json::from_str(CURRENT_MANIFEST_JSON)?;
    let object = raw.as_object_mut().ok_or_else(|| {
        AppError::Config("the embedded current Skill manifest is not an object".into())
    })?;
    object.remove("packageDigest");
    let canonical = canonical_json(&raw)?;
    if sha256_hex(&canonical) != manifest.package_digest {
        return Err(AppError::Config(
            "the embedded Skill package digest does not match its manifest".into(),
        ));
    }

    for file in manifest
        .source_files
        .iter()
        .chain(manifest.install_files.iter())
    {
        validate_file_record(file)?;
    }
    let embedded_sources = BTreeMap::from([
        ("SKILL.md", GUIDE.as_bytes()),
        ("references/dashboards.md", DASHBOARDS_REFERENCE.as_bytes()),
        ("references/documents.md", DOCUMENTS_REFERENCE.as_bytes()),
        ("references/operations.md", OPERATIONS_REFERENCE.as_bytes()),
        ("references/queries.md", QUERIES_REFERENCE.as_bytes()),
        ("references/safety.md", SAFETY_REFERENCE.as_bytes()),
    ]);
    let source_paths = manifest
        .source_files
        .iter()
        .map(|file| file.path.as_str())
        .collect::<BTreeSet<_>>();
    if source_paths.len() != manifest.source_files.len()
        || source_paths != embedded_sources.keys().copied().collect()
    {
        return Err(AppError::Config(
            "the embedded Skill source manifest has an unexpected file set".into(),
        ));
    }
    for file in &manifest.source_files {
        if file.content.is_some() {
            return Err(AppError::Config(
                "an embedded Skill source record unexpectedly contains content".into(),
            ));
        }
        let bytes = embedded_sources
            .get(file.path.as_str())
            .ok_or_else(|| AppError::Config("an embedded Skill source file is missing".into()))?;
        validate_content(file, bytes)?;
    }
    let stub = &manifest.install_files[0];
    let content = stub
        .content
        .as_deref()
        .ok_or_else(|| AppError::Config("the embedded Skill install stub has no content".into()))?;
    if stub.path != "SKILL.md"
        || stub.source_path != "generated:discovery-stub"
        || !content.contains("Before using DopeDB, run:\ndopedb skills get dopedb-cli")
    {
        return Err(AppError::Config(
            "the embedded Skill discovery stub is invalid".into(),
        ));
    }
    validate_content(stub, content.as_bytes())
}

fn validate_snapshot(snapshot: &SkillSnapshot) -> AppResult<()> {
    if snapshot.release_revision == 0
        || snapshot.app_version.trim().is_empty()
        || !valid_digest(&snapshot.package_digest)
        || snapshot.files.is_empty()
    {
        return Err(AppError::Config(
            "an embedded Skill snapshot is invalid".into(),
        ));
    }
    let mut paths = BTreeSet::new();
    for file in &snapshot.files {
        validate_file_record(file)?;
        if file.content.is_some() || !paths.insert(&file.path) {
            return Err(AppError::Config(
                "a Skill snapshot contains duplicate paths or unexpected contents".into(),
            ));
        }
    }
    Ok(())
}

fn validate_file_record(file: &ManifestFile) -> AppResult<()> {
    if !safe_relative_path(&file.path)
        || file.source_path.trim().is_empty()
        || file.size > super::MAX_FILE_BYTES
        || !valid_digest(&file.sha256)
        || !valid_digest(&file.normalized_text_sha256)
    {
        return Err(AppError::Config(
            "an embedded Skill file record is invalid".into(),
        ));
    }
    if let Some(content) = &file.content {
        validate_content(file, content.as_bytes())?;
    }
    Ok(())
}

fn validate_content(file: &ManifestFile, bytes: &[u8]) -> AppResult<()> {
    if u64::try_from(bytes.len()).ok() != Some(file.size)
        || sha256_hex(bytes) != file.sha256
        || normalized_text_sha256(bytes).as_deref() != Some(&file.normalized_text_sha256)
    {
        return Err(AppError::Config(
            "an embedded Skill file does not match its digest".into(),
        ));
    }
    Ok(())
}

fn safe_relative_path(value: &str) -> bool {
    if value.is_empty() || value.contains('\\') {
        return false;
    }
    let path = Path::new(value);
    !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn canonical_json(value: &Value) -> AppResult<Vec<u8>> {
    fn sorted(value: &Value) -> Value {
        match value {
            Value::Array(values) => Value::Array(values.iter().map(sorted).collect()),
            Value::Object(values) => Value::Object(
                values
                    .iter()
                    .map(|(key, value)| (key.clone(), sorted(value)))
                    .collect::<BTreeMap<_, _>>()
                    .into_iter()
                    .collect(),
            ),
            value => value.clone(),
        }
    }
    serde_json::to_vec(&sorted(value)).map_err(AppError::from)
}

pub(super) fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub(super) fn normalized_text_sha256(bytes: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(bytes).ok()?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let normalized = text
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .nfc()
        .collect::<String>();
    Some(sha256_hex(normalized.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_bundle_is_self_consistent_and_version_matched() {
        let bundle = SkillBundle::load().unwrap();
        assert_eq!(bundle.current.app_version, env!("CARGO_PKG_VERSION"));
        assert_eq!(bundle.current.install_files[0].path, "SKILL.md");
        assert_eq!(bundle.snapshots.len(), 7);
        assert_eq!(
            bundle
                .snapshots
                .iter()
                .find(|snapshot| snapshot.release_revision == bundle.current.release_revision)
                .unwrap()
                .package_digest,
            bundle.current.package_digest
        );
    }

    #[test]
    fn embedded_full_guide_contains_every_reference() {
        let bundle = SkillBundle::load().unwrap();
        let guide = bundle.guide("dopedb-cli", true).unwrap();
        assert_eq!(guide.references.len(), 5);
        assert!(guide
            .guide
            .contains("An agent can propose a mutation but cannot approve it"));
        assert!(guide
            .references
            .iter()
            .any(|reference| reference.content.contains("outcome_unknown")));
        assert!(guide.references.iter().any(|reference| reference
            .content
            .contains("write-capable aggregation stages")));
        assert!(guide
            .references
            .iter()
            .any(|reference| reference.content.contains("Ask first")));
    }

    #[test]
    fn normalized_text_digest_accepts_only_line_ending_changes() {
        assert_eq!(
            normalized_text_sha256(b"\xef\xbb\xbfline\r\nnext\r"),
            normalized_text_sha256(b"line\nnext\n")
        );
        assert_eq!(
            normalized_text_sha256("Cafe\u{301}\n".as_bytes()),
            normalized_text_sha256("Café\n".as_bytes())
        );
    }

    #[test]
    fn manifest_paths_cannot_escape_the_install_root() {
        for path in [
            "",
            "../SKILL.md",
            "references/../../SKILL.md",
            "/tmp/SKILL.md",
            r"references\SKILL.md",
        ] {
            assert!(!safe_relative_path(path), "{path} must be rejected");
        }
        assert!(safe_relative_path("SKILL.md"));
        assert!(safe_relative_path("references/safety.md"));
    }
}
