//! Catalog wire values and read policy.
//!
//! These values stay independent from Tauri, SQLx, connection pools, and the
//! introspection implementation. Serde defaults preserve the versioned cache and IPC
//! contract.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CatalogReadPolicy {
    CacheFirst,
    Refresh,
}

/// The intentionally bounded shape returned by the workspace connection tree.
///
/// An overview is a complete relation tree, not a partial `Catalog` snapshot.
/// Detailed metadata remains deferred until a consumer requests the full catalog.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CatalogOverviewDetailState {
    /// Columns, constraints, indexes, estimates, and auxiliary objects were not read.
    #[default]
    Deferred,
}

/// Stable reference used to express a relation's parent in the overview tree.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogOverviewRelationRef {
    pub schema: Option<String>,
    pub name: String,
    pub kind: String,
    #[serde(default)]
    pub native_id: Option<String>,
}

/// One relation in the bounded relation tree.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogOverviewRelation {
    pub schema: Option<String>,
    pub name: String,
    pub kind: String,
    #[serde(default)]
    pub native_id: Option<String>,
    #[serde(default)]
    pub comment: Option<String>,
    #[serde(default)]
    pub row_estimate: Option<i64>,
    #[serde(default)]
    pub parent: Option<CatalogOverviewRelationRef>,
}

/// Complete, basic relation tree for a connection.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogOverview {
    pub relations: Vec<CatalogOverviewRelation>,
    #[serde(default)]
    pub detail_state: CatalogOverviewDetailState,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub pk: bool,
    #[serde(default)]
    pub ordinal: u32,
    #[serde(default)]
    pub length: Option<u64>,
    #[serde(default)]
    pub precision: Option<u32>,
    #[serde(default)]
    pub scale: Option<u32>,
    #[serde(default)]
    pub default_expression: Option<String>,
    #[serde(default)]
    pub generated_expression: Option<String>,
    #[serde(default)]
    pub identity: bool,
    #[serde(default)]
    pub auto_increment: bool,
    #[serde(default)]
    pub collation: Option<String>,
    #[serde(default)]
    pub comment: Option<String>,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKey {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub ordinal: u32,
    pub column: String,
    pub references_table: String,
    pub references_column: String,
    #[serde(default)]
    pub references_schema: Option<String>,
    #[serde(default)]
    pub update_action: Option<String>,
    #[serde(default)]
    pub delete_action: Option<String>,
    #[serde(default)]
    pub deferrable: bool,
    #[serde(default = "default_true")]
    pub validated: bool,
}

