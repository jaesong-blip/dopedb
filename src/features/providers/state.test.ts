import { describe, expect, it } from "vitest";

import { providerCredentialReceiptId, providerIntegrationId } from "./domain";
import {
  initialProviderCredentialDialogState,
  providerCredentialDialogReducer,
} from "./state";

describe("provider credential dialog reducer", () => {
  it("drops the one-shot API key before the asynchronous begin command can resolve", () => {
    const selected = providerCredentialDialogReducer(initialProviderCredentialDialogState, {
      type: "select",
      integrationId: providerIntegrationId("11111111-1111-4111-8111-111111111111"),
    });
    const withSecret = providerCredentialDialogReducer(selected, {
      type: "setApiKey",
      value: "never-persist-this",
    });
    const submitted = providerCredentialDialogReducer(withSecret, { type: "submit" });
    expect(submitted.apiKey).toBe("");
    expect(JSON.stringify(submitted)).not.toContain("never-persist-this");

    const staged = providerCredentialDialogReducer(submitted, {
      type: "receipt",
      receipt: {
        receiptId: providerCredentialReceiptId("33333333-3333-4333-8333-333333333333"),
        expiresAt: "2026-07-27T00:05:00.000Z",
      },
    });

    expect(staged.apiKey).toBe("");
    expect(JSON.stringify(staged)).not.toContain("never-persist-this");
  });
});
