// Contract tests for Neon API-key identity resolution. Project-scoped keys cannot
// call account endpoints, so the adapter must use the supported organization path.
import { afterEach, describe, expect, it, vi } from "vitest";
import { neonIntegrationIdentity } from "./neon-core";
import { inspectNeonCredential, listNeonBranches, validateNeonResource } from "./neon";

vi.mock("server-only", () => ({}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Neon API identity", () => {
  it("supports a project-scoped key without the removed /auth endpoint", async () => {
    const paths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (url.pathname === "/api/v2/projects") {
        return Response.json({
          projects: [{ id: "quiet-field-123", name: "Production" }],
        });
      }
      if (url.pathname === "/api/v2/users/me") {
        return Response.json({ error: "project scoped" }, { status: 403 });
      }
      if (url.pathname === "/api/v2/users/me/organizations") {
        return Response.json({
          organizations: [{ id: "org-safe-123", name: "Safe" }],
        });
      }
      return Response.json({ error: "unexpected" }, { status: 404 });
    }));

    const info = await inspectNeonCredential({
      apiKey: "napi_".padEnd(64, "a"),
      organizationId: null,
    });
    expect(info.externalAccountId).toBe(
      neonIntegrationIdentity(
        { kind: "organization", id: "org-safe-123" },
        ["quiet-field-123"],
      ).externalAccountId,
    );
    expect(paths).toContain("/api/v2/users/me");
    expect(paths).toContain("/api/v2/users/me/organizations");
    expect(paths).not.toContain("/api/v2/auth");
  });

  it("maps a revoked Neon key away from workspace-session 401", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => (
      Response.json({ error: "revoked" }, { status: 401 })
    )));
    await expect(inspectNeonCredential({
      apiKey: "napi_".padEnd(64, "b"),
      organizationId: null,
    })).rejects.toMatchObject({
      provider: "neon",
      status: 424,
    });
  });

  it("fails closed instead of accepting an unbounded provider branch page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      branches: Array.from({ length: 201 }, (_, index) => ({
        id: `branch-${index}`, name: `branch-${index}`, current_state: "ready",
      })),
    })));

    await expect(listNeonBranches({
      apiKey: "napi_".padEnd(64, "c"), organizationId: null,
    }, "project-safe")).rejects.toMatchObject({ provider: "neon", status: 409 });
  });

  it("rechecks an exact branch and denies a default/protected production target before a credential path", async () => {
    const paths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (url.pathname === "/api/v2/projects") {
        return Response.json({ projects: [{ id: "project-safe", name: "Safe" }] });
      }
      if (url.pathname === "/api/v2/projects/project-safe/branches") {
        return Response.json({ branches: [{
          id: "branch-prod", name: "main", default: true, protected: true, current_state: "ready",
        }] });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    }));

    await expect(validateNeonResource({
      apiKey: "napi_".padEnd(64, "d"), organizationId: null,
    }, {
      project: "project-safe", branch: "branch-prod", database: "app", engine: "postgres", schemas: ["public"],
    })).rejects.toMatchObject({ provider: "neon", status: 409 });
    expect(paths).not.toContain("/api/v2/projects/project-safe/branches/branch-prod/databases");
  });
});
