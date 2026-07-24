use std::process::Command;

use dopedb_protocol::{SkillsGetResult, SkillsListResult};
use tempfile::TempDir;

#[test]
fn bundled_skill_guide_is_available_without_a_running_desktop_app() {
    let temp = TempDir::new().unwrap();
    let missing_runtime = temp.path().join("does-not-exist.json");
    let output = Command::new(env!("CARGO_BIN_EXE_dopedb-cli"))
        .args(["skills", "get", "dopedb-cli", "--json"])
        .env("DOPEDB_RUNTIME_FILE", missing_runtime)
        .output()
        .unwrap();

    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let result: SkillsGetResult = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result.skill.name, "dopedb-cli");
    assert_eq!(result.skill.app_version, env!("CARGO_PKG_VERSION"));
    assert!(result.references.is_empty());
    assert!(result
        .guide
        .contains("Every SQL read uses a mandatory two-step flow"));
}

#[test]
fn full_skill_guide_contains_the_versioned_reference_set() {
    let output = Command::new(env!("CARGO_BIN_EXE_dopedb-cli"))
        .args(["skills", "get", "dopedb-cli", "--full", "--json"])
        .output()
        .unwrap();

    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let result: SkillsGetResult = serde_json::from_slice(&output.stdout).unwrap();
    let paths = result
        .references
        .iter()
        .map(|reference| reference.path.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        paths,
        vec![
            "references/safety.md",
            "references/queries.md",
            "references/operations.md",
        ]
    );
}

#[test]
fn skill_list_uses_the_same_app_version_as_the_cli() {
    let output = Command::new(env!("CARGO_BIN_EXE_dopedb-cli"))
        .args(["skills", "list", "--json"])
        .output()
        .unwrap();

    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let result: SkillsListResult = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result.skills.len(), 1);
    assert_eq!(result.skills[0].app_version, env!("CARGO_PKG_VERSION"));
}
