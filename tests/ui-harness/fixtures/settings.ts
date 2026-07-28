// Settings가 읽는 Agent CLI와 retired MCP cleanup 상태. 경로와 사용자는 모두
// fixture namespace이며 command 실행 없이 read-only settings surface만 만든다.
import type { AgentCliInfo } from "../../../src/features/agents/domain";
import type { LegacyMcpCleanupStatus } from "../../../src/ipc/types";

export const detectedAgentClis = [
  {
    id: "codex",
    name: "Codex",
    installed: true,
    authenticated: true,
    authMethod: "fixture-session",
    note: "Fixture CLI ready",
  },
  {
    id: "claude",
    name: "Claude Code",
    installed: true,
    authenticated: false,
    authMethod: null,
    note: "Fixture CLI requires local authentication",
  },
] satisfies AgentCliInfo[];

export const legacyCleanupAbsent = {
  targets: [
    {
      id: "fixture-codex-mcp",
      displayName: "Codex legacy MCP",
      path: "/fixture/home/.codex/legacy-mcp.json",
      state: "absent",
      fingerprint: null,
      redactedDiff: null,
      reason: null,
    },
    {
      id: "fixture-claude-mcp",
      displayName: "Claude legacy MCP",
      path: "/fixture/home/.claude/legacy-mcp.json",
      state: "absent",
      fingerprint: null,
      redactedDiff: null,
      reason: null,
    },
  ],
} satisfies LegacyMcpCleanupStatus;
