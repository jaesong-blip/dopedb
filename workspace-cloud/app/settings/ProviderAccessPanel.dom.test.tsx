// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderAccessPanel } from "./ProviderAccessPanel";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const integrationId = "22222222-2222-4222-8222-222222222222";
const receipt = "33333333-3333-4333-8333-333333333333";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await settle();
  }
  throw new Error("Timed out waiting for ProviderAccessPanel state");
}

async function selectValue(element: HTMLSelectElement, value: string) {
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}

describe("ProviderAccessPanel import retry identity", () => {
  let container: HTMLDivElement;
  let root: Root;
  let importBodies: string[];
  let resourcePostBodies: string[];
  let resourceGetUrls: string[];

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    importBodies = [];
    resourcePostBodies = [];
    resourceGetUrls = [];
    let importAttempt = 0;
    vi.stubGlobal("fetch", vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith(`/workspaces/${workspaceId}/provider-integrations`) && method === "GET") {
        return json({
          providers: [{
            id: "neon",
            name: "Neon",
            availability: "available",
            configured: true,
            note: "test",
            leaseSeconds: 900,
            setupKind: "apiKey",
            supportedEngines: ["postgres"],
            resourceLevels: [
              { key: "project", kind: "projects", label: "프로젝트" },
              { key: "branch", kind: "branches", label: "브랜치" },
              { key: "database", kind: "databases", label: "DB" },
            ],
          }],
          integrations: [{
            id: integrationId,
            provider: "neon",
            status: "active",
            generation: "7",
            displayName: "Neon test",
            grantedScope: "projects:1",
            updatedAt: "2026-07-27T00:00:00.000Z",
            credentialMode: "managed",
          }],
          managedConnections: [],
        });
      }
      if (url.endsWith(`/workspaces/${workspaceId}/connections`) && method === "GET") {
        return json({ connections: [] });
      }
      if (url.includes(`/${integrationId}/resources?`) && method === "GET") {
        resourceGetUrls.push(url);
        const kind = new URL(url, "https://app.example").searchParams.get("kind");
        if (kind === "projects") {
          return json({ resources: [{
            id: "project-id",
            name: "Project",
            value: "project",
            production: "unknown",
          }] });
        }
        if (kind === "branches") {
          return json({ resources: [{
            id: "branch-id",
            name: "Branch",
            value: "branch",
            production: false,
            ready: true,
          }] });
        }
        return json({ resources: [{
          id: "database-id",
          name: "App Database",
          value: "app",
          kind: "postgres",
          production: false,
          ready: true,
          selectionProof: "opaque-selection-proof",
        }] });
      }
      if (url.endsWith(`/${integrationId}/resources`) && method === "POST") {
        resourcePostBodies.push(String(init?.body));
        return json({
          receipt,
          receiptExpiresAt: new Date(Date.now() + 4 * 60_000).toISOString(),
        });
      }
      if (url.endsWith(`/${integrationId}/imports`) && method === "POST") {
        importBodies.push(String(init?.body));
        importAttempt += 1;
        if (importAttempt === 1) throw new TypeError("network response lost");
        return json({ connection: { id: "connection-id" } }, 201);
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT;
  });

  it("re-clicks with the exact same serialized payload and idempotency key after a lost response", async () => {
    await act(async () => {
      root.render(<ProviderAccessPanel workspaceId={workspaceId} />);
    });
    await waitFor(() => (
      container.querySelectorAll(".managed-resource-row select").length === 3
      && (container.querySelector(
        ".managed-resource-row select",
      ) as HTMLSelectElement | null)?.options.length === 2
    ));

    const selects = () => (
      [...container.querySelectorAll<HTMLSelectElement>(
        ".managed-resource-row select",
      )]
    );
    await selectValue(selects()[0]!, "project");
    await waitFor(() => selects()[1]!.options.length === 2);
    await selectValue(selects()[1]!, "branch");
    await waitFor(() => selects()[2]!.options.length === 2);
    await selectValue(selects()[2]!, "app");

    const importButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("읽기 전용 연결 가져오기"))!;
    expect(importButton.disabled).toBe(false);
    await act(async () => importButton.click());
    await waitFor(() => importBodies.length === 1 && !importButton.disabled);
    await act(async () => importButton.click());
    await waitFor(() => importBodies.length === 2);

    expect(resourcePostBodies).toEqual([
      JSON.stringify({ selectionProof: "opaque-selection-proof" }),
    ]);
    expect(resourceGetUrls.every((url) => !new URL(
      url,
      "https://app.example",
    ).searchParams.has("engine"))).toBe(true);
    expect(importBodies[1]).toBe(importBodies[0]);
    const payload = JSON.parse(importBodies[0]!) as Record<string, unknown>;
    expect(payload).toEqual({
      receipt,
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      name: "Neon · App Database",
    });
  });
});
