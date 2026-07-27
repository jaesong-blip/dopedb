import { describe, expect, it } from "vitest";
import {
  canUseLocalProviderCredential,
  providerImportDisplayName,
  selectableProviderResources,
} from "./ProviderAccessPanel";

describe("provider discovery hierarchy selection", () => {
  const engines = ["postgres", "mysql"];

  it.each([
    ["PlanetScale", { id: "org", name: "org", value: "org", production: "unknown" as const }],
    ["Neon", { id: "project", name: "project", value: "project", ready: false, production: "unknown" as const }],
    ["Cloud SQL", { id: "instance", name: "instance", value: "instance", ready: false, production: "unknown" as const }],
  ])("keeps %s parent nodes selectable when status is unknown", (_provider, parent) => {
    expect(selectableProviderResources([parent], false, engines)).toEqual([parent]);
  });

  it("admits only a positively ready non-production final leaf", () => {
    const safe = { id: "safe", name: "safe", value: "safe", ready: true, production: false as const, kind: "postgres" as const };
    const unknown = { ...safe, id: "unknown", production: "unknown" as const };
    const production = { ...safe, id: "prod", production: true as const };
    const notReady = { ...safe, id: "sleeping", ready: false };
    expect(selectableProviderResources([safe, unknown, production, notReady], true, engines))
      .toEqual([safe]);
  });

  it("builds the bounded sanitized name used in the retry operation identity", () => {
    const name = providerImportDisplayName(
      "  Neon\n",
      `${"a".repeat(150)}\u0000ignored`,
    );
    expect(name).toHaveLength(120);
    expect(name).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(name.startsWith("Neon · ")).toBe(true);
  });

  it("offers the local credential handoff only for a canonical managed provider projection", () => {
    const managed = {
      integrationId: "integration-id",
      resource: { project: "project", branch: "main" },
    };
    expect(canUseLocalProviderCredential({ credentialMode: "managed" }, managed)).toBe(true);
    expect(canUseLocalProviderCredential({ credentialMode: "member_local" }, managed)).toBe(false);
    expect(canUseLocalProviderCredential({ credentialMode: "managed" }, {
      integrationId: "integration-id", resource: {},
    })).toBe(false);
    expect(canUseLocalProviderCredential({ credentialMode: "managed" }, null)).toBe(false);
  });
});
