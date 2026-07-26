//! Test-only TypeScript snapshots for public IPC contracts.
//!
//! `ts-rs` is intentionally a dev-dependency. These declarations are generated
//! only by this test module and never participate in the runtime protocol crate.

use std::path::PathBuf;

use ts_rs::{Config, TS};

use crate::{
    CatalogSnapshot, ConnectionListResult, ConnectionSelector, ConnectionSelectorArguments,
    ConnectionSummary, ConnectionTestResult, Constraint, ConstraintKind, DatabaseEngine,
    DatabaseObject, Index, IndexKey, Namespace, NormalizedTypeFamily, ObjectKind, ObjectRef,
    OperationState, Relation, Routine, SkillBackup, SkillConflict, SkillConflictKind,
    SkillInstallState, SkillMutationArguments, SkillMutationResult, SkillStatusArguments,
    SkillStatusReason, SkillStatusResult, SkillSummary, SkillTarget, SkillTargetExpectation,
    SkillTargetSelection, SkillTargetStatus, SkillsGetArguments, SkillsGetResult, SkillsListResult,
    SortDirection,
};

const HEADER: &str = "// Generated from dopedb-protocol public serde DTOs by ts-rs 12.0.1.\n// Do not edit; run pnpm generate:contracts.\n\n";

fn output_path() -> PathBuf {
    std::env::var_os("DOPEDB_PROTOCOL_CONTRACT_OUTPUT")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../src/ipc/generated/protocol-contracts.ts")
        })
}

fn append<T: TS>(output: &mut String, config: &Config) {
    output.push_str("export ");
    output.push_str(
        &T::decl(config)
            .lines()
            .map(str::trim_end)
            .collect::<Vec<_>>()
            .join("\n"),
    );
    output.push('\n');
}

fn generated_contracts() -> String {
    let config = Config::default().with_large_int("number");
    let mut output = String::from(HEADER);
    macro_rules! contracts {
        ($($contract:ty),+ $(,)?) => { $(append::<$contract>(&mut output, &config);)+ };
    }
    contracts!(
        DatabaseEngine,
        OperationState,
        CatalogSnapshot,
        Namespace,
        ObjectKind,
        ObjectRef,
        NormalizedTypeFamily,
        crate::catalog::Column,
        ConstraintKind,
        Constraint,
        SortDirection,
        IndexKey,
        Index,
        Relation,
        Routine,
        DatabaseObject,
        ConnectionSelector,
        ConnectionSummary,
        ConnectionListResult,
        ConnectionSelectorArguments,
        ConnectionTestResult,
        SkillTarget,
        SkillTargetSelection,
        SkillInstallState,
        SkillStatusReason,
        SkillConflictKind,
        SkillConflict,
        SkillSummary,
        SkillsListResult,
        SkillsGetArguments,
        crate::SkillGuideFile,
        SkillsGetResult,
        SkillStatusArguments,
        SkillTargetStatus,
        SkillStatusResult,
        SkillTargetExpectation,
        SkillMutationArguments,
        SkillBackup,
        SkillMutationResult,
    );
    output
}

#[test]
fn generated_protocol_contracts_are_current() {
    let path = output_path();
    let expected = generated_contracts();
    if std::env::var_os("DOPEDB_CONTRACT_GENERATE").is_some() {
        std::fs::create_dir_all(path.parent().expect("contract output parent"))
            .expect("create contract output directory");
        std::fs::write(&path, expected).expect("write generated protocol contracts");
        return;
    }
    let actual = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    assert_eq!(
        actual, expected,
        "Rust protocol serde contract drifted; run pnpm generate:contracts"
    );
}

#[test]
fn protocol_serde_samples_preserve_optional_and_required_wire_keys() {
    let namespace = Namespace {
        name: "public".into(),
        comment: None,
    };
    let json = serde_json::to_value(namespace).expect("serialize namespace");
    assert!(
        json.get("comment").is_none(),
        "skip_serializing_if must stay optional"
    );

    let status = SkillTargetStatus {
        target: SkillTarget::Codex,
        display_name: "Codex".into(),
        install_path: "/tmp/skills".into(),
        state: SkillInstallState::Missing,
        repairable: true,
        current_revision: 1,
        installed_revision: None,
        installed_package_digest: None,
        inventory_fingerprint: "f".repeat(64),
        reason: None,
        conflicts: Vec::new(),
    };
    let json = serde_json::to_value(status).expect("serialize skill status");
    for key in ["installedRevision", "installedPackageDigest", "reason"] {
        assert!(
            json.as_object().unwrap().contains_key(key),
            "{key} must be required nullable"
        );
        assert!(json[key].is_null());
    }
}
