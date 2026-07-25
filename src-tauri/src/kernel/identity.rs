//! Strong resource identities used at feature boundaries.
//!
//! A raw UUID can otherwise be passed to the wrong lookup without a compiler error.
//! These transparent wrappers keep the existing wire representation while making
//! connection, workspace, and document identities distinct inside the Rust core.

use std::fmt;
use std::ops::Deref;

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
uuid_identity!(ErdLayoutId);
uuid_identity!(ErdVirtualRelationId);
uuid_identity!(JobId);
uuid_identity!(JobFileCapabilityId);
uuid_identity!(JobArtifactId);
uuid_identity!(OperationId);

/// Complete job lookup identity. A job UUID is never loaded without the
/// connection scope that gives it meaning.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct ConnectionJobId {
    pub(crate) connection_id: ConnectionId,
    pub(crate) job_id: JobId,
}

/// Complete ERD layout lookup identity. Layout UUIDs are meaningful only inside
/// the connection whose catalog they present.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct ConnectionErdLayoutId {
    pub(crate) connection_id: ConnectionId,
    pub(crate) layout_id: ErdLayoutId,
}

/// Public account identity returned by the hosted authentication authority.
///
/// It is deliberately distinct from [`AccountScopeId`]: an account identifies a
/// signed-in person, while an account scope is the local storage partition derived
/// from the currently selected workspace/account pair.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
pub(crate) struct AccountId(String);

impl AccountId {
    pub(crate) fn new(value: impl Into<String>) -> Option<Self> {
        let value = value.into();
        (!value.is_empty()
            && value.len() <= 255
            && !value
                .chars()
                .any(|character| character.is_whitespace() || character.is_control()))
        .then_some(Self(value))
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for AccountId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).ok_or_else(|| serde::de::Error::custom("invalid account id"))
    }
}

impl fmt::Display for AccountId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

impl Deref for AccountId {
    type Target = str;

    fn deref(&self) -> &Self::Target {
        self.as_str()
    }
}

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
    fn job_identities_are_not_interchangeable_but_keep_uuid_json() {
        let raw = Uuid::parse_str("7d7f5635-f09c-4733-ae63-20aeb25d73c0").unwrap();
        let job_id = JobId::from(raw);
        let capability_id = JobFileCapabilityId::from(raw);
        let artifact_id = JobArtifactId::from(raw);
        let operation_id = OperationId::from(raw);

        for encoded in [
            serde_json::to_string(&job_id).unwrap(),
            serde_json::to_string(&capability_id).unwrap(),
            serde_json::to_string(&artifact_id).unwrap(),
            serde_json::to_string(&operation_id).unwrap(),
        ] {
            assert_eq!(encoded, format!("\"{raw}\""));
        }
    }

    #[test]
    fn erd_layout_identity_keeps_uuid_json() {
        let raw = Uuid::parse_str("7367d7c9-9b54-465b-b710-f4251b8442fa").unwrap();
        let encoded = serde_json::to_string(&ErdLayoutId::from(raw)).unwrap();
        assert_eq!(encoded, format!("\"{raw}\""));
        assert_eq!(
            serde_json::to_string(&ErdVirtualRelationId::from(raw)).unwrap(),
            format!("\"{raw}\"")
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

    #[test]
    fn account_identity_is_distinct_and_keeps_its_wire_shape() {
        let account = AccountId::new("account-123").unwrap();
        assert_eq!(serde_json::to_string(&account).unwrap(), "\"account-123\"");
        assert_eq!(account.as_str(), "account-123");
        assert!(AccountId::new("").is_none());
        assert!(serde_json::from_str::<AccountId>("\"\"").is_err());
        assert!(serde_json::from_str::<AccountId>("\"account id\"").is_err());
    }
}
