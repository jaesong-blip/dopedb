import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { listPlanetScaleBranches, validatePlanetScaleResource } from "./planetscale";
import { allowDiscoveryImport } from "./import-projection";

afterEach(() => vi.unstubAllGlobals());

describe("PlanetScale branch readiness", () => {
  it.each([undefined, "ready", false])("fails closed for missing or non-boolean readiness %p", async (ready) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      data: [{ id: "branch-id", name: "dev", production: false, ...(ready === undefined ? {} : { ready }) }],
    })));
    const [branch] = await listPlanetScaleBranches("test-access-token", "team", "app");
    expect(branch).toMatchObject({ production: false, ready: false });
    expect(allowDiscoveryImport(branch!)).toBe(false);
  });

  it("permits a receipt candidate only for explicit ready true and production false", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      data: [{ id: "branch-id", name: "dev", production: false, ready: true, state: "ready", schema_ready: true }],
    })));
    const [branch] = await listPlanetScaleBranches("test-access-token", "team", "app");
    expect(allowDiscoveryImport(branch!)).toBe(true);
  });

  it("rechecks the exact branch and blocks a target promoted after discovery", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/databases")) {
        return Response.json({ data: [{ id: "db-id", name: "app", kind: "postgres" }] });
      }
      return Response.json({ data: {
        id: "branch-id", name: "dev", kind: "postgres", production: true,
        state: "ready", ready: true, schema_ready: true,
      } });
    }));
    await expect(validatePlanetScaleResource("test-access-token", {
      organization: "team", database: "app", branch: "dev", engine: "postgres",
    })).rejects.toMatchObject({ provider: "planetScale", status: 409 });
  });
});
