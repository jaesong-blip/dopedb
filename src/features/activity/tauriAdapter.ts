import { invoke } from "../../ipc/core";
import type {
  AuditEntryDetail,
  AuditPage,
  AuditVerdict,
  HistoryEntryDetail,
  HistoryPage,
  HistoryPageRequest,
} from "../../ipc/types";

export function auditVerify(id: string): Promise<AuditVerdict> {
  return invoke("audit_verify", { connectionId: id });
}

export function listAuditPage(
  connectionId: string,
  cursor: { rowId: number } | null,
): Promise<AuditPage> {
  return invoke("list_audit_page", { request: { connectionId, cursor } });
}

export function getAuditEntry(
  connectionId: string,
  entryId: string,
): Promise<AuditEntryDetail> {
  return invoke("get_audit_entry", { connectionId, entryId });
}

export function listHistoryPage(request: HistoryPageRequest): Promise<HistoryPage> {
  return invoke("list_history_page", { request });
}

export function getHistoryEntry(
  connectionId: string,
  historyId: string,
): Promise<HistoryEntryDetail> {
  return invoke("get_history_entry", { connectionId, historyId });
}
