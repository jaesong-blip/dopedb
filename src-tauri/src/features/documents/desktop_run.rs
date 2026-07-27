//! Desktop document-read execution by durable operation identity.

use super::*;

impl DocumentPlatformAdapter {
    /// Execute one typed document read by immutable operation id only.
    pub(crate) async fn run_desktop_read(
        &self,
        operation_id: Uuid,
    ) -> Result<DocumentReadReceipt, DesktopDocumentReadError> {
        let planned = self
            .operation
            .get(operation_id)
            .await
            .map_err(DesktopDocumentReadError::Application)?;
        if planned.kind != OperationKind::DocumentRead || planned.payload_schema_version != 1 {
            return Err(DesktopDocumentReadError::Application(AppError::Blocked {
                reason: "operation is not a supported document-read plan".into(),
            }));
        }
        let payload: StoredDesktopDocumentPayload = serde_json::from_value(planned.payload.clone())
            .map_err(AppError::from)
            .map_err(DesktopDocumentReadError::Application)?;
        let operation_scope = self.connections.begin_operation_scope().await;
        let pin = operation_scope
            .pin_connection(planned.connection_id)
            .await
            .map_err(DesktopDocumentReadError::Application)?;
        ensure_operation_scope(&planned, &pin).map_err(DesktopDocumentReadError::Application)?;
        let engine = pin.profile.engine;
        if !engine.is_document() {
            return Err(DesktopDocumentReadError::NonDocumentConnection);
        }
        let settings = self
            .store
            .get_safety(pin.connection_id)
            .await
            .map_err(DesktopDocumentReadError::Application)?;
        let policy =
            capture_policy(&pin, &settings).map_err(DesktopDocumentReadError::Application)?;
        if policy.revision != planned.policy_revision {
            return Err(DesktopDocumentReadError::Blocked(DesktopDocumentBlocked {
                reason: "the connection or safety policy changed; create a new plan".into(),
                _scope: operation_scope,
            }));
        }
        let classification = crate::mongo::query::classify(&payload.query);
        let history_origin = payload.history_origin;
        let query_text = serde_json::to_string(&payload.query)
            .map_err(AppError::from)
            .map_err(DesktopDocumentReadError::Application)?;

        if let Some(reason) = desktop_blocked_reason(&settings, &classification) {
            record_desktop_outcome(
                &self.store,
                &pin,
                &query_text,
                classification.kind,
                "blocked",
                "blocked",
                None,
                None,
                Some(reason.clone()),
                &history_origin,
            )
            .await;
            return Err(DesktopDocumentReadError::Blocked(DesktopDocumentBlocked {
                reason,
                _scope: operation_scope,
            }));
        }
        self.operation
            .claim(operation_id)
            .await
            .map_err(DesktopDocumentReadError::Application)?;

        let lease = match operation_scope
            .connect(pin.clone(), ConnectionAccess::Read)
            .await
        {
            Ok(lease) => lease,
            Err(error) => {
                record_desktop_outcome(
                    &self.store,
                    &pin,
                    &query_text,
                    classification.kind,
                    "error",
                    "error",
                    None,
                    None,
                    Some(error.to_string()),
                    &history_origin,
                )
                .await;
                let _ = self
                    .operation
                    .fail(
                        operation_id,
                        &serde_json::json!({"reason": "connection_failed"}),
                    )
                    .await;
                return Err(DesktopDocumentReadError::Application(error));
            }
        };
        let mongo = match lease.live().mongo() {
            Ok(mongo) => mongo,
            Err(error) => {
                let _ = self
                    .operation
                    .fail(
                        operation_id,
                        &serde_json::json!({"reason": "document_backend_unavailable"}),
                    )
                    .await;
                return Err(DesktopDocumentReadError::Application(error));
            }
        };
        let max_rows = bounded_desktop_rows(settings.max_rows);
        let run = crate::mongo::query::run(
            mongo,
            &payload.query,
            max_rows,
            executor::cancel::QUERY_TIMEOUT,
        );
        match executor::cancel::guard(Some(operation_id), executor::cancel::QUERY_TIMEOUT, run)
            .await
        {
            Ok(page) => {
                self.operation
                    .succeed(
                        operation_id,
                        &serde_json::json!({
                            "durationMs": page.duration_ms,
                            "rowCount": page.doc_count,
                        }),
                    )
                    .await
                    .map_err(DesktopDocumentReadError::Application)?;
                record_desktop_outcome(
                    &self.store,
                    &pin,
                    &query_text,
                    QueryKind::Read,
                    "read",
                    "ok",
                    Some(page.doc_count as i64),
                    Some(page.duration_ms as i64),
                    None,
                    &history_origin,
                )
                .await;
                Ok(DocumentReadReceipt {
                    result: DocumentReadResult {
                        operation_id,
                        context: DocumentReadEventContext {
                            connection_id: pin.connection_id,
                            connection_name: pin.profile.name.clone(),
                            query_text,
                        },
                        query: payload.query,
                        page,
                    },
                    _lease: lease,
                })
            }
            Err(error) => {
                let cancelled = matches!(
                    &error,
                    AppError::Safety(reason) if reason == "query cancelled"
                );
                let _ = if cancelled {
                    self.operation
                        .confirm_cancelled(
                            operation_id,
                            &serde_json::json!({"reason": "user_cancelled"}),
                        )
                        .await
                } else {
                    self.operation
                        .fail(operation_id, &serde_json::json!({"reason": error.kind()}))
                        .await
                };
                record_desktop_outcome(
                    &self.store,
                    &pin,
                    &query_text,
                    QueryKind::Read,
                    "error",
                    "error",
                    None,
                    None,
                    Some(error.to_string()),
                    &history_origin,
                )
                .await;
                Err(DesktopDocumentReadError::Execution(Box::new(
                    DesktopDocumentExecutionFailure {
                        error,
                        _lease: lease,
                    },
                )))
            }
        }
    }
}
