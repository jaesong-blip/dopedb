// Skill 인벤토리 fixture. 실제 홈 경로를 노출하지 않는 fixture 설치 경로를 쓴다.
import type { SkillStatus } from "../../../src/ipc/types";

const managedSummary = {
  name: "dopedb",
  releaseRevision: 7,
  appVersion: "0.2.0",
  packageDigest: "fixturedigest0000000000000000000000000000000000000000000000000001",
};

/** 두 target 모두 최신 관리 상태 — 설치 안내 배너가 뜨지 않는 기준 상태다. */
export const skillsUpToDate = {
  skill: managedSummary,
  targets: [
    {
      target: "codex",
      displayName: "Codex",
      installPath: "/fixture/home/.codex/skills/dopedb",
      state: "managed_current",
      repairable: false,
      currentRevision: 7,
      installedRevision: 7,
      installedPackageDigest: managedSummary.packageDigest,
      inventoryFingerprint: "fixture-fingerprint-codex-0001",
      reason: null,
      conflicts: [],
    },
    {
      target: "claude-code",
      displayName: "Claude Code",
      installPath: "/fixture/home/.claude/skills/dopedb",
      state: "managed_current",
      repairable: false,
      currentRevision: 7,
      installedRevision: 7,
      installedPackageDigest: managedSummary.packageDigest,
      inventoryFingerprint: "fixture-fingerprint-claude-0001",
      reason: null,
      conflicts: [],
    },
  ],
} satisfies SkillStatus;

/** 설치 안내가 필요한 상태. skill-setup 장면이 사용한다. */
export const skillsMissing = {
  skill: managedSummary,
  targets: [
    {
      target: "codex",
      displayName: "Codex",
      installPath: "/fixture/home/.codex/skills/dopedb",
      state: "missing",
      repairable: true,
      currentRevision: 7,
      installedRevision: null,
      installedPackageDigest: null,
      inventoryFingerprint: "fixture-fingerprint-codex-empty",
      reason: null,
      conflicts: [],
    },
    {
      target: "claude-code",
      displayName: "Claude Code",
      installPath: "/fixture/home/.claude/skills/dopedb",
      state: "missing",
      repairable: true,
      currentRevision: 7,
      installedRevision: null,
      installedPackageDigest: null,
      inventoryFingerprint: "fixture-fingerprint-claude-empty",
      reason: null,
      conflicts: [],
    },
  ],
} satisfies SkillStatus;
