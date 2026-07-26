//! Desktop SQL classification and impact-preview adapter operations.

use crate::connection::ensure_terminal_pin;
use crate::error::AppError;
use crate::kernel::TerminalAuthority;
use crate::model::QueryKind;
use crate::safety;

use super::super::domain::{DesktopSqlClassificationRequest, DesktopSqlPreviewRequest};
use super::desktop_contracts::{
    DesktopSqlClassificationReceipt, DesktopSqlInspectionError, DesktopSqlPreviewAuthority,
    DesktopSqlPreviewReceipt,
};
use super::desktop_support::{desktop_preview_connection_access, pool_ref, skipped_preview_report};
use super::platform::QueryPlatformAdapter;

impl QueryPlatformAdapter {
    /// Classify SQL against the engine from one scope-pinned connection. The
    /// returned receipt keeps that scope stable while the adapter serializes the
    /// legacy classification payload.
    pub(crate) async fn classify_desktop_sql(
        &self,
        request: DesktopSqlClassificationRequest,
    ) -> Result<DesktopSqlClassificationReceipt, DesktopSqlInspectionError> {
        let operation_scope = self.connections.begin_operation_scope().await;
        let pin = operation_scope
            .pin_connection_for_view(request.connection_id.into())
            .await
            .map_err(DesktopSqlInspectionError::Application)?;
        let classification = safety::classify(&request.sql, pin.profile.engine)
            .map_err(DesktopSqlInspectionError::Application)?;

        Ok(DesktopSqlClassificationReceipt {
            classification,
            _scope: operation_scope,
        })
    }

    /// Produce the desktop L3 impact preview from one authority snapshot.
    ///
    /// Pre-connection policy skips deliberately avoid opening a target pool.
    /// Database-backed previews consume the same operation scope that pinned the
    /// profile, closing the previous connection/profile re-acquisition window.
    pub(crate) async fn preview_desktop_sql(
        &self,
        request: DesktopSqlPreviewRequest,
    ) -> Result<DesktopSqlPreviewReceipt, DesktopSqlInspectionError> {
        self.preview_sql(request, None).await
    }

    pub(super) async fn preview_sql(
        &self,
        request: DesktopSqlPreviewRequest,
        terminal: Option<&TerminalAuthority>,
    ) -> Result<DesktopSqlPreviewReceipt, DesktopSqlInspectionError> {
        let operation_scope = self.connections.begin_operation_scope().await;
        let pin = operation_scope
            .pin_connection_for_view(request.connection_id.into())
            .await
            .map_err(DesktopSqlInspectionError::Application)?;
        if let Some(authority) = terminal {
            ensure_terminal_pin(authority, &pin).map_err(DesktopSqlInspectionError::Application)?;
        }
        let settings = self
            .store
            .get_safety(pin.connection_id)
            .await
            .map_err(DesktopSqlInspectionError::Application)?;
        let classification = safety::classify(&request.sql, pin.profile.engine)
            .map_err(DesktopSqlInspectionError::Application)?;
        let is_non_read = !matches!(classification.kind, QueryKind::Read);

        if !is_non_read && !pin.profile.workspace_access.can_read() {
            return Err(DesktopSqlInspectionError::Application(AppError::Blocked {
                reason: "workspace role cannot execute this connection".into(),
            }));
        }
        if is_non_read && !pin.profile.workspace_access.can_write() {
            return Ok(DesktopSqlPreviewReceipt {
                report: skipped_preview_report(
                    "workspace role is read-only — write preview skipped",
                ),
                pin,
                _authority: DesktopSqlPreviewAuthority::Scope {
                    _scope: operation_scope,
                },
            });
        }
        if is_non_read && !settings.allow_writes {
            return Ok(DesktopSqlPreviewReceipt {
                report: skipped_preview_report(
                    "writes are disabled for this connection — impact preview skipped (no rows locked)",
                ),
                pin,
                _authority: DesktopSqlPreviewAuthority::Scope {
                    _scope: operation_scope,
                },
            });
        }
        if matches!(classification.kind, QueryKind::Ddl | QueryKind::Privilege) {
            return Ok(DesktopSqlPreviewReceipt {
                report: skipped_preview_report(
                    "DDL / privilege change — no row-count preview; review the statement directly.",
                ),
                pin,
                _authority: DesktopSqlPreviewAuthority::Scope {
                    _scope: operation_scope,
                },
            });
        }

        let access = desktop_preview_connection_access(&classification, &settings);
        let lease = operation_scope
            .connect(pin.clone(), access)
            .await
            .map_err(DesktopSqlInspectionError::Application)?;
        let live = lease
            .live()
            .sql()
            .map_err(DesktopSqlInspectionError::Application)?;

        let report = safety::preview(
            pool_ref(live.ro()),
            &request.sql,
            &classification,
            &settings,
        )
        .await
        .map_err(DesktopSqlInspectionError::Application)?;

        Ok(DesktopSqlPreviewReceipt {
            report,
            pin,
            _authority: DesktopSqlPreviewAuthority::Lease {
                _lease: Box::new(lease),
            },
        })
    }
}
