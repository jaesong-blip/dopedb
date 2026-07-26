//! Desktop SQL adapter contracts, lease-backed receipts, and error projections.

use crate::connection::{ConnectionLease, ConnectionOperationScope};
use crate::error::AppError;
use crate::kernel::identity::OperationId;
use crate::model::{Classification, ExecOutcome, PreviewReport};
use crate::operations::OperationState;
use crate::store::PinnedConnection;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::fmt;

/// Exact immutable proposal rendered by the desktop before approval or execution.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "SqlOperationProposal"))]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopSqlProposalReceipt {
    #[cfg_attr(test, ts(type = "string"))]
    pub(crate) operation_id: OperationId,
    pub(crate) payload_hash: String,
    #[cfg_attr(test, ts(type = "OperationState"))]
    pub(crate) state: OperationState,
    pub(crate) approval_required: bool,
    pub(crate) auto_run: bool,
    pub(crate) confirmation_phrase: Option<String>,
    pub(crate) expires_at: chrono::DateTime<Utc>,
    pub(crate) classification: Classification,
    pub(crate) preview: PreviewReport,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StoredDesktopSqlPayload {
    pub(super) sql: String,
    pub(super) history_origin: String,
}

/// Authority retained by an impact preview. Pre-connection skipped reports keep
/// the operation scope itself; reports that touched the database keep the exact
/// connection lease used to produce them.
pub(crate) enum DesktopSqlPreviewAuthority {
    Scope { _scope: ConnectionOperationScope },
    Lease { _lease: Box<ConnectionLease> },
}

/// Atomic desktop inspection response. The private policy snapshot is the exact
/// policy later persisted in a proposal; the serialized wire only exposes the
/// classification and preview data needed by the desktop.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "SqlInspection"))]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopSqlInspectionReceipt {
    pub(super) classification: Classification,
    pub(super) report: PreviewReport,
    #[serde(skip)]
    #[cfg_attr(test, ts(skip))]
    pub(super) pin: PinnedConnection,
    #[serde(skip)]
    #[cfg_attr(test, ts(skip))]
    pub(super) policy_snapshot: serde_json::Value,
    #[serde(skip)]
    #[cfg_attr(test, ts(skip))]
    pub(super) policy_revision: String,
    #[serde(skip)]
    #[cfg_attr(test, ts(skip))]
    pub(super) _authority: DesktopSqlPreviewAuthority,
}

impl DesktopSqlInspectionReceipt {
    /// Preserve the inspection scope or lease until the transport has projected
    /// a subsequent proposal error to the established AppError wire shape.
    pub(super) fn into_error(self, error: AppError) -> DesktopSqlInspectionError {
        DesktopSqlInspectionError::Scoped {
            error,
            _authority: self._authority,
        }
    }
}

/// Successful desktop execution retaining the exact connection lease until Tauri
/// has serialized the legacy [`ExecOutcome`] response.
pub(crate) struct DesktopSqlRunReceipt {
    pub(super) outcome: ExecOutcome,
    pub(super) _lease: ConnectionLease,
}

impl serde::Serialize for DesktopSqlRunReceipt {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serde::Serialize::serialize(&self.outcome, serializer)
    }
}

/// Desktop execution failures preserve the existing structured `AppError` wire
/// while retaining authority for blocked and post-connect failures until the thin
/// adapter maps the error.
#[derive(Debug)]
pub(crate) enum DesktopSqlRunError {
    Blocked(DesktopSqlRunBlocked),
    Application(AppError),
    Execution(Box<DesktopSqlExecutionFailure>),
}

impl DesktopSqlRunError {
    pub(crate) fn into_error(self) -> AppError {
        match self {
            Self::Blocked(blocked) => blocked.into_error(),
            Self::Application(error) => error,
            Self::Execution(failure) => failure.into_error(),
        }
    }
}

/// A policy rejection that holds the operation scope through adapter error
/// mapping, preventing a concurrent workspace switch from relabeling the result.
pub(crate) struct DesktopSqlRunBlocked {
    pub(super) reason: String,
    pub(super) _scope: ConnectionOperationScope,
}

impl fmt::Debug for DesktopSqlRunBlocked {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DesktopSqlRunBlocked")
            .field("reason", &self.reason)
            .finish_non_exhaustive()
    }
}

impl DesktopSqlRunBlocked {
    pub(super) fn into_error(self) -> AppError {
        AppError::Blocked {
            reason: self.reason,
        }
    }
}

/// A post-connect failure retaining the live lease until adapter error mapping.
pub(crate) struct DesktopSqlExecutionFailure {
    pub(super) error: AppError,
    pub(super) _lease: ConnectionLease,
}

