//! Dialect-neutral schema-change contracts shared by the desktop UI and runtime.
//!
//! The UI describes intent with this IR and never assembles executable DDL. A
//! renderer validates the request against an exact Catalog V2 fingerprint and
//! returns a complete preview before the ordinary Operation approval path is used.

use serde::{Deserialize, Serialize};

use crate::{Constraint, DatabaseEngine, Index, ObjectRef};

/// Current wire/storage version for structured schema-change requests.
pub const DDL_IR_SCHEMA_VERSION: u32 = 1;

/// One column in a newly created table or an `ADD COLUMN` operation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ColumnDefinition {
    pub name: String,
    pub native_type: String,
    pub nullable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_expression: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generated_expression: Option<String>,
    #[serde(default)]
    pub identity: bool,
    #[serde(default)]
    pub auto_increment: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

/// Complete definition used by `CREATE TABLE`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TableDefinition {
    pub relation: ObjectRef,
    #[serde(default)]
    pub columns: Vec<ColumnDefinition>,
    #[serde(default)]
    pub constraints: Vec<Constraint>,
    #[serde(default)]
    pub indexes: Vec<Index>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

/// Explicit default-expression transition. `Keep` is distinct from dropping a
/// default, avoiding ambiguous nested optional values at the JSON boundary.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "action", deny_unknown_fields)]
pub enum DefaultChange {
    #[default]
    Keep,
    Drop,
    Set {
        expression: String,
    },
}

/// Supported column mutations. An empty alteration is invalid.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ColumnAlteration {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nullable: Option<bool>,
    #[serde(default)]
    pub default: DefaultChange,
}

/// Versioned dialect-neutral schema mutation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", deny_unknown_fields)]
pub enum SchemaChange {
    CreateTable {
        table: TableDefinition,
    },
    DropTable {
        relation: ObjectRef,
    },
    RenameTable {
        relation: ObjectRef,
        new_name: String,
    },
    AddColumn {
        relation: ObjectRef,
        column: ColumnDefinition,
    },
    AlterColumn {
        relation: ObjectRef,
        column: String,
        alteration: ColumnAlteration,
    },
    DropColumn {
        relation: ObjectRef,
        column: String,
    },
    AddConstraint {
        relation: ObjectRef,
        constraint: Constraint,
    },
    DropConstraint {
        relation: ObjectRef,
        name: String,
    },
    CreateIndex {
        relation: ObjectRef,
        index: Index,
    },
    DropIndex {
        relation: ObjectRef,
        name: String,
    },
}

impl SchemaChange {
    /// Relation whose current catalog metadata authorizes this change.
    pub fn relation(&self) -> &ObjectRef {
        match self {
            Self::CreateTable { table } => &table.relation,
            Self::DropTable { relation }
            | Self::RenameTable { relation, .. }
            | Self::AddColumn { relation, .. }
            | Self::AlterColumn { relation, .. }
            | Self::DropColumn { relation, .. }
            | Self::AddConstraint { relation, .. }
            | Self::DropConstraint { relation, .. }
            | Self::CreateIndex { relation, .. }
            | Self::DropIndex { relation, .. } => relation,
        }
    }
}

/// Client request pinned to the Catalog snapshot rendered alongside it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SchemaChangeRequest {
    pub schema_version: u32,
    pub catalog_fingerprint: String,
    pub change: SchemaChange,
}

impl SchemaChangeRequest {
    pub fn new(catalog_fingerprint: impl Into<String>, change: SchemaChange) -> Self {
        Self {
            schema_version: DDL_IR_SCHEMA_VERSION,
            catalog_fingerprint: catalog_fingerprint.into(),
            change,
        }
    }
}

/// Fully rendered, human-reviewable DDL. Every statement is part of the exact
/// proposal payload; renderers never return an implicit follow-up step.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DdlPlan {
    pub schema_version: u32,
    pub engine: DatabaseEngine,
    pub catalog_fingerprint: String,
    pub statements: Vec<String>,
    pub transactional: bool,
    pub requires_rebuild: bool,
    #[serde(default)]
    pub warnings: Vec<String>,
}

impl DdlPlan {
    pub fn sql(&self) -> String {
        self.statements.join("\n")
    }
}
