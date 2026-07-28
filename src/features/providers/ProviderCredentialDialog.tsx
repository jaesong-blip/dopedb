// Device-local provider binding wizard. The reducer owns the ephemeral secret and
// one-use receipt; query caches receive summaries only.
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Icon } from "../../components/Icon";
import Skeleton from "../../components/Skeleton";
import {
  Field,
  TextInput,
} from "../../design-system/components/FormControls";
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
  ProviderKind,
} from "./domain";

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

function statusTone(status: ProviderCredentialDialogStatus) {
  if (status === "ready") return "success";
  if (
    status === "scopeInsufficient" ||
    status === "unavailable" ||
    status === "deletionPending"
  ) {
    return "warning";
  }
  if (status === "credentialsRequired") return "neutral";
  return "danger";
}

function ProviderStatusBadge({
  status,
  children,
}: {
  status: ProviderCredentialDialogStatus;
  children: string;
}) {
  return (
    <span
      data-tone={statusTone(status)}
      className="badge tw:shrink-0 tw:data-[tone=danger]:border-danger tw:data-[tone=danger]:text-danger tw:data-[tone=success]:border-success tw:data-[tone=success]:text-success tw:data-[tone=warning]:border-warning tw:data-[tone=warning]:text-warning"
    >
      {children}
    </span>
  );
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
  initialProvider,
  onClose,
  returnFocus,
}: {
  initialProvider?: ProviderKind;
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

  useEffect(() => {
    if (!initialProvider || state.selectedIntegrationId) return;
    const matchingIntegration = integrations.data?.find(
      (integration) => integration.provider === initialProvider,
    );
    if (matchingIntegration) {
      dispatch({
        type: "select",
        integrationId: matchingIntegration.id,
      });
    }
  }, [initialProvider, integrations.data, state.selectedIntegrationId]);

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
    <div
      className="tw:fixed tw:inset-0 tw:z-[var(--ds-z-modal)] tw:grid tw:place-items-center tw:bg-overlay tw:p-4 tw:max-[560px]:items-end tw:max-[560px]:p-2"
      role="presentation"
      onMouseDown={close}
    >
      <section
        ref={dialogRef}
        className="ds-panel tw:max-h-[min(680px,calc(100dvh_-_var(--ds-space-8)))] tw:w-[min(560px,100%)] tw:overflow-auto tw:p-4 tw:shadow-popover tw:max-[560px]:max-h-[min(720px,calc(100dvh_-_var(--ds-space-4)))] tw:max-[560px]:p-3"
        role="dialog"
        aria-modal="true"
        aria-labelledby="provider-credential-title"
        aria-describedby="provider-credential-boundary"
        aria-busy={loading || pending !== null || revoking !== null}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="tw:flex tw:items-center tw:justify-between tw:gap-3">
          <div>
            <p className="tw:m-0 tw:text-2xs tw:font-bold tw:tracking-[0.05em] tw:text-muted-foreground tw:uppercase">
              {t("providerCredentials.memberLocal")}
            </p>
            <h2
              id="provider-credential-title"
              className="tw:m-0 tw:text-heading tw:tracking-[-0.01em]"
            >
              {t("providerCredentials.title")}
            </h2>
          </div>
          <button className="btn ghost small icon-only icon-xs" type="button" onClick={close} aria-label={t("common.close")}>
            <Icon name="close" />
          </button>
        </header>
        <p
          id="provider-credential-boundary"
          className="tw:mt-3 tw:mb-0 tw:text-sm tw:leading-[1.5] tw:text-muted-foreground"
        >
          {t("providerCredentials.localBoundary")}
        </p>

        {loading ? (
          <div className="tw:mt-4" aria-label={t("common.loading")}>
            <Skeleton lines={3} />
          </div>
        ) : null}
        {loadFailed ? (
          <div className="tw:mt-4 tw:flex tw:items-center tw:justify-between tw:gap-3 tw:rounded-sm tw:bg-danger-muted tw:p-2">
            <p
              className="tw:m-0 tw:text-sm tw:text-danger"
              role="alert"
            >
              {t("providerCredentials.error")}
            </p>
            <button
              className="btn small"
              type="button"
              onClick={() =>
                void Promise.all([
                  integrations.refetch(),
                  bindings.refetch(),
                ])
              }
            >
              {t("app.retry")}
            </button>
          </div>
        ) : null}
        {actionFailed ? (
          <p
            className="tw:mt-4 tw:mb-0 tw:rounded-sm tw:bg-danger-muted tw:p-2 tw:text-sm tw:text-danger"
            role="alert"
          >
            {t("providerCredentials.actionError")}
          </p>
        ) : null}
        {!loading && !loadFailed && integrations.data?.length === 0 ? (
          <p className="tw:mt-4 tw:mb-0 tw:rounded-sm tw:bg-background tw:p-2 tw:text-sm tw:text-muted-foreground">
            {t("providerCredentials.empty")}
          </p>
        ) : null}
        {!loading && !loadFailed && integrations.data && integrations.data.length > 0 ? (
          <>
            <div
              className="tw:mt-4 tw:border-t tw:border-border-subtle"
              aria-label={t("providerCredentials.select")}
            >
              <p className="tw:m-0 tw:px-0 tw:py-2 tw:text-2xs tw:font-bold tw:tracking-[0.05em] tw:text-muted-foreground tw:uppercase">
                {t("providerCredentials.select")}
              </p>
              {integrations.data.map((integration) => {
                const selected = integration.id === state.selectedIntegrationId;
                return (
                  <button
                    type="button"
                    key={integration.id}
                    className="tw:flex tw:min-h-control-xl tw:w-full tw:cursor-pointer tw:items-center tw:justify-between tw:gap-3 tw:border-0 tw:border-t tw:border-border-subtle tw:bg-transparent tw:p-2 tw:font-sans tw:text-left tw:text-foreground tw:aria-pressed:bg-selection tw:hover:bg-muted tw:focus-visible:outline-none tw:focus-visible:ring-2 tw:focus-visible:ring-ring"
                    onClick={() => {
                      setActionFailed(false);
                      dispatch({ type: "select", integrationId: integration.id });
                    }}
                    aria-pressed={selected}
                  >
                    <span className="tw:grid tw:min-w-0 tw:gap-[var(--ds-segment-gap)]">
                      <strong className="tw:text-sm">
                        {integration.displayName}
                      </strong>
                      <small className="tw:text-2xs tw:text-muted-foreground">
                        {integration.provider}
                      </small>
                    </span>
                    <ProviderStatusBadge status={integration.state}>
                      {t(statusKey[integration.state])}
                    </ProviderStatusBadge>
                  </button>
                );
              })}
            </div>

            {selectedIntegration ? (
              <div className="tw:mt-4 tw:grid tw:gap-3">
                <div className="tw:flex tw:items-center tw:gap-2 tw:border-l-2 tw:border-border-strong tw:bg-background tw:p-2">
                  <Icon name="info" className="tw:text-muted-foreground" />
                  <span className="tw:grid tw:min-w-0 tw:gap-[var(--ds-segment-gap)]">
                    <strong className="tw:text-sm">
                      {t("providerCredentials.memberLocal")}
                    </strong>
                    <small className="tw:text-2xs tw:text-muted-foreground">
                      {t("providerCredentials.managed")}
                    </small>
                  </span>
                </div>
                {selectedIntegration.provider === "neon" ? (
                  <Field
                    label={t("providerCredentials.apiKey")}
                    hint={
                      <small className="tw:font-normal">
                        {t("providerCredentials.apiKeyHint")}
                      </small>
                    }
                  >
                    <TextInput
                      autoComplete="off"
                      type="password"
                      value={state.apiKey}
                      onChange={(event) => dispatch({ type: "setApiKey", value: event.target.value })}
                      disabled={pending !== null}
                    />
                  </Field>
                ) : null}
                {selectedIntegration.provider === "gcpCloudSql" ? (
                  <p className="tw:m-0 tw:rounded-sm tw:bg-background tw:p-2 tw:text-sm tw:text-muted-foreground">
                    {t("providerCredentials.gcpHint")}
                  </p>
                ) : null}
                {selectedIntegration.provider === "planetScale" ? (
                  <p className="tw:m-0 tw:rounded-sm tw:bg-background tw:p-2 tw:text-sm tw:text-muted-foreground">
                    {t("providerCredentials.planetscaleHint")}
                  </p>
                ) : null}
                {visibleStatus ? (
                  <p
                    data-tone={statusTone(visibleStatus)}
                    className="tw:m-0 tw:rounded-sm tw:bg-background tw:p-2 tw:text-sm tw:data-[tone=danger]:bg-danger-muted tw:data-[tone=danger]:text-danger tw:data-[tone=success]:text-success tw:data-[tone=warning]:text-warning"
                    role={visibleStatus === "ready" ? "status" : "alert"}
                  >
                    {t("providerCredentials.status", { status: t(statusKey[visibleStatus]) })}
                  </p>
                ) : null}
                {state.phase === "complete" && state.status === "ready" ? (
                  <p className="tw:m-0 tw:rounded-sm tw:bg-background tw:p-2 tw:text-sm tw:text-success">
                    {t("providerCredentials.success")}
                  </p>
                ) : null}
                <div className="ds-control-row tw:flex tw:justify-end tw:gap-2 tw:[&_.primary]:min-w-[10ch] tw:max-[560px]:[&_.btn]:flex-1">
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

            <div className="tw:mt-4 tw:border-t tw:border-border-subtle">
              <p className="tw:m-0 tw:px-0 tw:py-2 tw:text-2xs tw:font-bold tw:tracking-[0.05em] tw:text-muted-foreground tw:uppercase">
                {t("providerCredentials.memberLocal")}
              </p>
              {bindings.data?.length ? bindings.data.map((binding) => (
                <div
                  className="tw:flex tw:min-h-control-xl tw:w-full tw:items-center tw:justify-between tw:gap-3 tw:border-t tw:border-border-subtle tw:bg-transparent tw:p-2"
                  key={binding.id}
                >
                  <span className="tw:grid tw:min-w-0 tw:gap-[var(--ds-segment-gap)]">
                    <strong className="tw:text-sm">{binding.provider}</strong>
                    <small className="tw:text-2xs tw:text-muted-foreground">
                      {t(statusKey[binding.state])}
                    </small>
                  </span>
                  <button className="btn ghost small" type="button" disabled={revoking !== null} onClick={() => void revoke(binding.id)}>
                    {revoking === binding.id ? t("providerCredentials.revokePending") : t("providerCredentials.revoke")}
                  </button>
                </div>
              )) : (
                <p className="tw:m-0 tw:rounded-sm tw:bg-background tw:p-2 tw:text-sm tw:text-muted-foreground">
                  {t("providerCredentials.noBindings")}
                </p>
              )}
            </div>
          </>
        ) : null}
      </section>
    </div>,
    document.body,
  );
}
