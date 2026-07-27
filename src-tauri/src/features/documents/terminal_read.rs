//! Terminal-scoped typed MongoDB read execution.

use super::*;

impl DocumentPlatformAdapter {
    /// Execute one typed read for a connection-pinned Terminal CLI session.
    pub(crate) async fn run_terminal_read(
        &self,
        request: TerminalDocumentReadRequest,
    ) -> Result<DocumentReadReceipt, AgentDocumentReadError> {
        let query_text = serde_json::to_string(&request.query)
            .map_err(AppError::from)
            .map_err(AgentDocumentReadError::Application)?;
        let authority = self
            .connections
            .pin(request.connection_id, ConnectionAccess::Read)
            .await
            .map_err(AgentDocumentReadError::Application)?;
        let pin = authority.pin().clone();
        ensure_terminal_pin(&request.authority, &pin)
            .map_err(AgentDocumentReadError::Application)?;
        let engine = pin.profile.engine;
        if !engine.is_document() {
            return Err(AgentDocumentReadError::NonDocumentConnection);
        }

        let event_context = DocumentReadEventContext {
            connection_id: pin.connection_id,
            connection_name: pin.profile.name.clone(),
            query_text: query_text.clone(),
        };
        let classification = crate::mongo::query::classify(&request.query);
        if !matches!(classification.kind, QueryKind::Read) {
            let message = classification
                .notes
                .first()
                .cloned()
                .unwrap_or_else(|| "document writes are not supported over CLI".into());
            audit_best_effort(
                &self.store,
                &pin,
                &event_context.query_text,
                classification.kind,
                "cli:run_document_query",
                None,
                Some(message.clone()),
            )
            .await;
            return Err(AgentDocumentReadError::Rejected(Box::new(
                RejectedAgentDocumentRead {
                    context: event_context,
                    message,
                    _authority: authority,
                },
            )));
        }

        let settings = self
            .store
            .get_safety(pin.connection_id)
            .await
            .map_err(AgentDocumentReadError::Application)?;
        let max_rows = bounded_agent_rows(request.max_rows, settings.max_rows);
        let policy =
            capture_policy(&pin, &settings).map_err(AgentDocumentReadError::Application)?;
        let operation_id = Uuid::new_v4();
        let expires_at = Utc::now()
            + ChronoDuration::from_std(QUERY_PLAN_TTL)
                .expect("document query plan TTL is representable by chrono");
        let mut actor = agent_actor_for_pin(&pin, "cli".into(), "cli".into());
        actor.provenance.client_protocol_version = Some(request.authority.client_protocol_version);
        let operation = self
            .operation
            .plan(
                NewOperation {
                    id: operation_id,
                    workspace_id: pin.scope.workspace_id,
                    account_scope: pin.scope.account_scope.storage_key().into(),
                    connection_id: pin.connection_id,
                    connection_revision: pin.connection_revision,
                    terminal_session_id: Some(request.authority.terminal_session_id.into()),
                    actor,
                    kind: OperationKind::DocumentRead,
                    payload_schema_version: 1,
                    payload: serde_json::to_value(StoredAgentDocumentPayload {
                        query: request.query,
                        query_text,
                        max_rows,
                    })
                    .map_err(AppError::from)
                    .map_err(AgentDocumentReadError::Application)?,
                    schema_fingerprint: None,
                    risk_level: document_operation_risk(&classification),
                    preview: serde_json::to_value(&classification)
                        .map_err(AppError::from)
                        .map_err(AgentDocumentReadError::Application)?,
                    policy_snapshot: policy.snapshot,
                    policy_revision: policy.revision,
                    single_use: true,
                    idempotency_key: operation_id.to_string(),
                    expires_at: Some(expires_at),
                },
                OperationPlanDisposition::Ready,
            )
            .await
            .map_err(AgentDocumentReadError::Application)?;
        self.operation
            .claim(operation_id)
            .await
            .map_err(AgentDocumentReadError::Application)?;
        let payload: StoredAgentDocumentPayload =
            match serde_json::from_value(operation.payload.clone()) {
                Ok(payload) => payload,
                Err(error) => {
                    let error = AppError::from(error);
                    let _ = self
                        .operation
                        .fail(
                            operation_id,
                            &serde_json::json!({
                                "error": error.to_string(),
                                "reason": "stored_document_payload_invalid",
                            }),
                        )
                        .await;
                    return Err(AgentDocumentReadError::Application(error));
                }
            };
        let canonical_query = match serde_json::to_string(&payload.query) {
            Ok(query) => query,
            Err(error) => {
                let error = AppError::from(error);
                let _ = self
                    .operation
                    .fail(
                        operation_id,
                        &serde_json::json!({
                            "error": error.to_string(),
                            "reason": "stored_document_payload_invalid",
                        }),
                    )
                    .await;
                return Err(AgentDocumentReadError::Application(error));
            }
        };
        if canonical_query != payload.query_text {
            let _ = self
                .operation
                .fail(
                    operation_id,
                    &serde_json::json!({"reason": "stored_document_event_mismatch"}),
                )
                .await;
            return Err(AgentDocumentReadError::Application(AppError::Blocked {
                reason: "stored document query does not match its canonical event payload".into(),
            }));
        }
        let lease = match authority.connect().await {
            Ok(lease) => lease,
            Err(error) => {
                let _ = self
                    .operation
                    .fail(
                        operation_id,
                        &serde_json::json!({
                            "error": error.to_string(),
                            "reason": "target_connection_failed",
                        }),
                    )
                    .await;
                return Err(AgentDocumentReadError::Application(error));
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
                return Err(AgentDocumentReadError::Application(error));
            }
        };
        let page = match crate::mongo::query::run(
            mongo,
            &payload.query,
            payload.max_rows.min(MAX_AGENT_ROWS),
            Duration::from_millis(safety::STATEMENT_TIMEOUT_MS),
        )
        .await
        {
            Ok(page) => page,
            Err(error) => {
                record_agent_execution(
                    &self.store,
                    &pin,
                    &event_context.query_text,
                    None,
                    None,
                    Some(error.to_string()),
                )
                .await;
                let _ = self
                    .operation
                    .fail(
                        operation_id,
                        &serde_json::json!({
                            "error": error.to_string(),
                            "reason": "document_read_failed",
                        }),
                    )
                    .await;
                return Err(AgentDocumentReadError::Execution(Box::new(
                    AgentDocumentExecutionFailure {
                        context: event_context,
                        error,
                        _lease: lease,
                    },
                )));
            }
        };

        record_agent_execution(
            &self.store,
            &pin,
            &event_context.query_text,
            Some(page.doc_count as i64),
            Some(page.duration_ms as i64),
            None,
        )
        .await;
        if let Err(error) = self
            .operation
            .succeed(
                operation_id,
                &serde_json::json!({
                    "durationMs": page.duration_ms,
                    "rowCount": page.doc_count,
                }),
            )
            .await
        {
            let _ = self
                .operation
                .fail(
                    operation_id,
                    &serde_json::json!({
                        "error": error.to_string(),
                        "reason": "operation_receipt_failed",
                    }),
                )
                .await;
            return Err(AgentDocumentReadError::Execution(Box::new(
                AgentDocumentExecutionFailure {
                    context: event_context,
                    error,
                    _lease: lease,
                },
            )));
        }
        Ok(DocumentReadReceipt {
            result: DocumentReadResult {
                operation_id,
                context: event_context,
                query: payload.query,
                page,
            },
            _lease: lease,
        })
    }
}
