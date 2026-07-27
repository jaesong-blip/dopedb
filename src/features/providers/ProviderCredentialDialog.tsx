// Device-local provider binding wizard. The reducer owns the ephemeral secret and
// one-use receipt; query caches receive summaries only.
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Icon } from "../../components/Icon";
import { useI18n } from "../../lib/i18n";
import {
  providerCredentialBindingsQuery,
  providerCredentialQueryKeys,
  providerIntegrationsQuery,
} from "./queries";
import {
  initialProviderCredentialDialogState,
  providerCredentialDialogReducer,
} from "./state";
import {
  beginProviderCredentialBinding,
  revokeProviderCredentialBinding,
  verifyProviderCredentialBinding,
} from "./tauriAdapter";
import type {
  ProviderCredentialDialogStatus,
  ProviderIntegrationSummary,
} from "./domain";
import "./ProviderCredentialDialog.css";

const statusKey: Record<ProviderCredentialDialogStatus, "providerCredentials.accessDenied" | "providerCredentials.credentialsRequired" | "providerCredentials.deletionPending" | "providerCredentials.ready" | "providerCredentials.revoked" | "providerCredentials.scopeInsufficient" | "providerCredentials.unavailable" | "providerCredentials.unsupported"> = {
  accessDenied: "providerCredentials.accessDenied",
  credentialsRequired: "providerCredentials.credentialsRequired",
  deletionPending: "providerCredentials.deletionPending",
  ready: "providerCredentials.ready",
  revoked: "providerCredentials.revoked",
  scopeInsufficient: "providerCredentials.scopeInsufficient",
  unavailable: "providerCredentials.unavailable",
  unsupported: "providerCredentials.unsupported",
};

function statusClass(status: ProviderCredentialDialogStatus) {
  if (status === "ready") return "status-ok";
  if (status === "scopeInsufficient" || status === "unavailable" || status === "deletionPending") return "risk-medium";
  if (status === "credentialsRequired") return "badge";
  return "status-blocked";
}

function supportsMemberLocal(integration: ProviderIntegrationSummary) {
  return integration.provider !== "planetScale" && integration.credentialMethod !== "unsupported";
}

function initialFocus(container: HTMLElement | null) {
  container?.querySelector<HTMLElement>(
    "button:not([disabled]), input:not([disabled]), select:not([disabled])",
  )?.focus();
}