impl fmt::Debug for DesktopSqlExecutionFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DesktopSqlExecutionFailure")
            .field("error", &self.error)
            .finish_non_exhaustive()
    }
}

impl DesktopSqlExecutionFailure {
    pub(super) fn into_error(self) -> AppError {
        self.error
    }
}

/// Desktop classification/preview failures retain the structured `AppError`
/// contract currently returned by Tauri.
pub(crate) enum DesktopSqlInspectionError {
    Application(AppError),
    Scoped {
        error: AppError,
        _authority: DesktopSqlPreviewAuthority,
    },
}

impl fmt::Debug for DesktopSqlInspectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Application(error) => formatter.debug_tuple("Application").field(error).finish(),
            Self::Scoped { error, .. } => formatter.debug_tuple("Scoped").field(error).finish(),
        }
    }
}

impl DesktopSqlInspectionError {
    pub(crate) fn into_error(self) -> AppError {
        match self {
            Self::Application(error) | Self::Scoped { error, .. } => error,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use chrono::{TimeZone, Utc};
    use ts_rs::{Config, TS};
    use uuid::Uuid;

    use super::{DesktopSqlInspectionReceipt, DesktopSqlProposalReceipt};
    use crate::kernel::identity::OperationId;
    use crate::model::{Classification, PreviewMode, PreviewReport, QueryKind, RiskLevel};
    use crate::operations::OperationState;

    const HEADER: &str = "// Generated Query receipt contracts from src-tauri/src/features/queries/adapters/desktop_contracts.rs by ts-rs 12.0.1.\n// Do not edit; run pnpm generate:contracts.\n\nimport type { Classification, PreviewReport } from \"../../../ipc/generated/model\";\nimport type { OperationState } from \"../../../ipc/generated/protocol-contracts\";\n\n";

    fn output_path() -> PathBuf {
        std::env::var_os("DOPEDB_QUERY_CONTRACT_OUTPUT")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../src/features/queries/generated/contracts.ts")
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

    fn generated_query_contracts() -> String {
        let config = Config::default().with_large_int("number");
        let mut output = String::from(HEADER);
        append::<DesktopSqlInspectionReceipt>(&mut output, &config);
        append::<DesktopSqlProposalReceipt>(&mut output, &config);
        output
    }

    #[test]
    fn generated_query_receipt_contracts_are_current() {
        let output_path = output_path();
        let expected = generated_query_contracts();
        if std::env::var_os("DOPEDB_CONTRACT_GENERATE").is_some() {
            std::fs::create_dir_all(output_path.parent().expect("query contract output parent"))
                .expect("create query contract output directory");
            std::fs::write(&output_path, expected)
                .expect("write generated query receipt contracts");
            return;
        }
        let actual = std::fs::read_to_string(&output_path)
            .unwrap_or_else(|error| panic!("read {}: {error}", output_path.display()));
        assert_eq!(
            actual, expected,
            "Rust Query receipt serde contract drifted; run pnpm generate:contracts"
        );
    }

    #[test]
    fn generated_query_receipt_contracts_preserve_actual_wire_shape() {
        let generated = generated_query_contracts();
        for expected in [
            "export type SqlInspection = { classification: Classification, report: PreviewReport, };",
            "operationId: string",
            "payloadHash: string",
            "state: OperationState",
            "confirmationPhrase: string | null",
            "expiresAt: string",
        ] {
            assert!(generated.contains(expected), "missing generated contract: {expected}");
        }
    }

    #[test]
    fn proposal_wire_matches_the_generated_nested_query_contract() {
        let receipt = DesktopSqlProposalReceipt {
            operation_id: OperationId::from(Uuid::from_u128(7)),
            payload_hash: "hash".into(),
            state: OperationState::Ready,
            approval_required: false,
            auto_run: true,
            confirmation_phrase: None,
            expires_at: Utc.timestamp_opt(0, 0).single().expect("epoch"),
            classification: Classification {
                kind: QueryKind::Read,
                risk: RiskLevel::Low,
                statement_count: 1,
                no_where: false,
                tables: Vec::new(),
                notes: Vec::new(),
                rollback_safe: false,
            },
            preview: PreviewReport {
                mode: PreviewMode::Explain,
                estimated_rows: None,
                exact_rows: None,
                plan: None,
                note: None,
            },
        };
        let wire = serde_json::to_value(receipt).expect("serialize proposal");
        assert_eq!(wire["operationId"], Uuid::from_u128(7).to_string());
        assert_eq!(wire["state"], "ready");
        assert_eq!(wire["classification"]["statementCount"], 1);
        assert_eq!(wire["preview"]["mode"], "explain");
        assert!(wire["confirmationPhrase"].is_null());
    }
}
