import type { ConnectionId } from "../connections/domain";
import type { AgentResourceScopeSelection } from "./domain";

export type ExternalAgentProvider = "codex" | "claude";

export interface ExternalAgentConfig {
  schemaVersion: 1;
  provider: ExternalAgentProvider;
  projectId: string;
  anchorConnectionId: ConnectionId;
  resourceScopes: AgentResourceScopeSelection[];
  writeConnectionId?: ConnectionId;
}

export interface ExternalAgentRequestSummary {
  id: string;
  kind: "configure" | "start";
  provider: ExternalAgentProvider;
  workingDirectory: string;
  config?: ExternalAgentConfig;
}

