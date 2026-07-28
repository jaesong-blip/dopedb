// Generated Query receipt contracts from src-tauri/src/features/queries/adapters/desktop_contracts.rs by ts-rs 12.0.1.
// Keep this checked-in wire contract synchronized with the Rust DTOs.

import type { Classification, PreviewReport } from "../../../ipc/generated/model";
import type { OperationState } from "../../../ipc/generated/protocol-contracts";

export type SqlInspection = { classification: Classification, report: PreviewReport, };
export type SqlOperationProposal = { operationId: string, payloadHash: string, state: OperationState, approvalRequired: boolean, autoRun: boolean, confirmationPhrase: string | null, expiresAt: string, classification: Classification, preview: PreviewReport, };