export function ProviderCredentialDialog({
  onClose,
  returnFocus,
}: {
  onClose: () => void;
  returnFocus: () => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const integrations = useQuery(providerIntegrationsQuery());
  const bindings = useQuery(providerCredentialBindingsQuery());
  const [state, dispatch] = useReducer(
    providerCredentialDialogReducer,
    initialProviderCredentialDialogState,
  );
  const [pending, setPending] = useState<"begin" | "verify" | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [actionFailed, setActionFailed] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  const selectedIntegration = useMemo(
    () => integrations.data?.find((item) => item.id === state.selectedIntegrationId) ?? null,
    [integrations.data, state.selectedIntegrationId],
  );

  const close = () => {
    dispatch({ type: "discard" });
    onClose();
    window.requestAnimationFrame(returnFocus);
  };

  useEffect(() => {
    initialFocus(dialogRef.current);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), select:not([disabled])",
      ) ?? []);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      dispatch({ type: "discard" });
    };
  // The dialog closes over the current reducer, but this listener intentionally mounts once.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function verify(receipt: NonNullable<typeof state.receipt>) {
    setPending("verify");
    setActionFailed(false);
    try {
      const verified = await verifyProviderCredentialBinding({
        receiptId: receipt.receiptId,
      });
      dispatch({ type: "verified", status: verified.state });
      await queryClient.invalidateQueries({
        queryKey: providerCredentialQueryKeys.bindings(),
      });
      await queryClient.invalidateQueries({
        queryKey: providerCredentialQueryKeys.integrations(),
      });
    } catch {
      // Provider errors are deliberately not displayed: upstream descriptions can
      // include a credential, endpoint, or private provider resource name.
      dispatch({ type: "status", status: "unavailable" });
      setActionFailed(true);
    } finally {
      setPending(null);
    }
  }

  async function begin() {
    if (!selectedIntegration || pending) return;
    setActionFailed(false);
    if (!supportsMemberLocal(selectedIntegration)) {
      dispatch({ type: "status", status: "unsupported" });
      return;
    }
    if (selectedIntegration.provider === "neon" && !state.apiKey) {
      dispatch({ type: "status", status: "credentialsRequired" });
      return;
    }
    const credential = selectedIntegration.provider === "neon"
      ? { type: "neonApiKey" as const, apiKey: state.apiKey }
      : { type: "gcpAdc" as const };
    // Keep the one-shot value only in this local call frame; the reducer-owned
    // form state is cleared before the async desktop command begins.
    dispatch({ type: "submit" });
    setPending("begin");
    try {
      const receipt = await beginProviderCredentialBinding({
        integrationId: selectedIntegration.id,
        credential,
      });
      // Receipt and key are reducer-owned ephemeral values. The key clears before
      // a verification request or query-cache invalidation can occur.
      dispatch({ type: "receipt", receipt });
      await verify(receipt);
    } catch {
      dispatch({ type: "status", status: "unavailable" });
      setActionFailed(true);
      setPending(null);
    }
  }

  async function revoke(id: NonNullable<typeof bindings.data>[number]["id"]) {
    if (revoking) return;
    setRevoking(id);
    setActionFailed(false);
    try {
      await revokeProviderCredentialBinding(id);
      await queryClient.invalidateQueries({ queryKey: providerCredentialQueryKeys.bindings() });
    } catch {
      // Provider details can contain credential or resource identifiers, so this
      // local recovery state intentionally remains generic.
      setActionFailed(true);
    } finally {
      setRevoking(null);
    }
  }

  const loadFailed = integrations.isError || bindings.isError;
  // Only an empty first read gets a skeleton. Refetches retain their prior rows so
  // action controls never jump while the member-local inventory revalidates.
  const loading = !loadFailed && (integrations.data === undefined || bindings.data === undefined);
  const visibleStatus = state.status ?? selectedIntegration?.state ?? null;

  return createPortal(
    <div className="provider-credential-overlay" role="presentation" onMouseDown={close}>
      <section
        ref={dialogRef}
        className="provider-credential-dialog ds-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="provider-credential-title"
        aria-describedby="provider-credential-boundary"
        aria-busy={loading || pending !== null || revoking !== null}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="provider-credential-head">
          <div>
            <p className="provider-credential-kicker">{t("providerCredentials.memberLocal")}</p>
            <h2 id="provider-credential-title">{t("providerCredentials.title")}</h2>
          </div>
          <button className="btn ghost small icon-only icon-xs" type="button" onClick={close} aria-label={t("common.close")}>
            <Icon name="close" />
          </button>
        </header>
        <p id="provider-credential-boundary" className="provider-credential-boundary">
          {t("providerCredentials.localBoundary")}
        </p>

        {loading ? <div className="provider-credential-skeleton" aria-label={t("common.loading")}><span /><span /><span /></div> : null}
        {loadFailed ? <p className="provider-credential-error" role="alert">{t("providerCredentials.error")}</p> : null}
        {actionFailed ? <p className="provider-credential-error" role="alert">{t("providerCredentials.actionError")}</p> : null}
        {!loading && !loadFailed && integrations.data?.length === 0 ? (
          <p className="provider-credential-empty">{t("providerCredentials.empty")}</p>
        ) : null}
        {!loading && !loadFailed && integrations.data && integrations.data.length > 0 ? (
          <>
            <div className="provider-credential-selection" aria-label={t("providerCredentials.select")}>
              <p>{t("providerCredentials.select")}</p>
              {integrations.data.map((integration) => {
                const selected = integration.id === state.selectedIntegrationId;
                return (
                  <button
                    type="button"
                    key={integration.id}
                    className={`provider-credential-integration${selected ? " selected" : ""}`}
                    onClick={() => {
                      setActionFailed(false);
                      dispatch({ type: "select", integrationId: integration.id });
                    }}
                    aria-pressed={selected}
                  >
                    <span><strong>{integration.displayName}</strong><small>{integration.provider}</small></span>
                    <span className={`badge ${statusClass(integration.state)}`}>{t(statusKey[integration.state])}</span>
                  </button>
                );
              })}
            </div>

            {selectedIntegration ? (
              <div className="provider-credential-form">
                <div className="provider-credential-mode">
                  <Icon name="info" />
                  <span><strong>{t("providerCredentials.memberLocal")}</strong><small>{t("providerCredentials.managed")}</small></span>
                </div>
                {selectedIntegration.provider === "neon" ? (
                  <label>
                    <span>{t("providerCredentials.apiKey")}</span>
                    <input
                      autoComplete="off"
                      type="password"
                      value={state.apiKey}
                      onChange={(event) => dispatch({ type: "setApiKey", value: event.target.value })}
                      disabled={pending !== null}
                    />
                    <small>{t("providerCredentials.apiKeyHint")}</small>
                  </label>
                ) : null}
                {selectedIntegration.provider === "gcpCloudSql" ? (
                  <p className="provider-credential-hint">{t("providerCredentials.gcpHint")}</p>
                ) : null}
                {selectedIntegration.provider === "planetScale" ? (
                  <p className="provider-credential-hint">{t("providerCredentials.planetscaleHint")}</p>
                ) : null}
                {visibleStatus ? (
                  <p className={`provider-credential-status ${statusClass(visibleStatus)}`} role={visibleStatus === "ready" ? "status" : "alert"}>
                    {t("providerCredentials.status", { status: t(statusKey[visibleStatus]) })}
                  </p>
                ) : null}
                {state.phase === "complete" && state.status === "ready" ? <p className="provider-credential-success">{t("providerCredentials.success")}</p> : null}
                <div className="provider-credential-actions ds-control-row">
                  <button className="btn" type="button" onClick={close}>{t("common.close")}</button>
                  <button
                    className="btn primary"
                    type="button"
                    disabled={!supportsMemberLocal(selectedIntegration) || pending !== null}
                    onClick={() => void begin()}
                  >
                    {pending === "verify" ? t("providerCredentials.verifying") : t("providerCredentials.verify")}
                  </button>
                </div>
              </div>
            ) : null}

            <div className="provider-credential-bindings">
              <p>{t("providerCredentials.memberLocal")}</p>
              {bindings.data?.length ? bindings.data.map((binding) => (
                <div className="provider-credential-binding" key={binding.id}>
                  <span><strong>{binding.provider}</strong><small>{t(statusKey[binding.state])}</small></span>
                  <button className="btn ghost small" type="button" disabled={revoking !== null} onClick={() => void revoke(binding.id)}>
                    {revoking === binding.id ? t("providerCredentials.revokePending") : t("providerCredentials.revoke")}
                  </button>
                </div>
              )) : <p className="provider-credential-empty">{t("providerCredentials.noBindings")}</p>}
            </div>
          </>
        ) : null}
      </section>
    </div>,
    document.body,
  );
}
