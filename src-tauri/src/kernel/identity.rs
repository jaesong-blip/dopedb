//! Strong resource identities used at feature boundaries.
//!
//! A raw UUID can otherwise be passed to the wrong lookup without a compiler error.
//! These transparent wrappers keep the existing wire representation while making
//! connection, workspace, and document identities distinct inside the Rust core.

use std::fmt;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

macro_rules! uuid_identity {
    ($name:ident) => {
        #[derive(
            Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize,
        )]
        #[serde(transparent)]
        pub(crate) struct $name(Uuid);

        impl From<Uuid> for $name {
            fn from(value: Uuid) -> Self {
                Self(value)
            }
        }

        impl From<$name> for Uuid {
            fn from(value: $name) -> Self {
                value.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                self.0.fmt(formatter)
            }
        }
    };
}

uuid_identity!(WorkspaceId);
uuid_identity!(ConnectionId);
uuid_identity!(SqlDocumentId);

/// Stable, non-secret account partition used by local synchronized artifacts.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) struct AccountScopeId(String);

impl AccountScopeId {
    pub(crate) fn new(value: impl Into<String>) -> Option<Self> {
        let value = value.into();
        (!value.is_empty()).then_some(Self(value))
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

/// Complete database resource identity. A connection UUID is never looked up without
/// the workspace that gives it meaning.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct WorkspaceConnectionId {
    pub(crate) workspace_id: WorkspaceId,
    pub(crate) connection_id: ConnectionId,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typed_uuid_keeps_the_existing_wire_shape() {
        let raw = Uuid::parse_str("4c66c576-6229-44ad-98c2-65eb80b914cc").unwrap();
        let encoded = serde_json::to_string(&ConnectionId::from(raw)).unwrap();
        assert_eq!(encoded, format!("\"{raw}\""));
        assert_eq!(
            Uuid::from(serde_json::from_str::<ConnectionId>(&encoded).unwrap()),
            raw
        );
    }

    #[test]
    fn account_scope_rejects_an_ambiguous_empty_partition() {
        assert!(AccountScopeId::new("").is_none());
        assert_eq!(
            AccountScopeId::new("personal").unwrap().as_str(),
            "personal"
        );
    }
}
