// Query's public DTOs are generated from the Rust model/receipt contracts.  Keeping this
// module as the only frontend owner preserves existing imports without a hand-written mirror.
export type {
  Classification,
  PreviewMode,
  PreviewReport,
  RiskLevel,
} from "../../ipc/generated/model";
export type {
  SqlInspection,
  SqlOperationProposal,
} from "./generated/contracts";
