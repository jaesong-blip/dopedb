//! Versioned Skill bundle, inventory, and mutation command payloads.

use serde::{Deserialize, Serialize};

use crate::{AuthenticationRequirement, CommandName, CommandSpec, EmptyArguments};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SkillTarget {
    Codex,
    ClaudeCode,
}

impl SkillTarget {
    pub const ALL: [Self; 2] = [Self::Codex, Self::ClaudeCode];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::ClaudeCode => "claude-code",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SkillTargetSelection {
    All,
    Codex,
    ClaudeCode,
}

impl SkillTargetSelection {
    pub fn targets(self) -> Vec<SkillTarget> {
        match self {
            Self::All => SkillTarget::ALL.to_vec(),
            Self::Codex => vec![SkillTarget::Codex],
            Self::ClaudeCode => vec![SkillTarget::ClaudeCode],
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillInstallState {
    Missing,
    ManagedCurrent,
    ManagedOlder,
    UserModified,
    NewerKnown,
    UnknownConflict,
    Invalid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillStatusReason {
    FilesDifferFromManagedSnapshot,
    InstallPathInspectionFailed,
    InstallPathSymlink,
    InstallRootNotDirectory,
    InstallTargetNotDirectory,
    InstallTargetOutsideHome,
    InstallTargetSymlink,
    InstalledFileChanged,
    InstalledFileTooLarge,
    InstalledSkillByteLimit,
    InstalledSkillFileCountLimit,
    InstalledSkillNestingLimit,
    InstalledSkillNonUnicodePath,
    InstalledSkillReadFailed,
    InstalledSkillSymlink,
    InstalledSkillUnsafePath,
    InstalledSkillUnsupportedFile,
    InventoryEscapedRoot,
    ProvenanceMarkerMalformed,
    ProvenanceMarkerNotFile,
    ProvenanceMarkerUnreadable,
    UnknownManagedSnapshot,
    UnmanagedFiles,
    UnsafePathComponent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillConflictKind {
    Missing,
    Modified,
    Unexpected,
    InvalidProvenance,
}

impl SkillConflictKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Missing => "missing",
            Self::Modified => "modified",
            Self::Unexpected => "unexpected",
            Self::InvalidProvenance => "invalid_provenance",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillConflict {
    pub path: String,
    pub kind: SkillConflictKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillSummary {
    pub name: String,
    pub release_revision: u64,
    pub app_version: String,
    pub package_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillsListResult {
    pub skills: Vec<SkillSummary>,
}

pub struct SkillsListCommand;

impl CommandSpec for SkillsListCommand {
    type Arguments = EmptyArguments;
    type Result = SkillsListResult;

    const NAME: CommandName = CommandName::SkillsList;
    const AUTHENTICATION: AuthenticationRequirement = AuthenticationRequirement::None;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillsGetArguments {
    pub name: String,
    #[serde(default)]
    pub full: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillGuideFile {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillsGetResult {
    pub skill: SkillSummary,
    pub guide: String,
    #[serde(default)]
    pub references: Vec<SkillGuideFile>,
}

pub struct SkillsGetCommand;

impl CommandSpec for SkillsGetCommand {
    type Arguments = SkillsGetArguments;
    type Result = SkillsGetResult;

    const NAME: CommandName = CommandName::SkillsGet;
    const AUTHENTICATION: AuthenticationRequirement = AuthenticationRequirement::None;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillStatusArguments {
    pub target: SkillTargetSelection,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillTargetStatus {
    pub target: SkillTarget,
    pub display_name: String,
    pub install_path: String,
    pub state: SkillInstallState,
    pub repairable: bool,
    pub current_revision: u64,
    #[serde(default)]
    pub installed_revision: Option<u64>,
    #[serde(default)]
    pub installed_package_digest: Option<String>,
    pub inventory_fingerprint: String,
    #[serde(default)]
    pub reason: Option<SkillStatusReason>,
    #[serde(default)]
    pub conflicts: Vec<SkillConflict>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillStatusResult {
    pub skill: SkillSummary,
    pub targets: Vec<SkillTargetStatus>,
}

pub struct SkillStatusCommand;

impl CommandSpec for SkillStatusCommand {
    type Arguments = SkillStatusArguments;
    type Result = SkillStatusResult;

    const NAME: CommandName = CommandName::SkillStatus;
    const AUTHENTICATION: AuthenticationRequirement = AuthenticationRequirement::None;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillTargetExpectation {
    pub target: SkillTarget,
    pub inventory_fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillMutationArguments {
    pub target: SkillTargetSelection,
    pub expected: Vec<SkillTargetExpectation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillBackup {
    pub target: SkillTarget,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillMutationResult {
    pub status: SkillStatusResult,
    pub changed_targets: Vec<SkillTarget>,
    #[serde(default)]
    pub backups: Vec<SkillBackup>,
}

macro_rules! mutation_command {
    ($name:ident, $command:ident) => {
        pub struct $name;

        impl CommandSpec for $name {
            type Arguments = SkillMutationArguments;
            type Result = SkillMutationResult;

            const NAME: CommandName = CommandName::$command;
            const AUTHENTICATION: AuthenticationRequirement = AuthenticationRequirement::None;
        }
    };
}

mutation_command!(SkillInstallCommand, SkillInstall);
mutation_command!(SkillRepairCommand, SkillRepair);
mutation_command!(SkillRemoveCommand, SkillRemove);
