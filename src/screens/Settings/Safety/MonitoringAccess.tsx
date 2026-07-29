// Compact PostgreSQL monitoring-role control. The backend owns the fixed GRANT/REVOKE
// and Agent planning safety decision; this panel only exposes status, explicit confirmation, and
// a DBA-copy fallback without turning on arbitrary database writes.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  approveOperation,
  proposePostgresMonitoring,
  rejectOperation,
  setPostgresMonitoring,
} from "../../../ipc/commands";
import type { MonitoringOperationProposal } from "../../../ipc/types";
import { errMessage } from "../../../ipc/types";
import ConfirmButton from "../../../components/ConfirmButton";
import { Icon } from "../../../components/Icon";
import Skeleton from "../../../components/Skeleton";
import { useToast } from "../../../components/Toast";
import { monitoringStatusQuery, qk } from "../../../lib/queries";
import { useI18n } from "../../../lib/i18n";

const GRANT_SQL = "GRANT pg_monitor TO CURRENT_USER;";

export default function MonitoringAccess({ connectionId }: { connectionId: string }) {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const statusQuery = useQuery(monitoringStatusQuery(connectionId));
  const [proposal, setProposal] = useState<MonitoringOperationProposal | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const propose = useMutation({
    mutationFn: (enabled: boolean) => proposePostgresMonitoring(connectionId, enabled),
    onSuccess: (operation) => {
      setProposal(operation);
      setConfirmation("");
    },
    onError: (error) => toast(errMessage(error), "error"),
  });
  const apply = useMutation({
    mutationFn: async (operation: MonitoringOperationProposal) => {
      await approveOperation(
        operation.operationId,
        operation.payloadHash,
        operation.confirmationPhrase ? confirmation : undefined,
      );
      return setPostgresMonitoring(operation.operationId);
    },
    onSuccess: (status) => {
      setProposal(null);
      setConfirmation("");
      queryClient.setQueryData(qk.monitoring(connectionId), status);
      toast(status.roleGranted ? t("safety.monitoringEnabled") : t("safety.monitoringRevoked"));
    },
    onError: (error) => toast(errMessage(error), "error"),
  });
  const reject = useMutation({
    mutationFn: (operation: MonitoringOperationProposal) =>
      rejectOperation(operation.operationId, operation.payloadHash),
    onSuccess: () => {
      setProposal(null);
      setConfirmation("");
    },
    onError: (error) => toast(errMessage(error), "error"),
  });

  useEffect(() => {
    setProposal(null);
    setConfirmation("");
  }, [connectionId]);

  function copyGrant() {
    if (!navigator.clipboard?.writeText) {
      toast(t("safety.monitoringCopyFailed"), "error");
      return;
    }
    void navigator.clipboard.writeText(GRANT_SQL).then(
      () => toast(t("safety.monitoringCopied")),
      () => toast(t("safety.monitoringCopyFailed"), "error"),
    );
  }

  if (statusQuery.isPending) {
    return (
      <section className="ds-panel tw:mt-2 tw:grid tw:gap-3">
        <Skeleton lines={2} />
      </section>
    );
  }

  if (statusQuery.error || !statusQuery.data) {
    return (
      <section
        className="ds-panel tw:mt-2 tw:grid tw:gap-3 tw:border-danger"
        role="alert"
      >
        <div className="tw:flex tw:items-start tw:justify-between tw:gap-3 tw:max-[640px]:flex-col">
          <div className="ds-title-line">
            <Icon name="alert" />
            <h3>{t("safety.monitoringTitle")}</h3>
          </div>
        </div>
        <p className="tw:text-ui tw:text-danger">
          {t("safety.monitoringError", {
            error: statusQuery.error
              ? errMessage(statusQuery.error)
              : t("common.unknown"),
          })}
        </p>
      </section>
    );
  }

  const status = statusQuery.data;
  const postgres = status.engine === "postgres";
  const coverageLabel = status.roleGranted
    ? t("safety.monitoringCoverageFull")
    : status.coverage === "basic"
      ? t("safety.monitoringCoverageBasic")
      : t("safety.monitoringCoverageLimited");
  const coverageNote = status.roleGranted
    ? t("safety.monitoringFullHint")
    : status.coverage === "basic"
      ? t("safety.monitoringBasicHint")
      : t("safety.monitoringLimitedHint");
  const busy = propose.isPending || apply.isPending || reject.isPending;

  return (
    <section
      data-tone={status.roleGranted ? "trust" : "risk"}
      className="ds-panel tw:mt-2 tw:grid tw:gap-3 tw:data-[tone=risk]:border-warning tw:data-[tone=trust]:border-success"
    >
      <div className="tw:flex tw:items-start tw:justify-between tw:gap-3 tw:max-[640px]:flex-col">
        <div className="tw:min-w-0">
          <div className="ds-title-line">
            <Icon name="database" />
            <h3>{t("safety.monitoringTitle")}</h3>
          </div>
          <p className="tw:mt-1 tw:mb-0 tw:max-w-[680px] tw:text-ui tw:leading-relaxed tw:text-muted-foreground">
            {t("safety.monitoringBody")}
          </p>
        </div>
        <span
          data-granted={status.roleGranted}
          className="badge tw:data-[granted=false]:border-warning tw:data-[granted=false]:text-warning tw:data-[granted=true]:border-success tw:data-[granted=true]:text-success"
        >
          {coverageLabel}
        </span>
      </div>

      <div className="tw:grid tw:gap-1 tw:border-t tw:border-border-subtle tw:pt-2 tw:text-sm tw:leading-relaxed">
        {status.currentUser && (
          <span>
            {t("safety.monitoringUser")}{" "}
            <code className="tw:ml-1 tw:text-foreground">{status.currentUser}</code>
          </span>
        )}
        <span className="tw:text-muted-foreground">{coverageNote}</span>
        {postgres && !status.canManage && !status.roleGranted && (
          <span className="tw:text-muted-foreground">
            {t("safety.monitoringAdminHint")}
          </span>
        )}
      </div>

      {postgres && status.roleAvailable && !proposal && (
        <div className="ds-action-row ds-control-row tw:items-center">
          {status.roleGranted ? (
            <ConfirmButton
              className="btn danger small"
              disabled={busy}
              confirmLabel={t("safety.monitoringRevokeConfirm")}
              onConfirm={() => propose.mutate(false)}
            >
              {t("safety.monitoringRevoke")}
            </ConfirmButton>
          ) : (
            <ConfirmButton
              className="btn primary small"
              disabled={busy}
              confirmLabel={t("safety.monitoringEnableConfirm")}
              onConfirm={() => propose.mutate(true)}
            >
              {propose.isPending
                ? t("safety.monitoringWorking")
                : t("safety.monitoringEnable")}
            </ConfirmButton>
          )}
          {!status.roleGranted && (
            <button className="btn small" disabled={busy} onClick={copyGrant}>
              <Icon name="copy" />
              {t("safety.monitoringCopyGrant")}
            </button>
          )}
        </div>
      )}

      {proposal && (
        <div className="tw:grid tw:gap-2 tw:border-t tw:border-border-subtle tw:pt-3">
          <div className="ds-title-line">
            <Icon name="key" />
            <strong>
              {proposal.enabled
                ? t("safety.monitoringReviewGrant")
                : t("safety.monitoringReviewRevoke")}
            </strong>
            <span className="badge risk-high">{t("approval.riskHigh")}</span>
          </div>
          <code className="tw:block tw:overflow-x-auto tw:bg-muted tw:p-2 tw:text-sm tw:whitespace-nowrap tw:text-foreground">
            {proposal.sql};
          </code>
          <div className="tw:min-w-0 tw:text-xs tw:text-muted-foreground">
            {t("approval.payloadHash")}{" "}
            <code className="tw:break-all tw:text-foreground">
              {proposal.payloadHash}
            </code>
          </div>
          {proposal.confirmationPhrase && (
            <label className="tw:grid tw:gap-2 tw:text-sm">
              <span>
                {t("approval.confirmationPrompt")}{" "}
                <code>{proposal.confirmationPhrase}</code>
              </span>
              <input
                className="tw:w-full tw:max-w-[320px] tw:font-mono"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                placeholder={proposal.confirmationPhrase}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          )}
          <div className="ds-action-row ds-control-row">
            <button
              className="btn primary small"
              disabled={
                busy
                || (
                  !!proposal.confirmationPhrase
                  && confirmation !== proposal.confirmationPhrase
                )
              }
              onClick={() => apply.mutate(proposal)}
            >
              {apply.isPending
                ? t("safety.monitoringWorking")
                : t("safety.monitoringApproveApply")}
            </button>
            <button
              className="btn small"
              disabled={busy}
              onClick={() => reject.mutate(proposal)}
            >
              {t("approval.reject")}
            </button>
          </div>
        </div>
      )}

      {postgres && !status.roleAvailable && (
        <p className="tw:text-muted-foreground">
          {t("safety.monitoringRoleUnavailable")}
        </p>
      )}
    </section>
  );
}
