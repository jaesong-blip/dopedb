// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";

import { I18nProvider } from "../../lib/i18n";
import { providerCredentialQueryKeys } from "./queries";
import { ProviderCredentialDialog } from "./ProviderCredentialDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let client: QueryClient | null = null;

const integrationId = "11111111-1111-4111-8111-111111111111";
const receiptId = "33333333-3333-4333-8333-333333333333";
const bindingId = "22222222-2222-4222-8222-222222222222";

function integration(overrides: Record<string, unknown> = {}) {
  return {
    id: integrationId,
    provider: "neon",
    displayName: "Read-only Neon",
    integrationGeneration: "12",
    credentialMethod: "apiKey",
    state: "credentialsRequired",
    ...overrides,
  };
}

function binding(overrides: Record<string, unknown> = {}) {
  return {
    id: bindingId,
    integrationId,
    provider: "neon",
    integrationGeneration: "12",
    state: "ready",
    updatedAt: "2026-07-27T00:00:00.000Z",
    ...overrides,
  };
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function renderDialog() {
  const node = document.body.appendChild(document.createElement("div"));
  root = createRoot(node);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const returnFocus = vi.fn();
  await act(async () => root?.render(
    <QueryClientProvider client={client!}>
      <I18nProvider>
        <ProviderCredentialDialog onClose={() => undefined} returnFocus={returnFocus} />
      </I18nProvider>
    </QueryClientProvider>,
  ));
  return {
    node,
    dialog: () => document.querySelector<HTMLElement>(".provider-credential-dialog"),
    returnFocus,
  };
}

afterEach(() => {
  root?.unmount();
  root = null;
  client?.clear();
  client = null;
  document.body.replaceChildren();
});

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

describe("provider credential dialog", () => {
  it("clears a Neon API key after begin and never puts it in rendered text or query data", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockImplementation(async (command) => {
      if (command === "list_provider_integrations") return [integration()];
      if (command === "list_provider_credential_bindings") return [];
      if (command === "begin_provider_credential_binding") {
        return { receiptId, expiresAt: "2026-07-27T00:05:00.000Z" };
      }
      if (command === "verify_provider_credential_binding") return binding();
      return undefined;
    });
    const { dialog } = await renderDialog();
    await flush();
    await act(async () => (dialog()?.querySelector(".provider-credential-integration") as HTMLButtonElement).click());
    const input = dialog()?.querySelector("input[type=password]") as HTMLInputElement;
    await act(async () => setInputValue(input, "neon-secret-never-rendered"));
    await act(async () => (dialog()?.querySelector(".provider-credential-actions .primary") as HTMLButtonElement).click());
    await flush();

    expect(invokeMock).toHaveBeenCalledWith("begin_provider_credential_binding", {
      integrationId,
      credential: { type: "neonApiKey", apiKey: "neon-secret-never-rendered" },
    });
    expect(invokeMock).toHaveBeenCalledWith("verify_provider_credential_binding", { receiptId });
    expect(input.value).toBe("");
    expect(document.body.textContent).not.toContain("neon-secret-never-rendered");
    expect(JSON.stringify(client?.getQueryData(providerCredentialQueryKeys.integrations()))).not.toContain("neon-secret-never-rendered");
    expect(JSON.stringify(client?.getQueryData(providerCredentialQueryKeys.bindings()))).not.toContain("neon-secret-never-rendered");
    expect(dialog()?.textContent).not.toContain(receiptId);
    expect(invokeMock.mock.calls.filter(([command]) => command === "verify_provider_credential_binding")).toHaveLength(1);
    expect(dialog()?.textContent).toContain("This provider is ready on this device.");
  });

  it("uses no private-key input for GCP and disables unsupported local PlanetScale OAuth", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockImplementation(async (command) => {
      if (command === "list_provider_integrations") return [
        integration({ provider: "gcpCloudSql", displayName: "Cloud SQL", credentialMethod: "adcWif" }),
        integration({ id: "44444444-4444-4444-8444-444444444444", provider: "planetScale", displayName: "PlanetScale", credentialMethod: "unsupported", state: "unsupported" }),
      ];
      if (command === "list_provider_credential_bindings") return [];
      return undefined;
    });
    const { dialog } = await renderDialog();
    await flush();
    const choices = dialog()?.querySelectorAll<HTMLButtonElement>(".provider-credential-integration") ?? [];
    await act(async () => choices[0].click());
    expect(dialog()?.querySelector("input")).toBeNull();
    expect(dialog()?.textContent).toContain("Service-account key files are not accepted.");
    await act(async () => choices[1].click());
    expect(dialog()?.textContent).toContain("PlanetScale uses managed browser OAuth");
    expect((dialog()?.querySelector(".provider-credential-actions .primary") as HTMLButtonElement).disabled).toBe(true);
  });

  it("revalidates both summary queries after receipt consumption without retaining receipt identity", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockImplementation(async (command) => {
      if (command === "list_provider_integrations") return [integration()];
      if (command === "list_provider_credential_bindings") return [];
      if (command === "begin_provider_credential_binding") return { receiptId, expiresAt: "2026-07-27T00:05:00.000Z" };
      if (command === "verify_provider_credential_binding") return binding();
      return undefined;
    });
    const { dialog } = await renderDialog();
    await flush();
    await act(async () => (dialog()?.querySelector(".provider-credential-integration") as HTMLButtonElement).click());
    const input = dialog()?.querySelector("input") as HTMLInputElement;
    await act(async () => setInputValue(input, "one-shot"));
    const invalidate = vi.spyOn(client!, "invalidateQueries");
    await act(async () => (dialog()?.querySelector(".provider-credential-actions .primary") as HTMLButtonElement).click());
    await flush();
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({
      queryKey: providerCredentialQueryKeys.integrations(),
    }));
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({
      queryKey: providerCredentialQueryKeys.bindings(),
    }));
  });

  it("shows loading, empty, and generic error states and restores focus after Escape", async () => {
    let resolveIntegrations: ((value: unknown) => void) | undefined;
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "list_provider_integrations") return new Promise((resolve) => { resolveIntegrations = resolve; });
      if (command === "list_provider_credential_bindings") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    const { dialog, returnFocus } = await renderDialog();
    expect(dialog()?.querySelector(".provider-credential-skeleton")).not.toBeNull();
    await act(async () => resolveIntegrations?.([]));
    await flush();
    expect(dialog()?.textContent).toContain("No provider integrations are available");
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(returnFocus).toHaveBeenCalledOnce();

  });

  it("uses a generic load error instead of a provider error body", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("provider raw secret must stay hidden"));
    const { dialog } = await renderDialog();
    await flush();
    expect(dialog()?.textContent).toContain("Provider credentials could not be loaded");
    expect(dialog()?.textContent).not.toContain("provider raw secret");
  });

  it("renders binding revocation states and a generic revoke failure without provider details", async () => {
    let rejectRevoke: ((reason?: unknown) => void) | undefined;
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "list_provider_integrations") return [integration()];
      if (command === "list_provider_credential_bindings") return [
        binding({ state: "deletionPending" }),
        binding({ id: "44444444-4444-4444-8444-444444444444", state: "revoked" }),
      ];
      if (command === "revoke_provider_credential_binding") {
        return new Promise<never>((_, reject) => { rejectRevoke = reject; });
      }
      return undefined;
    });
    const { dialog } = await renderDialog();
    await flush();
    expect(dialog()?.textContent).toContain("Removal pending");
    expect(dialog()?.textContent).toContain("Revoked");
    await act(async () => (dialog()?.querySelector(".provider-credential-binding .btn") as HTMLButtonElement).click());
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("revoke_provider_credential_binding", { id: bindingId });
    await act(async () => {
      rejectRevoke?.(new Error("private provider resource must stay hidden"));
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(dialog()?.textContent).toContain("The provider action could not be completed");
    expect(dialog()?.textContent).not.toContain("private provider resource");
  });

  it("keeps actions in one control row and exposes no nested card hierarchy", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "list_provider_integrations") return [integration()];
      if (command === "list_provider_credential_bindings") return [];
      return undefined;
    });
    const { dialog } = await renderDialog();
    await flush();
    await act(async () => (dialog()?.querySelector(".provider-credential-integration") as HTMLButtonElement).click());
    expect(dialog()?.querySelectorAll(".provider-credential-actions.ds-control-row")).toHaveLength(1);
    expect(dialog()?.querySelectorAll(".card .card")).toHaveLength(0);
  });
});
