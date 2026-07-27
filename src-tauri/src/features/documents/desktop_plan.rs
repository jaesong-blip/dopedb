//! Immutable desktop document-read planning.

use super::*;

impl DocumentPlatformAdapter {
    /// Persist one immutable, typed document-read plan. Unsafe aggregate stages are
    /// rejected before an operation exists and there is never a document write grant.
    pub(crate) async fn propose_desktop_read(
        &self,
        request: DesktopDocumentProposalRequest,
    ) -> Result<DesktopDocumentProposalReceipt, DesktopDocumentReadError> {
        let operation_scope = self.connections.begin_operation_scope().await;
        let pin = operation_scope
            .pin_connection_for_view(request.connection_id)
            .await
            .map_err(DesktopDocumentReadError::Application)?;
        if !pin.profile.engine.is_document() {
            return Err(DesktopDocumentReadError::NonDocumentConnection);
        }
        if !pin.profile.workspace_access.can_read() {
            return Err(DesktopDocumentReadError::Blocked(DesktopDocumentBlocked {
                reason: "your workspace role cannot read this document connection".into(),
                _scope: operation_scope,
            }));
        }
        let settings = self
            .store
            .get_safety(pin.connection_id)
            .await
            .map_err(DesktopDocumentReadError::Application)?;
        let classification = crate::mongo::query::classify(&request.query);
        if let Some(reason) = desktop_blocked_reason(&settings, &classification) {
            return Err(DesktopDocumentReadError::Blocked(DesktopDocumentBlocked {
                reason,
                _scope: operation_scope,
            }));
        }
        let policy =
            capture_policy(&pin, &settings).map_err(DesktopDocumentReadError::Application)?;
        let history_origin = request.origin.unwrap_or_else(|| "manual".into());
        let payload = serde_json::to_value(StoredDesktopDocumentPayload {
            query: request.query,
            history_origin: history_origin.clone(),
        })
        .map_err(AppError::from)
        .map_err(DesktopDocumentReadError::Application)?;
        let operation_id = Uuid::new_v4();
        let expires_at = Utc::now()
            + ChronoDuration::from_std(QUERY_PLAN_TTL)
                .expect("query plan TTL is representable by chrono");
        let operation = self
            .operation
            .plan(
                NewOperation {
                    id: operation_id,
                    workspace_id: pin.scope.workspace_id,
                    account_scope: pin.scope.account_scope.storage_key().into(),
                    connection_id: pin.connection_id,
                    connection_revision: pin.connection_revision,
                    terminal_session_id: None,
                    actor: actor_for_pin(&pin, history_origin),
                    kind: OperationKind::DocumentRead,
                    payload_schema_version: 1,
                    payload,
                    schema_fingerprint: None,
                    risk_level: document_operation_risk(&classification),
                    preview: serde_json::to_value(&classification)
                        .map_err(AppError::from)
                        .map_err(DesktopDocumentReadError::Application)?,
                    policy_snapshot: policy.snapshot,
                    policy_revision: policy.revision,
                    single_use: true,
                    idempotency_key: operation_id.to_string(),
                    expires_at: Some(expires_at),
                },
                OperationPlanDisposition::Ready,
            )
            .await
            .map_err(DesktopDocumentReadError::Application)?;
        Ok(DesktopDocumentProposalReceipt {
            operation_id: operation.id,
            payload_hash: operation.payload_hash,
            state: operation.state,
            expires_at,
        })
    }
}
