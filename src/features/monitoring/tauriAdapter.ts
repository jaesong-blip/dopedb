import { invoke } from "../../ipc/core";
import type {
  MonitoringOperationProposal,
  MonitoringStatus,
} from "../../ipc/types";

export function getMonitoringStatus(id: string): Promise<MonitoringStatus> {
  return invoke("get_monitoring_status", { id });
}

export function proposePostgresMonitoring(
  id: string,
  enabled: boolean,
): Promise<MonitoringOperationProposal> {
  return invoke("propose_postgres_monitoring", { id, enabled });
}

export function setPostgresMonitoring(
  operationId: string,
): Promise<MonitoringStatus> {
  return invoke("set_postgres_monitoring", { operationId });
}
