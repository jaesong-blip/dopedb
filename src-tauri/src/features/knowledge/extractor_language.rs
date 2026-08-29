use dopedb_protocol::KnowledgeNodeKind;
use sha2::{Digest, Sha256};
use tree_sitter::{Language, Node};
use uuid::Uuid;

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Copy)]
pub(super) enum SupportedLanguage {
    TypeScript,
    Tsx,
    Rust,
}

impl SupportedLanguage {
    pub(super) fn for_path(path: &str) -> Option<Self> {
        if path.ends_with(".tsx") {
            Some(Self::Tsx)
        } else if path.ends_with(".ts") || path.ends_with(".js") || path.ends_with(".jsx") {
            Some(Self::TypeScript)
        } else if path.ends_with(".rs") {
            Some(Self::Rust)
        } else {
            None
        }
    }

    pub(super) fn parser(self) -> Language {
        match self {
            Self::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            Self::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
            Self::Rust => tree_sitter_rust::LANGUAGE.into(),
        }
    }

    pub(super) fn label(self) -> &'static str {
        match self {
            Self::TypeScript => "typescript",
            Self::Tsx => "tsx",
            Self::Rust => "rust",
        }
    }
}

pub(super) fn definition_kind(
    language: SupportedLanguage,
    kind: &str,
) -> Option<KnowledgeNodeKind> {
    match language {
        SupportedLanguage::TypeScript | SupportedLanguage::Tsx => match kind {
            "function_declaration" | "method_definition" => Some(KnowledgeNodeKind::Function),
            "class_declaration"
            | "interface_declaration"
            | "type_alias_declaration"
            | "enum_declaration" => Some(KnowledgeNodeKind::Type),
            _ => None,
        },
        SupportedLanguage::Rust => match kind {
            "function_item" => Some(KnowledgeNodeKind::Function),
            "struct_item" | "enum_item" | "trait_item" | "type_item" => {
                Some(KnowledgeNodeKind::Type)
            }
            "mod_item" => Some(KnowledgeNodeKind::Module),
            _ => None,
        },
    }
}

pub(super) fn import_kind(language: SupportedLanguage, kind: &str) -> bool {
    match language {
        SupportedLanguage::TypeScript | SupportedLanguage::Tsx => kind == "import_statement",
        SupportedLanguage::Rust => kind == "use_declaration",
    }
}

pub(super) fn import_target(node: Node<'_>, source: &[u8]) -> AppResult<String> {
    if let Some(target) = node.child_by_field_name("source") {
        return Ok(node_text(target, source)?
            .trim_matches(|character| character == '\'' || character == '"')
            .to_owned());
    }
    Ok(node_text(node, source)?
        .trim_start_matches("use")
        .trim()
        .trim_end_matches(';')
        .to_owned())
}

pub(super) fn node_text(node: Node<'_>, source: &[u8]) -> AppResult<String> {
    let bytes = source
        .get(node.byte_range())
        .ok_or_else(|| AppError::Blocked {
            reason: "the Knowledge parser returned an invalid source range".into(),
        })?;
    let value = std::str::from_utf8(bytes)
        .map_err(|_| AppError::Config("Knowledge source text must be UTF-8".into()))?;
    Ok(value.trim().to_owned())
}

pub(super) fn valid_symbol(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 512
        && value
            .chars()
            .all(|character| character.is_alphanumeric() || "_.$:?<>".contains(character))
}

pub(super) fn safe_text(value: &str) -> AppResult<String> {
    if value.is_empty() || value.len() > 16 * 1024 || value.chars().any(char::is_control) {
        return Err(AppError::Blocked {
            reason: "Knowledge extraction produced an unsafe identifier".into(),
        });
    }
    Ok(value.to_owned())
}

pub(super) fn hash(value: &str) -> String {
    hash_bytes(value.as_bytes())
}

pub(super) fn hash_bytes(value: &[u8]) -> String {
    hex::encode(Sha256::digest(value))
}

pub(super) fn uuid_from_hash(hash: &str) -> Uuid {
    let mut bytes = [0_u8; 16];
    hex::decode_to_slice(&hash[..32], &mut bytes).expect("SHA-256 UUID bytes");
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes)
}
