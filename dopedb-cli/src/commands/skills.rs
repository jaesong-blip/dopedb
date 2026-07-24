use dopedb_protocol::{
    CommandSpec, SkillInstallCommand, SkillMutationArguments, SkillMutationResult,
    SkillRemoveCommand, SkillRepairCommand, SkillStatusArguments, SkillStatusCommand,
    SkillStatusResult, SkillSummary, SkillTargetExpectation, SkillTargetSelection, SkillsGetResult,
    SkillsListResult,
};
use serde::Deserialize;

use crate::client::{BrokerClient, ClientError};
use crate::output::{self, OutputMode};

const GUIDE: &str = include_str!("../../../skills/dopedb-cli/SKILL.md");
const SAFETY_REFERENCE: &str = include_str!("../../../skills/dopedb-cli/references/safety.md");
const QUERIES_REFERENCE: &str = include_str!("../../../skills/dopedb-cli/references/queries.md");
const OPERATIONS_REFERENCE: &str =
    include_str!("../../../skills/dopedb-cli/references/operations.md");
const CURRENT_MANIFEST: &str =
    include_str!("../../../src-tauri/resources/skills/current-manifest.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EmbeddedManifest {
    skill_name: String,
    release_revision: u64,
    app_version: String,
    package_digest: String,
}

pub(crate) fn list(mode: OutputMode) -> Result<(), ClientError> {
    let result = SkillsListResult {
        skills: vec![embedded_summary()?],
    };
    match mode {
        OutputMode::Json => output::write_json(&result),
        OutputMode::Human => output::write_human(
            &result
                .skills
                .iter()
                .map(|skill| {
                    format!(
                        "{}  revision {}  app {}",
                        skill.name, skill.release_revision, skill.app_version
                    )
                })
                .collect::<Vec<_>>(),
        ),
    }
}

pub(crate) fn get(name: &str, full: bool, mode: OutputMode) -> Result<(), ClientError> {
    let summary = embedded_summary()?;
    if name != summary.name {
        return Err(ClientError::InvalidArguments);
    }
    let result = SkillsGetResult {
        skill: summary,
        guide: GUIDE.into(),
        references: if full {
            vec![
                dopedb_protocol::SkillGuideFile {
                    path: "references/safety.md".into(),
                    content: SAFETY_REFERENCE.into(),
                },
                dopedb_protocol::SkillGuideFile {
                    path: "references/queries.md".into(),
                    content: QUERIES_REFERENCE.into(),
                },
                dopedb_protocol::SkillGuideFile {
                    path: "references/operations.md".into(),
                    content: OPERATIONS_REFERENCE.into(),
                },
            ]
        } else {
            Vec::new()
        },
    };
    match mode {
        OutputMode::Json => output::write_json(&result),
        OutputMode::Human => {
            let mut lines = result.guide.lines().map(str::to_string).collect::<Vec<_>>();
            for reference in result.references {
                lines.push(String::new());
                lines.push(format!("<!-- {} -->", reference.path));
                lines.extend(reference.content.lines().map(str::to_string));
            }
            output::write_human(&lines)
        }
    }
}

pub(crate) async fn status(
    target: SkillTargetSelection,
    mode: OutputMode,
) -> Result<(), ClientError> {
    let client = BrokerClient::discover()?;
    let result = request_status(&client, target).await?;
    write_status(&result, mode)
}

pub(crate) async fn install(
    target: SkillTargetSelection,
    mode: OutputMode,
) -> Result<(), ClientError> {
    mutate::<SkillInstallCommand>(target, mode).await
}

pub(crate) async fn repair(
    target: SkillTargetSelection,
    mode: OutputMode,
) -> Result<(), ClientError> {
    mutate::<SkillRepairCommand>(target, mode).await
}

pub(crate) async fn remove(
    target: SkillTargetSelection,
    mode: OutputMode,
) -> Result<(), ClientError> {
    mutate::<SkillRemoveCommand>(target, mode).await
}

async fn mutate<C>(target: SkillTargetSelection, mode: OutputMode) -> Result<(), ClientError>
where
    C: CommandSpec<Arguments = SkillMutationArguments, Result = SkillMutationResult>,
{
    let client = BrokerClient::discover()?;
    let before = request_status(&client, target).await?;
    let expected = before
        .targets
        .iter()
        .map(|status| SkillTargetExpectation {
            target: status.target,
            inventory_fingerprint: status.inventory_fingerprint.clone(),
        })
        .collect();
    let result = client
        .request::<C>(&SkillMutationArguments { target, expected })
        .await?;
    match mode {
        OutputMode::Json => output::write_json(&result),
        OutputMode::Human => {
            let mut lines = result
                .changed_targets
                .iter()
                .map(|target| format!("Updated {}", target.as_str()))
                .collect::<Vec<_>>();
            lines.extend(
                result
                    .backups
                    .iter()
                    .map(|backup| format!("Backup {}  {}", backup.target.as_str(), backup.path)),
            );
            lines.extend(status_lines(&result.status));
            output::write_human(&lines)
        }
    }
}

async fn request_status(
    client: &BrokerClient,
    target: SkillTargetSelection,
) -> Result<SkillStatusResult, ClientError> {
    client
        .request::<SkillStatusCommand>(&SkillStatusArguments { target })
        .await
}

fn write_status(result: &SkillStatusResult, mode: OutputMode) -> Result<(), ClientError> {
    match mode {
        OutputMode::Json => output::write_json(result),
        OutputMode::Human => output::write_human(&status_lines(result)),
    }
}

fn status_lines(result: &SkillStatusResult) -> Vec<String> {
    result
        .targets
        .iter()
        .flat_map(|status| {
            let revision = status
                .installed_revision
                .map(|revision| revision.to_string())
                .unwrap_or_else(|| "-".into());
            let mut lines = vec![format!(
                "{}  {:?}  revision {}  {}",
                status.display_name, status.state, revision, status.install_path
            )];
            lines.extend(status.conflicts.iter().map(|conflict| {
                format!("  conflict {}  {}", conflict.kind.as_str(), conflict.path)
            }));
            lines
        })
        .collect()
}

fn embedded_summary() -> Result<SkillSummary, ClientError> {
    let manifest: EmbeddedManifest =
        serde_json::from_str(CURRENT_MANIFEST).map_err(|_| ClientError::Internal)?;
    if manifest.app_version != env!("CARGO_PKG_VERSION")
        || manifest.skill_name != "dopedb-cli"
        || manifest.package_digest.len() != 64
    {
        return Err(ClientError::Internal);
    }
    Ok(SkillSummary {
        name: manifest.skill_name,
        release_revision: manifest.release_revision,
        app_version: manifest.app_version,
        package_digest: manifest.package_digest,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_guide_and_manifest_are_version_matched() {
        let summary = embedded_summary().unwrap();
        assert_eq!(summary.name, "dopedb-cli");
        assert_eq!(summary.app_version, env!("CARGO_PKG_VERSION"));
        assert!(GUIDE.contains("Every SQL read uses a mandatory two-step flow"));
        assert!(GUIDE.contains("An agent can propose a mutation but cannot approve it"));
    }

    #[test]
    fn full_references_cover_safety_queries_and_outcome_unknown() {
        assert!(SAFETY_REFERENCE.contains("The CLI deliberately has no approval command"));
        assert!(QUERIES_REFERENCE.contains("Plans are exact, single-use"));
        assert!(OPERATIONS_REFERENCE.contains("Never retry automatically"));
    }
}
