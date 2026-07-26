//! Desktop query port implementation backed by the local platform adapter.

use super::super::domain::{
    DesktopSqlClassificationRequest, DesktopSqlPreviewRequest, DesktopSqlProposalRequest,
    TerminalSqlProposalRequest,
};
use super::super::ports::DesktopQueryPort;
use super::desktop_contracts::{
    DesktopSqlClassificationReceipt, DesktopSqlInspectionError, DesktopSqlPreviewReceipt,
    DesktopSqlProposalReceipt, DesktopSqlRunError, DesktopSqlRunReceipt,
};
use super::platform::QueryPlatformAdapter;
use crate::kernel::identity::OperationId;

impl DesktopQueryPort for QueryPlatformAdapter {
    type ClassificationReceipt = DesktopSqlClassificationReceipt;
    type PreviewReceipt = DesktopSqlPreviewReceipt;
    type ProposalReceipt = DesktopSqlProposalReceipt;
    type RunReceipt = DesktopSqlRunReceipt;
    type InspectionError = DesktopSqlInspectionError;
    type RunError = DesktopSqlRunError;

    async fn classify_desktop_sql(
        &self,
        request: DesktopSqlClassificationRequest,
    ) -> Result<Self::ClassificationReceipt, Self::InspectionError> {
        QueryPlatformAdapter::classify_desktop_sql(self, request).await
    }

    async fn preview_desktop_sql(
        &self,
        request: DesktopSqlPreviewRequest,
    ) -> Result<Self::PreviewReceipt, Self::InspectionError> {
        QueryPlatformAdapter::preview_desktop_sql(self, request).await
    }

    async fn propose_desktop_sql(
        &self,
        request: DesktopSqlProposalRequest,
    ) -> Result<Self::ProposalReceipt, Self::InspectionError> {
        QueryPlatformAdapter::propose_desktop_sql(self, request).await
    }

    async fn propose_terminal_sql(
        &self,
        request: TerminalSqlProposalRequest,
    ) -> Result<Self::ProposalReceipt, Self::InspectionError> {
        QueryPlatformAdapter::propose_terminal_sql(self, request).await
    }

    async fn run_desktop_sql(
        &self,
        operation_id: OperationId,
    ) -> Result<Self::RunReceipt, Self::RunError> {
        QueryPlatformAdapter::run_desktop_sql(self, operation_id).await
    }
}