impl Default for ForeignKey {
    fn default() -> Self {
        Self {
            name: None,
            ordinal: 0,
            column: String::new(),
            references_table: String::new(),
            references_column: String::new(),
            references_schema: None,
            update_action: None,
            delete_action: None,
            deferrable: false,
            validated: true,
        }
    }
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Index {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    #[cfg_attr(test, ts(type = "Array<CatalogIndexKey>"))]
    pub keys: Vec<dopedb_protocol::catalog::IndexKey>,
    #[serde(default)]
    pub included_columns: Vec<String>,
    #[serde(default)]
    pub predicate: Option<String>,
    #[serde(default = "default_true")]
    pub valid: bool,
}

impl Default for Index {
    fn default() -> Self {
        Self {
            name: String::new(),
            columns: Vec::new(),
            unique: false,
            method: None,
            keys: Vec::new(),
            included_columns: Vec::new(),
            predicate: None,
            valid: true,
        }
    }
}

const fn default_true() -> bool {
    true
}

fn default_kind() -> String {
    "table".into()
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Table {
    pub schema: Option<String>,
    pub name: String,
    #[serde(default = "default_kind")]
    pub kind: String,
    #[serde(default)]
    pub native_id: Option<String>,
    #[serde(default)]
    pub comment: Option<String>,
    #[serde(default)]
    #[cfg_attr(test, ts(type = "CatalogObjectRef | null"))]
    pub partition_parent: Option<dopedb_protocol::catalog::ObjectRef>,
    #[serde(default)]
    #[cfg_attr(test, ts(type = "Array<CatalogObjectRef>"))]
    pub partition_children: Vec<dopedb_protocol::catalog::ObjectRef>,
    pub columns: Vec<Column>,
    pub foreign_keys: Vec<ForeignKey>,
    #[serde(default)]
    #[cfg_attr(test, ts(type = "Array<CatalogConstraint>"))]
    pub constraints: Vec<dopedb_protocol::catalog::Constraint>,
    #[serde(default)]
    pub indexes: Vec<Index>,
    pub row_estimate: Option<i64>,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseObject {
    pub schema: Option<String>,
    pub name: String,
    pub kind: String,
    #[serde(default)]
    pub native_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    #[serde(default)]
    pub arguments: Vec<String>,
    #[serde(default)]
    pub return_type: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub comment: Option<String>,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub tables: Vec<Table>,
    #[serde(default)]
    pub objects: Vec<DatabaseObject>,
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use ts_rs::{Config, TS};

    use super::{
        Catalog, CatalogOverview, CatalogOverviewDetailState, CatalogOverviewRelation,
        CatalogOverviewRelationRef, Column, DatabaseObject, ForeignKey, Index, Table,
    };
    use crate::model::normalize_generated_contract_newlines;

    const HEADER: &str = "// Generated from src-tauri/src/features/catalog/domain.rs by ts-rs 12.0.1.\n// Do not edit; run pnpm generate:contracts.\n\nimport type { Constraint as CatalogConstraint, IndexKey as CatalogIndexKey, ObjectRef as CatalogObjectRef } from \"./protocol-contracts\";\n\n";

    fn contract_output_path() -> PathBuf {
        std::env::var_os("DOPEDB_CATALOG_FEATURE_CONTRACT_OUTPUT")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../src/ipc/generated/catalog-feature-contracts.ts")
            })
    }

    fn generated_contracts() -> String {
        let config = Config::default().with_large_int("number");
        let mut output = String::from(HEADER);
        for declaration in [
            CatalogOverviewDetailState::decl(&config),
            CatalogOverviewRelationRef::decl(&config),
            CatalogOverviewRelation::decl(&config),
            CatalogOverview::decl(&config),
            Column::decl(&config),
            ForeignKey::decl(&config),
            Index::decl(&config),
            Table::decl(&config),
            DatabaseObject::decl(&config),
            Catalog::decl(&config),
        ] {
            output.push_str("export ");
            output.push_str(
                &declaration
                    .lines()
                    .map(str::trim_end)
                    .collect::<Vec<_>>()
                    .join("\n"),
            );
            output.push('\n');
        }
        output
    }

    #[test]
    fn generated_catalog_feature_contracts_are_current() {
        let path = contract_output_path();
        let expected = generated_contracts();
        if std::env::var_os("DOPEDB_CONTRACT_GENERATE").is_some() {
            std::fs::create_dir_all(path.parent().expect("contract output parent"))
                .expect("create contract output directory");
            std::fs::write(&path, expected).expect("write generated catalog contracts");
            return;
        }
        let actual = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
        assert_eq!(
            normalize_generated_contract_newlines(&actual),
            normalize_generated_contract_newlines(&expected),
            "Rust catalog serde contract drifted; run pnpm generate:contracts"
        );
    }

    #[test]
    fn catalog_keeps_pre_object_cache_json_compatible() {
        let catalog: Catalog = serde_json::from_str(r#"{"tables":[]}"#).unwrap();

        assert!(catalog.tables.is_empty());
        assert!(catalog.objects.is_empty());
    }

    #[test]
    fn overview_declares_that_detail_metadata_is_deferred() {
        let overview = CatalogOverview::default();

        assert_eq!(
            overview.detail_state,
            CatalogOverviewDetailState::Deferred,
            "an overview must never claim to be a partial full catalog"
        );
    }
}
