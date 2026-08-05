import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { Icon } from "../../components/Icon";
import { useToast } from "../../components/Toast";
import { AgentProviderMark } from "../../design-system/components/Agent";
import { Button } from "../../design-system/components/Button";
import { CheckboxField } from "../../design-system/components/FormControls";
import {
  ModalBackdrop,
  ModalFooter,
  ModalSurface,
  ModalTitleBar,
} from "../../design-system/components/Modal";
import {
  LoadingLabel,
  StatusBadge,
} from "../../design-system/components/Status";
import { installSkill } from "../../ipc/commands";
import {
  errMessage,
  type SkillTarget,
  type SkillTargetStatus,
} from "../../ipc/types";
import { useI18n } from "../../lib/i18n";
import { skillStatusQuery } from "../../lib/queries";
import { usePostPaintReady } from "../../lib/usePostPaintReady";
import {
  hasSavedAgentTargets,
  loadAgentTargets,
  OPEN_AGENT_SETUP_EVENT,
  saveAgentTargets,
  SUPPORTED_AGENT_TARGETS,
} from "./agentPreferences";
import { skillStateLabel, skillStateTone } from "./presentation";
import {
  buildSkillSetupPlan,
  hasVerifiedSkillInstallation,
} from "./setupPolicy";

const manualReviewStates = new Set([
  "user_modified",
  "unknown_conflict",
  "invalid",
]);

