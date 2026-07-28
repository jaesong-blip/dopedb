import { describe, expect, it } from "vitest";

import type {
  SkillInstallState,
  SkillTarget,
} from "../../ipc/generated/protocol-contracts";
import {
  buildSkillSetupPlan,
  type SkillSetupTargetStatus,
} from "./setupPolicy";

const states: SkillInstallState[] = [
  "missing",
  "managed_current",
  "managed_older",
  "newer_known",
  "user_modified",
  "unknown_conflict",
  "invalid",
];

function target(
  id: SkillTarget,
  state: SkillInstallState,
): SkillSetupTargetStatus {
  return {
    target: id,
    displayName: id === "codex" ? "Codex" : "Claude Code",
    state,
    currentRevision: 12,
    installedRevision: state === "missing" ? null : 11,
  };
}

describe("buildSkillSetupPlan", () => {
  it.each(states.flatMap((codex) => states.map((claude) => [codex, claude])))(
    "maps codex=%s and claude=%s without targeting protected copies",
    (codex, claude) => {
      const plan = buildSkillSetupPlan([
        target("codex", codex),
        target("claude-code", claude),
      ]);
      const actionable = [
        ["codex", codex],
        ["claude-code", claude],
      ].filter(([, state]) => state === "missing" || state === "managed_older");

      if (actionable.length === 0) {
        expect(plan.command).toBeNull();
        expect(plan.selection).toBeNull();
        expect(plan.action).toBe(
          codex === "managed_current" && claude === "managed_current"
            ? "none"
            : "attention",
        );
        return;
      }

      const expectedSelection =
        actionable.length === 2 ? "all" : actionable[0][0];
      expect(plan.selection).toBe(expectedSelection);
      expect(plan.command).toBe(
        `dopedb skill install --target ${expectedSelection}`,
      );
      expect(plan.command).not.toMatch(/[\r\n]/);
      expect(
        plan.targets.every(
          (item) =>
            item.state === "missing" || item.state === "managed_older",
        ),
      ).toBe(true);
      expect(
        plan.attentionTargets.every(
          (item) =>
            item.state !== "missing" &&
            item.state !== "managed_current" &&
            item.state !== "managed_older",
        ),
      ).toBe(true);
    },
  );

  it("distinguishes install, update, and mixed work", () => {
    expect(
      buildSkillSetupPlan([target("codex", "missing")]).action,
    ).toBe("install");
    expect(
      buildSkillSetupPlan([target("codex", "managed_older")]).action,
    ).toBe("update");
    expect(
      buildSkillSetupPlan([
        target("codex", "missing"),
        target("claude-code", "managed_older"),
      ]).action,
    ).toBe("install-and-update");
  });

  it("does not downgrade a newer copy while installing the other target", () => {
    const plan = buildSkillSetupPlan([
      target("codex", "newer_known"),
      target("claude-code", "missing"),
    ]);

    expect(plan.selection).toBe("claude-code");
    expect(plan.command).toBe(
      "dopedb skill install --target claude-code",
    );
    expect(plan.attentionTargets.map((item) => item.target)).toEqual([
      "codex",
    ]);
  });
});
