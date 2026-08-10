import { describe, expect, it } from "vitest";
import type { SafetySettings } from "../../ipc/types";
import { effectiveSafetySettings } from "../safetySettings/policy";
import { buildRunSignal } from "./runSignal";

const safety: SafetySettings = {
  requireApproval: true,
  allowWrites: false,
  wrapWritesInTx: true,
  explainPreview: true,
  autoRunReads: true,
  maxRows: 500,
  execPreviewRowLimit: 50,
};

const t = (key: string, vars?: Record<string, string | number>) =>
  `${key}${vars ? `:${JSON.stringify(vars)}` : ""}`;

describe("SQL run guidance", () => {
  it("warns before a write when connection writes are disabled", () => {
    const requestedWrites = { ...safety, allowWrites: true };
    expect(
      effectiveSafetySettings(
        {
          allowWrites: false,
          credentialMode: "local",
          workspaceAccess: "local",
        },
        requestedWrites,
      ).allowWrites,
    ).toBe(false);
    expect(
      effectiveSafetySettings(
        {
          allowWrites: true,
          credentialMode: "memberLocal",
          workspaceAccess: "write",
        },
        requestedWrites,
      ).allowWrites,
    ).toBe(false);
    expect(
      effectiveSafetySettings(
        {
          allowWrites: true,
          credentialMode: "managed",
          workspaceAccess: "write",
        },
        requestedWrites,
      ).allowWrites,
    ).toBe(true);
    expect(buildRunSignal("UPDATE users SET active = 0", [], safety, t)).toEqual({
      tone: "warning",
      icon: "alert",
      text: "sql.signalNoWhere",
    });
    expect(
      buildRunSignal("UPDATE users SET active = 0 WHERE id = 1", [], safety, t),
    ).toEqual({
      tone: "danger",
      icon: "alert",
      text: "sql.signalWritesDisabled",
    });
    expect(
      buildRunSignal(
        "UPDATE users SET active = 0 WHERE id = 1",
        [],
        safety,
        t,
      ),
    ).toEqual({
      tone: "danger",
      icon: "alert",
      text: "sql.signalWritesDisabled",
    });
    expect(buildRunSignal(
      "UPDATE users SET active = 0 WHERE id = 1",
      [],
      { ...safety, allowWrites: true },
      t,
    )).toEqual({
      tone: "warning",
      icon: "alert",
      text: "sql.signalWriteStatement",
    });
  });

  it("describes a multi-statement read without granting execution", () => {
    expect(
      buildRunSignal(
        "SELECT 1; SELECT 2;",
        ["SELECT 1", "SELECT 2"],
        safety,
        t,
      ),
    ).toEqual({
      tone: "muted",
      icon: "info",
      text: 'sql.signalReadScript:{"count":2}',
    });
  });

  it("shows the enforced row cap for an unbounded read", () => {
    expect(buildRunSignal("SELECT * FROM users", [], safety, t)).toEqual({
      tone: "muted",
      icon: "info",
      text: 'sql.signalReadCap:{"count":500}',
    });
  });
});
