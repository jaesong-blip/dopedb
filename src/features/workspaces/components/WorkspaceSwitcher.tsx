// Compact active-workspace control for the database explorer. Workspace changes clear
// cached resource reads before the shell reloads the newly selected account scope.
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  setActiveWorkspace,
  workspaceConsoleUrl,
} from "../tauriAdapter";
import {
  fetchWorkspaceContext,
  invalidateWorkspaceAuth,
  invalidateWorkspaceState,
  resetWorkspaceScope,
} from "../cache";
import { workspaceAuthStateQuery, workspaceContextQuery } from "../queries";
import {
  buildWorkspaceChoiceGroups,
  parseWorkspaceChoice,
  workspaceChoiceValue,
} from "../choices";
import { errMessage } from "../../../ipc/types";
import { useI18n } from "../../../lib/i18n";
import { Icon } from "../../../components/Icon";
import { useToast } from "../../../components/Toast";

export default function WorkspaceSwitcher({
  onChanged,
  onNew,
}: {
  onChanged: () => void | Promise<void>;
  onNew: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const context = useQuery(workspaceContextQuery());
  const auth = useQuery(workspaceAuthStateQuery());
  const [switching, setSwitching] = useState(false);
  const [dashboardOpening, setDashboardOpening] = useState(false);
  const roleLabels = {
    viewer: t("workspace.accessView"),
    analyst: t("workspace.accessRead"),
    editor: t("workspace.accessWrite"),
    admin: t("workspace.accessManage"),
    owner: t("workspace.accessManage"),
  } as const;
  const choiceGroups = useMemo(
    () => buildWorkspaceChoiceGroups(
      auth.data,
      context.data?.workspaces ?? [],
      t("workspace.localOnly"),
    ),
    [auth.data, context.data?.workspaces, t],
  );
  const activeChoice = context.data
    ? workspaceChoiceValue(
        context.data.active.id,
        context.data.active.kind === "team" ? (auth.data?.user?.id ?? null) : null,
      )
    : "";

  async function changeWorkspace(value: string) {
    if (!context.data?.feature.enabled) return;
    const choice = parseWorkspaceChoice(value);
    if (!choice || value === activeChoice || switching) return;
    const accountUserId = choice.accountUserId ?? auth.data?.user?.id;
    setSwitching(true);
    try {
      await setActiveWorkspace(choice.workspaceId, accountUserId);
      await resetWorkspaceScope(queryClient, "none");
      await invalidateWorkspaceAuth(queryClient);
      await fetchWorkspaceContext(queryClient);
      await onChanged();
    } catch (error) {
      await invalidateWorkspaceState(queryClient);
      toast(t("workspace.switchFailed", { error: errMessage(error) }), "error");
    } finally {
      setSwitching(false);
    }
  }

  async function openDashboard() {
    if (!context.data?.feature.enabled || dashboardOpening) return;
    setDashboardOpening(true);
    try {
      const { active } = context.data;
      const url = await workspaceConsoleUrl(active.kind === "team" ? active.id : undefined);
      await openUrl(url);
    } catch (error) {
      toast(t("workspace.dashboardOpenFailed", { error: errMessage(error) }), "error");
    } finally {
      setDashboardOpening(false);
    }
  }

  const dashboardLabel =
    context.data?.active.kind === "team"
      ? t("workspace.openDashboardFor", { name: context.data.active.name })
      : t("workspace.openDashboard");

  return (
    <div
      className="tw:grid tw:shrink-0 tw:gap-0 tw:border-b tw:border-border-subtle tw:bg-card tw:pt-[var(--ds-window-controls-safe-height)]"
      data-tauri-drag-region="deep"
    >
      <div className="tw:flex tw:min-h-control-lg tw:min-w-0 tw:items-center tw:justify-between tw:gap-2 tw:px-2">
        <span className="tw:min-w-0 tw:overflow-hidden tw:text-ui tw:font-semibold tw:text-foreground tw:text-ellipsis tw:whitespace-nowrap">
          {t("workspace.label")}
        </span>
        <div className="ds-control-row tw:flex tw:shrink-0 tw:items-center tw:gap-1 tw:[--ds-row-control-size:var(--ds-control-xs)]">
          <button
            type="button"
            className="btn small icon-only tw:size-control-xs tw:min-h-control-xs tw:min-w-control-xs tw:border-transparent tw:bg-transparent tw:p-0 tw:text-muted-foreground tw:shadow-none tw:hover:border-transparent tw:hover:bg-muted tw:hover:text-foreground"
            onClick={onNew}
            title={t("connections.new")}
            aria-label={t("connections.new")}
          >
            <Icon name="plus" />
          </button>
          <button
            type="button"
            className="btn small icon-only tw:size-control-xs tw:min-h-control-xs tw:min-w-control-xs tw:border-transparent tw:bg-transparent tw:p-0 tw:text-muted-foreground tw:shadow-none tw:hover:border-transparent tw:hover:bg-muted tw:hover:text-primary tw:disabled:cursor-progress"
            onClick={() => void openDashboard()}
            disabled={!context.data?.feature.enabled || dashboardOpening}
            title={dashboardLabel}
            aria-label={dashboardLabel}
            aria-busy={dashboardOpening}
          >
            <Icon name="externalLink" />
          </button>
        </div>
      </div>
      {context.isLoading ? (
        <div className="ds-control-row tw:grid tw:min-h-control-lg tw:min-w-0 tw:auto-rows-[var(--ds-control-sm)] tw:grid-cols-[minmax(0,1fr)] tw:items-stretch tw:gap-1 tw:px-2 tw:pb-2 tw:[--ds-row-control-size:var(--ds-control-sm)]">
          <div
            className="tw:h-control-sm tw:rounded-sm tw:border tw:border-border-subtle tw:bg-background tw:opacity-55"
            aria-hidden="true"
          />
        </div>
      ) : context.data?.feature.enabled ? (
        <div className="ds-control-row tw:grid tw:min-h-control-lg tw:min-w-0 tw:auto-rows-[var(--ds-control-sm)] tw:grid-cols-[minmax(0,1fr)] tw:items-stretch tw:gap-1 tw:px-2 tw:pb-2 tw:[--ds-row-control-size:var(--ds-control-sm)]">
          <div className="tw:relative tw:flex tw:h-control-sm tw:items-center">
            <select
              className="tw:h-control-sm tw:min-h-control-sm tw:w-full tw:min-w-0 tw:appearance-none tw:rounded-sm tw:border tw:border-border-subtle tw:bg-secondary tw:py-0 tw:pr-6 tw:pl-2 tw:font-sans tw:text-sm tw:font-semibold tw:text-foreground tw:text-ellipsis tw:focus-visible:outline-none tw:focus-visible:ring-2 tw:focus-visible:ring-ring tw:disabled:cursor-default tw:disabled:opacity-100"
              value={activeChoice}
              onChange={(event) => void changeWorkspace(event.target.value)}
              disabled={switching || auth.data === undefined}
              aria-label={t("workspace.select")}
            >
              {choiceGroups.map((group) => (
                <optgroup key={group.key} label={group.label}>
                  {group.choices.map((choice) => (
                    <option key={choice.value} value={choice.value}>
                      {choice.workspace.kind === "personal"
                        ? t("workspace.personalName")
                        : `${choice.workspace.name} · ${choice.role ? roleLabels[choice.role] : ""}`}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <Icon
              name="chevronDown"
              className="tw:pointer-events-none tw:absolute tw:right-2 tw:text-muted-foreground"
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
