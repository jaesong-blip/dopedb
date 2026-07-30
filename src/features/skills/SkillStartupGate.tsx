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
  StatusBadge,
  type StatusTone,
} from "../../design-system/components/Status";
import { installSkill } from "../../ipc/commands";
import {
  errMessage,
  type SkillInstallState,
  type SkillTarget,
  type SkillTargetStatus,
} from "../../ipc/types";
import { useI18n, type I18nKey } from "../../lib/i18n";
import { skillStatusQuery } from "../../lib/queries";
import {
  hasSavedAgentTargets,
  loadAgentTargets,
  OPEN_AGENT_SETUP_EVENT,
  saveAgentTargets,
  SUPPORTED_AGENT_TARGETS,
} from "./agentPreferences";

const stateLabel: Record<SkillInstallState, I18nKey> = {
  missing: "agentTools.stateMissing",
  managed_current: "agentTools.stateManagedCurrent",
  managed_older: "agentTools.stateManagedOlder",
  user_modified: "agentTools.stateUserModified",
  newer_known: "agentTools.stateNewerKnown",
  unknown_conflict: "agentTools.stateUnknownConflict",
  invalid: "agentTools.stateInvalid",
};

export default function SkillStartupGate() {
  const { t } = useI18n();
  const toast = useToast();
  const statusQuery = useQuery(skillStatusQuery());
  const refetchStatus = statusQuery.refetch;
  const [selected, setSelected] = useState<SkillTarget[]>(loadAgentTargets);
  const [open, setOpen] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const promptedInventories = useRef(new Set<string>());
  const automaticUpdates = useRef(new Set<string>());

  const statuses = statusQuery.data?.targets ?? [];
  const selectedStatuses = useMemo(() => {
    const selectedSet = new Set(selected);
    return statuses.filter((status) => selectedSet.has(status.target));
  }, [selected, statuses]);

  useEffect(() => {
    const show = () => {
      setSelected(loadAgentTargets());
      setError(null);
      setOpen(true);
    };
    window.addEventListener(OPEN_AGENT_SETUP_EVENT, show);
    return () => window.removeEventListener(OPEN_AGENT_SETUP_EVENT, show);
  }, []);

  useEffect(() => {
    if (!statusQuery.data) return;
    const requiresChoice =
      !hasSavedAgentTargets() ||
      selectedStatuses.some((status) =>
        ["missing", "user_modified", "unknown_conflict", "invalid"].includes(
          status.state,
        ),
      );
    if (!requiresChoice) return;
    const fingerprint = selectedStatuses
      .map((status) => `${status.target}:${status.inventoryFingerprint}`)
      .join("|");
    if (promptedInventories.current.has(fingerprint)) return;
    promptedInventories.current.add(fingerprint);
    setOpen(true);
  }, [selectedStatuses, statusQuery.data]);

  useEffect(() => {
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
          await installOne(status);
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
            setError(
              t("agentTools.autoUpdateFailed", {
                target: status.displayName,
                error: errMessage(reason),
              }),
            );
            setOpen(true);
          }
        }
      }
      await refetchStatus();
    })();
    return () => {
      disposed = true;
    };
  }, [refetchStatus, selectedStatuses, t, toast]);

  async function installOne(status: SkillTargetStatus) {
    return installSkill(status.target, [
      {
        target: status.target,
        inventoryFingerprint: status.inventoryFingerprint,
      },
    ]);
  }

  async function installSelected() {
    if (installing) return;
    if (selected.length === 0) {
      setError(t("agentTools.startupSelectOne"));
      return;
    }
    setInstalling(true);
    setError(null);
    saveAgentTargets(selected);
    try {
      const latest = await statusQuery.refetch();
      const byTarget = new Map(
        (latest.data?.targets ?? []).map((status) => [
          status.target,
          status,
        ]),
      );
      const requiresReview: string[] = [];
      for (const target of selected) {
        const status = byTarget.get(target);
        if (!status) continue;
        if (status.state === "missing" || status.state === "managed_older") {
          await installOne(status);
        } else if (
          status.state !== "managed_current" &&
          status.state !== "newer_known"
        ) {
          requiresReview.push(status.displayName);
        }
      }
      await statusQuery.refetch();
      if (requiresReview.length > 0) {
        setError(
          t("agentTools.startupReviewRequired", {
            targets: requiresReview.join(", "),
          }),
        );
        return;
      }
      setOpen(false);
    } catch (reason) {
      setError(
        t("agentTools.startupInstallFailed", { error: errMessage(reason) }),
      );
      await statusQuery.refetch();
    } finally {
      setInstalling(false);
    }
  }

  function saveForLater() {
    if (selected.length === 0) {
      setError(t("agentTools.startupSelectOne"));
      return;
    }
    saveAgentTargets(selected);
    setOpen(false);
  }

  function toggleTarget(target: SkillTarget, checked: boolean) {
    setError(null);
    setSelected((current) =>
      checked
        ? [...new Set([...current, target])]
        : current.filter((candidate) => candidate !== target),
    );
  }

  if (!open) return null;

  return (
    <ModalBackdrop>
      <ModalSurface
        aria-labelledby="agent-startup-title"
        aria-describedby="agent-startup-description"
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
              const status = statuses.find(
                (candidate) => candidate.target === agent.target,
              );
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
                      {t(stateLabel[status.state])}
                    </StatusBadge>
                  ) : (
                    <StatusBadge tone="neutral">
                      {t("common.loading")}
                    </StatusBadge>
                  )}
                </div>
              );
            })}
          </div>

          <p className="tw:mt-4 tw:mb-0 tw:text-xs tw:leading-body tw:text-muted-foreground">
            {t("agentTools.startupSafety")}
          </p>
          {error ? (
            <p
              className="tw:mt-3 tw:mb-0 tw:text-ui tw:leading-body tw:text-danger"
              role="alert"
            >
              {error}
            </p>
          ) : null}
        </div>
        <ModalFooter>
          <Button
            variant="ghost"
            disabled={installing}
            onClick={saveForLater}
          >
            {t("agentTools.startupLater")}
          </Button>
          <Button
            variant="primary"
            disabled={
              installing || statusQuery.isPending || selected.length === 0
            }
            onClick={() => void installSelected()}
          >
            {installing ? (
              <Icon
                name="refresh"
                className="tw:animate-spin tw:motion-reduce:animate-none"
              />
            ) : (
              <Icon name="download" />
            )}
            {t("agentTools.startupInstallSelected")}
          </Button>
        </ModalFooter>
      </ModalSurface>
    </ModalBackdrop>
  );
}

function skillStateTone(state: SkillInstallState): StatusTone {
  if (state === "managed_current" || state === "newer_known") return "success";
  if (state === "missing" || state === "managed_older") return "warning";
  return "danger";
}
