//! ERD presentation values and invariants.
//!
//! Physical relationships remain catalog facts. This feature persists only canvas
//! presentation and explicitly virtual relations, so it cannot mutate a database
//! schema as a side effect of opening, saving, or sharing an ERD.

use std::collections::HashSet;

use dopedb_protocol::catalog::ObjectRef;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::kernel::identity::{ConnectionId, ErdLayoutId, ErdVirtualRelationId};

const MAX_LAYOUT_BYTES: usize = 8 * 1024 * 1024;
const MAX_NODES: usize = 50_000;
const MAX_VIRTUAL_RELATIONS: usize = 50_000;
const MAX_NAME_CHARS: usize = 120;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ErdLayoutMode {
    Physical,
    Logical,
    Uml,
}

impl ErdLayoutMode {
    pub(crate) const fn storage_key(self) -> &'static str {
        match self {
            Self::Physical => "physical",
            Self::Logical => "logical",
            Self::Uml => "uml",
        }
    }

    pub(crate) fn parse(value: &str) -> AppResult<Self> {
        match value {
            "physical" => Ok(Self::Physical),
            "logical" => Ok(Self::Logical),
            "uml" => Ok(Self::Uml),
            _ => Err(AppError::Config("stored ERD layout mode is invalid".into())),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ErdNodePosition {
    pub(crate) relation_key: String,
    pub(crate) x: f64,
    pub(crate) y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ErdViewport {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) zoom: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ErdCanvasLayout {
    pub(crate) nodes: Vec<ErdNodePosition>,
    pub(crate) viewport: ErdViewport,
    #[serde(default)]
    pub(crate) compact: bool,
    #[serde(default)]
    pub(crate) hidden_relation_keys: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ErdVirtualRelation {
    pub(crate) id: ErdVirtualRelationId,
    pub(crate) from_relation: ObjectRef,
    pub(crate) from_columns: Vec<String>,
    pub(crate) to_relation: ObjectRef,
    pub(crate) to_columns: Vec<String>,
    pub(crate) label: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ErdLayout {
    pub(crate) id: ErdLayoutId,
    pub(crate) connection_id: ConnectionId,
    pub(crate) name: String,
    pub(crate) mode: ErdLayoutMode,
    pub(crate) catalog_fingerprint: String,
    pub(crate) layout: ErdCanvasLayout,
    pub(crate) virtual_relations: Vec<ErdVirtualRelation>,
    pub(crate) revision: i64,
    pub(crate) remote_id: Option<String>,
    pub(crate) remote_revision: Option<i64>,
    pub(crate) sync_status: String,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

#[derive(Debug, Clone)]
pub(crate) struct ErdLayoutPayload {
    pub(crate) name: String,
    pub(crate) mode: ErdLayoutMode,
    pub(crate) catalog_fingerprint: String,
    pub(crate) layout: ErdCanvasLayout,
    pub(crate) virtual_relations: Vec<ErdVirtualRelation>,
}

impl ErdLayoutPayload {
    pub(crate) fn validated(
        name: String,
        mode: ErdLayoutMode,
        catalog_fingerprint: String,
        layout: ErdCanvasLayout,
        virtual_relations: Vec<ErdVirtualRelation>,
    ) -> AppResult<Self> {
        let name = name.trim().to_owned();
        validate_name(&name)?;
        validate_fingerprint(&catalog_fingerprint)?;
        validate_canvas(&layout)?;
        validate_virtual_relations(&virtual_relations)?;
        let serialized_bytes =
            serde_json::to_vec(&layout)?.len() + serde_json::to_vec(&virtual_relations)?.len();
        if serialized_bytes > MAX_LAYOUT_BYTES {
            return Err(AppError::Config(format!(
                "ERD layout exceeds the {} MiB local limit",
                MAX_LAYOUT_BYTES / 1024 / 1024
            )));
        }
        Ok(Self {
            name,
            mode,
            catalog_fingerprint,
            layout,
            virtual_relations,
        })
    }
}

fn validate_name(name: &str) -> AppResult<()> {
    if name.is_empty() || name.chars().count() > MAX_NAME_CHARS {
        return Err(AppError::Config(format!(
            "ERD layout name must contain 1 to {MAX_NAME_CHARS} characters"
        )));
    }
    Ok(())
}

fn validate_fingerprint(fingerprint: &str) -> AppResult<()> {
    if fingerprint.len() != 64
        || !fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(AppError::Config(
            "ERD layout catalog fingerprint must be lowercase SHA-256".into(),
        ));
    }
    Ok(())
}

fn validate_canvas(layout: &ErdCanvasLayout) -> AppResult<()> {
    if layout.nodes.len() > MAX_NODES {
        return Err(AppError::Config("ERD layout item limit exceeded".into()));
    }
    if !layout.viewport.x.is_finite()
        || !layout.viewport.y.is_finite()
        || !layout.viewport.zoom.is_finite()
        || !(0.05..=8.0).contains(&layout.viewport.zoom)
    {
        return Err(AppError::Config("ERD viewport is invalid".into()));
    }
    let mut node_keys = HashSet::new();
    for node in &layout.nodes {
        if node.relation_key.is_empty()
            || node.relation_key.len() > 2_048
            || !node.x.is_finite()
            || !node.y.is_finite()
            || !node_keys.insert(&node.relation_key)
        {
            return Err(AppError::Config(
                "ERD node positions contain an invalid or duplicate relation".into(),
            ));
        }
    }
    Ok(())
}

fn validate_virtual_relations(relations: &[ErdVirtualRelation]) -> AppResult<()> {
    if relations.len() > MAX_VIRTUAL_RELATIONS {
        return Err(AppError::Config("ERD layout item limit exceeded".into()));
    }
    let mut relation_ids = HashSet::new();
    for relation in relations {
        if !relation_ids.insert(relation.id)
            || relation.from_columns.is_empty()
            || relation.from_columns.len() != relation.to_columns.len()
            || relation
                .from_columns
                .iter()
                .chain(&relation.to_columns)
                .any(|column| column.trim().is_empty())
            || relation.from_relation == relation.to_relation
        {
            return Err(AppError::Config(
                "ERD virtual relationship is invalid or duplicated".into(),
            ));
        }
    }
    Ok(())
}
