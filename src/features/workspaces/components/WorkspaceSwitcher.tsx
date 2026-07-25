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
import "./WorkspaceSwitcher.css";

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
    <div className="workspace-switcher" data-tauri-drag-region="deep">
      <div className="workspace-switcher-head">
        <span className="workspace-switcher-label">{t("workspace.label")}</span>
        <div className="workspace-switcher-actions ds-control-row">
          <button
            type="button"
            className="btn small icon-only workspace-add-button"
            onClick={onNew}
            title={t("connections.new")}
            aria-label={t("connections.new")}
          >
            <Icon name="plus" />
          </button>
          <button
            type="button"
            className="btn small icon-only workspace-dashboard-button"
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
        <div className="workspace-select-row ds-control-row">
          <div className="workspace-select-skeleton" aria-hidden="true" />
        </div>
      ) : context.data?.feature.enabled ? (
        <div className="workspace-select-row ds-control-row">
          <div className="workspace-select-wrap">
            <select
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
            <Icon name="chevronDown" />
          </div>
        </div>
      ) : null}
    </div>
  );
}
