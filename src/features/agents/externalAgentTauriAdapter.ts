import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { invoke } from "../../ipc/core";
import type {
  ExternalAgentConfig,
  ExternalAgentRequestSummary,
} from "./externalAgentDomain";

export function listExternalAgentRequests(): Promise<
  ExternalAgentRequestSummary[]
> {
  return invoke("list_external_agent_requests");
}

export function respondExternalAgentRequest(
  id: string,
  approved: boolean,
  config: ExternalAgentConfig | null,
): Promise<void> {
  return invoke("respond_external_agent_request", { id, approved, config });
}

export function onExternalAgentRequested(
  listener: (request: ExternalAgentRequestSummary) => void,
): Promise<UnlistenFn> {
  return listen<ExternalAgentRequestSummary>(
    "external-agent:requested",
    (event) => listener(event.payload),
  );
}

export function onExternalAgentRequestFinished(
  listener: (requestId: string) => void,
): Promise<UnlistenFn> {
  return listen<string>("external-agent:finished", (event) =>
    listener(event.payload),
  );
}
