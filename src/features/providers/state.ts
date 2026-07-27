import type {
  ProviderCredentialReceipt,
  ProviderCredentialDialogStatus,
  ProviderIntegrationId,
} from "./domain";

export type ProviderCredentialDialogState = Readonly<{
  selectedIntegrationId: ProviderIntegrationId | null;
  receipt: ProviderCredentialReceipt | null;
  apiKey: string;
  phase: "selecting" | "credentials" | "verifying" | "complete";
  status: ProviderCredentialDialogStatus | null;
}>;

export const initialProviderCredentialDialogState: ProviderCredentialDialogState = {
  selectedIntegrationId: null,
  receipt: null,
  apiKey: "",
  phase: "selecting",
  status: null,
};

export type ProviderCredentialDialogAction =
  | { type: "select"; integrationId: ProviderIntegrationId }
  | { type: "setApiKey"; value: string }
  | { type: "submit" }
  | { type: "receipt"; receipt: ProviderCredentialReceipt }
  | { type: "verified"; status: ProviderCredentialDialogStatus }
  | { type: "status"; status: ProviderCredentialDialogStatus }
  | { type: "discard" };

/** The dialog reducer is the only writer for ephemeral receipts and secret form text. */
export function providerCredentialDialogReducer(
  state: ProviderCredentialDialogState,
  action: ProviderCredentialDialogAction,
): ProviderCredentialDialogState {
  switch (action.type) {
    case "select":
      return {
        selectedIntegrationId: action.integrationId,
        receipt: null,
        apiKey: "",
        phase: "credentials",
        status: null,
      };
    case "setApiKey":
      return { ...state, apiKey: action.value };
    case "submit":
      // The command receives a local snapshot, but reducer state loses the secret
      // before the asynchronous Tauri invocation can settle.
      return { ...state, receipt: null, apiKey: "", phase: "verifying", status: null };
    case "receipt":
      return {
        ...state,
        receipt: action.receipt,
        // A successfully handed-off secret must never survive a render after begin.
        apiKey: "",
        phase: "verifying",
        status: null,
      };
    case "verified":
      return { ...state, receipt: null, apiKey: "", phase: "complete", status: action.status };
    case "status":
      return { ...state, receipt: null, apiKey: "", phase: "credentials", status: action.status };
    case "discard":
      return initialProviderCredentialDialogState;
  }
}
