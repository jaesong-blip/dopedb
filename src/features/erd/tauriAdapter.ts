import { invoke } from "../../ipc/core";

import type { ConnectionId } from "../connections/domain";
import type {
  ErdLayout,
  ErdLayoutId,
  SaveErdLayoutOutcome,
  SaveErdLayoutRequest,
} from "./domain";

export function listErdLayouts(id: ConnectionId): Promise<ErdLayout[]> {
  return invoke("list_erd_layouts", { id });
}

export function saveErdLayout(
  request: SaveErdLayoutRequest,
): Promise<SaveErdLayoutOutcome> {
  return invoke("save_erd_layout", { request });
}

export function deleteErdLayout(
  connectionId: ConnectionId,
  id: ErdLayoutId,
  expectedRevision: number,
): Promise<void> {
  return invoke("delete_erd_layout", {
    connectionId,
    id,
    expectedRevision,
  });
}