export default function SkillStartupGate() {
  const { t } = useI18n();
  const toast = useToast();
  const postPaintReady = usePostPaintReady();
  const statusQuery = useQuery(skillStatusQuery(postPaintReady));
  const refetchStatus = statusQuery.refetch;
  const [selected, setSelected] = useState<SkillTarget[]>(loadAgentTargets);
  const [open, setOpen] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const automaticUpdates = useRef(new Set<string>());
  const dismissedAttention = useRef<string | null>(null);

  const statuses = statusQuery.data?.targets ?? [];
  const statusByTarget = useMemo(
    () => new Map(statuses.map((status) => [status.target, status])),
    [statuses],
  );
  const selectedStatuses = useMemo(() => {
    const selectedSet = new Set(selected);
    return statuses.filter((status) => selectedSet.has(status.target));
  }, [selected, statuses]);
  const setupPlan = useMemo(
    () => buildSkillSetupPlan(selectedStatuses),
    [selectedStatuses],
  );
  const startupAttentionFingerprint = useMemo(
    () =>
      selectedStatuses
        .filter(
          (status) =>
            status.state === "missing" || manualReviewStates.has(status.state),
        )
        .map((status) => `${status.target}:${status.inventoryFingerprint}`)
        .sort()
        .join("|"),
    [selectedStatuses],
  );
  const statusReady =
    statusQuery.data !== undefined &&
    statusQuery.error == null &&
    selectedStatuses.length === selected.length;

  useEffect(() => {
    if (!hasSavedAgentTargets()) setOpen(true);
  }, []);

  useEffect(() => {
    if (!statusQuery.isSuccess || startupAttentionFingerprint.length === 0) {
      return;
    }
    if (dismissedAttention.current === startupAttentionFingerprint) return;
    setOpen(true);
  }, [startupAttentionFingerprint, statusQuery.isSuccess]);

  useEffect(() => {
    const show = () => {
      dismissedAttention.current = null;
      setSelected(loadAgentTargets());
      setError(null);
      setOpen(true);
    };
    window.addEventListener(OPEN_AGENT_SETUP_EVENT, show);
    return () => window.removeEventListener(OPEN_AGENT_SETUP_EVENT, show);
  }, []);

  useEffect(() => {
    if (!hasSavedAgentTargets() || open || installing) return;
    const outdated = selectedStatuses.filter(
      (status) => status.state === "managed_older",
    );
    if (outdated.length === 0) return;
    let disposed = false;
    void (async () => {
      for (const status of outdated) {
        const attempt = `${status.target}:${status.inventoryFingerprint}`;
        if (automaticUpdates.current.has(attempt)) continue;
        automaticUpdates.current.add(attempt);
        try {
          const receipt = await installOne(status);
          if (!hasVerifiedSkillInstallation(receipt.status, [status.target])) {
            throw new Error(t("agentTools.startupVerificationFailed"));
          }
          if (!disposed) {
            toast(
              t("agentTools.autoUpdated", {
                target: status.displayName,
                revision: status.currentRevision,
              }),
            );
          }
        } catch (reason) {
          if (!disposed) {
            toast(
              t("agentTools.autoUpdateFailed", {
                target: status.displayName,
                error: errMessage(reason),
              }),
              "error",
            );
          }
        }
      }
      await refetchStatus();
    })();
    return () => {
      disposed = true;
    };
  }, [installing, open, refetchStatus, selectedStatuses, t, toast]);

  async function installOne(status: SkillTargetStatus) {
    return installSkill(status.target, [
      {
        target: status.target,
        inventoryFingerprint: status.inventoryFingerprint,
      },
    ]);
  }

  async function saveSelected() {
    if (selected.length === 0) {
      setError(t("agentTools.startupSelectOne"));
      return;
    }
    if (!statusReady || !statusQuery.data) {
      setError(
        t("agentTools.startupInstallFailed", {
          error: statusQuery.error
            ? errMessage(statusQuery.error)
            : t("agentTools.startupStatusUnavailable"),
        }),
      );
      return;
    }
    setError(null);
    setInstalling(true);
    try {
      let verifiedStatus = statusQuery.data;
      if (setupPlan.selection) {
        const targets = setupPlan.targets.map((status) => status.target);
        const receipt = await installSkill(
          setupPlan.selection,
          setupPlan.targets.map((status) => ({
            target: status.target,
            inventoryFingerprint: status.inventoryFingerprint,
          })),
        );
        if (!hasVerifiedSkillInstallation(receipt.status, targets)) {
          throw new Error(t("agentTools.startupVerificationFailed"));
        }

        const refreshed = await refetchStatus();
        if (
          !refreshed.data ||
          !hasVerifiedSkillInstallation(refreshed.data, targets)
        ) {
          throw new Error(t("agentTools.startupVerificationFailed"));
        }
        verifiedStatus = refreshed.data;
      }

      saveAgentTargets(selected);
      const selectedSet = new Set(selected);
      const reviewTargets = verifiedStatus.targets.filter(
        (status) =>
          selectedSet.has(status.target) && manualReviewStates.has(status.state),
      );
      if (reviewTargets.length > 0) {
        setError(
          t("agentTools.startupReviewRequired", {
            targets: reviewTargets
              .map((status) => status.displayName)
              .join(", "),
          }),
        );
        return;
      }

      setOpen(false);
    } catch (reason) {
      setError(
        t("agentTools.startupInstallFailed", {
          error: errMessage(reason),
        }),
      );
      await refetchStatus();
    } finally {
      setInstalling(false);
    }
  }

  function saveForLater() {
    if (installing) return;
    dismissedAttention.current = startupAttentionFingerprint || null;
    setError(null);
    setOpen(false);
  }

  function toggleTarget(target: SkillTarget, checked: boolean) {
    if (installing) return;
    setError(null);
    setSelected((current) =>
      checked
        ? [...new Set([...current, target])]
        : current.filter((candidate) => candidate !== target),
    );
  }

  if (!open) return null;

  const primaryLabel = installing
    ? t("agentTools.startupInstallingSelected")
    : setupPlan.targets.length > 0
      ? t("agentTools.startupInstallSelected")
      : t("agentTools.startupSaveSelected");
  const queryError = statusQuery.error
    ? t("agentTools.startupInstallFailed", {
        error: errMessage(statusQuery.error),
      })
    : null;

  return (
    <ModalBackdrop>
      <ModalSurface
        aria-labelledby="agent-startup-title"
        aria-describedby="agent-startup-description"
        aria-busy={installing}
      >
        <ModalTitleBar
          title={t("agentTools.startupTitle")}
          titleId="agent-startup-title"
          closeLabel={t("common.close")}
          onClose={saveForLater}
        />
        <div className="tw:min-h-0 tw:flex-1 tw:overflow-auto tw:px-5 tw:py-5">
          <div className="tw:flex tw:items-start tw:gap-3">
            <span className="tw:grid tw:size-9 tw:shrink-0 tw:place-items-center tw:rounded-md tw:bg-muted tw:text-foreground">
              <Icon name="shield" className="tw:size-5" />
            </span>
            <div className="tw:min-w-0">
              <h2 className="tw:m-0 tw:text-title tw:text-foreground">
                {t("agentTools.startupHeading")}
              </h2>
              <p
                id="agent-startup-description"
                className="tw:mt-1 tw:mb-0 tw:text-ui tw:leading-body tw:text-muted-foreground"
              >
                {t("agentTools.startupBody")}
              </p>
            </div>
          </div>

          <div className="tw:mt-5 tw:divide-y tw:divide-border-subtle tw:rounded-md tw:border tw:border-border-subtle">
            {SUPPORTED_AGENT_TARGETS.map((agent) => {
              const status = statusByTarget.get(agent.target);
              return (
                <div
                  key={agent.target}
                  className="tw:flex tw:min-h-14 tw:items-center tw:gap-3 tw:px-3 tw:py-2"
                >
                  <CheckboxField
                    checked={selected.includes(agent.target)}
                    disabled={installing}
                    onChange={(event) =>
                      toggleTarget(agent.target, event.target.checked)
                    }
                    label={
                      <span className="tw:flex tw:items-center tw:gap-2">
                        <AgentProviderMark provider={agent.provider} />
                        <strong>{agent.label}</strong>
                      </span>
                    }
                  />
                  <span className="tw:flex-1" />
                  {status ? (
                    <StatusBadge tone={skillStateTone(status.state)}>
                      {t(skillStateLabel[status.state])}
                    </StatusBadge>
                  ) : statusQuery.error ? (
                    <StatusBadge tone="danger">
                      {t("agentTools.startupStatusUnavailable")}
                    </StatusBadge>
                  ) : (
                    <LoadingLabel>{t("common.loading")}</LoadingLabel>
                  )}
                </div>
              );
            })}
          </div>

          <p className="tw:mt-4 tw:mb-0 tw:text-xs tw:leading-body tw:text-muted-foreground">
            {t("agentTools.startupSafety")}
          </p>
          {error || queryError ? (
            <p
              className="tw:mt-3 tw:mb-0 tw:text-ui tw:leading-body tw:text-danger"
              role="alert"
            >
              {error ?? queryError}
            </p>
          ) : null}
        </div>
        <ModalFooter>
          <Button variant="ghost" disabled={installing} onClick={saveForLater}>
            {t("agentTools.startupLater")}
          </Button>
          <Button
            variant="primary"
            disabled={selected.length === 0 || installing || !statusReady}
            onClick={() => void saveSelected()}
          >
            <Icon
              name={installing ? "refresh" : "check"}
              className={
                installing
                  ? "tw:animate-spin tw:motion-reduce:animate-none"
                  : undefined
              }
            />
            {primaryLabel}
          </Button>
        </ModalFooter>
      </ModalSurface>
    </ModalBackdrop>
  );
}
