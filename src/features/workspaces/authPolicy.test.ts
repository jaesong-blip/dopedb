import { describe, expect, it } from "vitest";
import capability from "../../../src-tauri/capabilities/default.json";
import {
  shouldRevalidateWorkspaceAuth,
  WORKSPACE_AUTH_RECHECK_MS,
} from "./authPolicy";

describe("workspace auth lifecycle", () => {
  it("keeps a recently verified signed-in state stable", () => {
    expect(shouldRevalidateWorkspaceAuth(true, 1_000, false, 1_000 + 60_000)).toBe(false);
  });

  it("revalidates a signed-in state after the cooldown", () => {
    expect(
      shouldRevalidateWorkspaceAuth(
        true,
        1_000,
        false,
        1_000 + WORKSPACE_AUTH_RECHECK_MS,
      ),
    ).toBe(true);
  });

  it("deduplicates checks and restricts external workspace auth URLs", () => {
    expect(shouldRevalidateWorkspaceAuth(true, 0, true, WORKSPACE_AUTH_RECHECK_MS)).toBe(false);
    expect(shouldRevalidateWorkspaceAuth(false, 0, false, WORKSPACE_AUTH_RECHECK_MS)).toBe(false);

    const opener = capability.permissions.find((permission) => (
      typeof permission !== "string" && permission.identifier === "opener:allow-open-url"
    ));
    const allowedUrls = typeof opener === "string"
      ? []
      : opener?.allow?.flatMap((entry) => entry.url ?? []) ?? [];
    expect(allowedUrls).toContain(
      "https://github.com/apps/dopedb-knowledge/installations/new?state=*",
    );
    expect(allowedUrls).not.toContain("https://github.com/*");
  });
});
