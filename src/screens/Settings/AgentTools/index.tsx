// Manages the bounded Codex/Claude Skill inventory through explicit install,
// backup-and-repair, remove, and version-matched CLI self-test actions.
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  agentCliDetectionQuery,
  agentPluginStatusQuery,
} from "../../../features/agents/queryOptions";
import {
  installAgentAcpPlugin,
  removeAgentAcpPlugin,
  setAgentAcpPluginEnabled,
} from "../../../features/agents/tauriAdapter";
import type {
  AcpPluginId,
  AcpPluginInstallationState,
  AgentProvider,
} from "../../../features/agents/domain";
import {
  legacyMcpCleanupApply,
  installSkill,
  removeSkill,
  repairSkill,
  skillSelfTest,
} from "../../../ipc/commands";
import {
  errMessage,
  type SkillConflictKind,
  type SkillMutationReceipt,
  type SkillStatusReason,
  type SkillTargetExpectation,
  type SkillTargetSelection,
} from "../../../ipc/types";
import ConfirmButton from "../../../components/ConfirmButton";
import InfoTip from "../../../components/InfoTip";
import Skeleton from "../../../components/Skeleton";
import { useToast } from "../../../components/Toast";
import { Button } from "../../../design-system/components/Button";
import { AgentProviderMark } from "../../../design-system/components/Agent";
import { CheckboxField } from "../../../design-system/components/FormControls";
import { ProgressBar } from "../../../design-system/components/Progress";
import {
  legacyMcpCleanupStatusQuery,
  qk,
  skillStatusQuery,
} from "../../../lib/queries";
import { useI18n, type I18nKey } from "../../../lib/i18n";
import { buildSkillSetupPlan } from "../../../features/skills/setupPolicy";
import {
  skillStateLabel,
  skillStateTone,
} from "../../../features/skills/presentation";
import { StatusBadge } from "../../../design-system/components/Status";

type Mutation = "repair" | "remove";
type BusyAction =
  | SkillTargetSelection
  | AcpPluginId
  | "plugin-batch"
  | "self-test"
  | "legacy-cleanup";

const plugins: ReadonlyArray<{
  id: AcpPluginId;
  provider: AgentProvider;
  label: string;
  download: string;
}> = [
  {
    id: "dopedb.acp.claude",
    provider: "claude",
    label: "Claude",
    download: "≤ 30 MB",
  },
  {
    id: "dopedb.acp.codex",
    provider: "codex",
    label: "Codex",
    download: "≤ 30 MB",
  },
];

const activePluginStates = new Set<AcpPluginInstallationState>([
  "checking",
  "downloading",
  "verifying",
  "removing",
]);

const pluginStateLabel: Record<AcpPluginInstallationState, I18nKey> = {
  not_installed: "agentTools.pluginState.notInstalled",
  checking: "agentTools.pluginState.checking",
  downloading: "agentTools.pluginState.downloading",
  verifying: "agentTools.pluginState.verifying",
  staged: "agentTools.pluginState.staged",
  ready: "agentTools.pluginState.ready",
  update_available: "agentTools.pluginState.updateAvailable",
  removing: "agentTools.pluginState.removing",
  failed: "agentTools.pluginState.failed",
  rollback_required: "agentTools.pluginState.rollbackRequired",
};

function pluginTone(state: AcpPluginInstallationState) {
  if (state === "ready") return "success" as const;
  if (state === "failed" || state === "rollback_required") return "danger" as const;
  if (state === "not_installed") return "neutral" as const;
  return "warning" as const;
}

const conflictLabel: Record<SkillConflictKind, I18nKey> = {
  invalid_provenance: "agentTools.conflictInvalidProvenance",
  missing: "agentTools.conflictMissing",
  modified: "agentTools.conflictModified",
  unexpected: "agentTools.conflictUnexpected",
};

const reasonLabel: Record<SkillStatusReason, I18nKey> = {
  files_differ_from_managed_snapshot:
    "agentTools.reasonFilesDifferFromManagedSnapshot",
  install_path_inspection_failed:
    "agentTools.reasonInstallPathInspectionFailed",
  install_path_symlink: "agentTools.reasonInstallPathSymlink",
  install_root_not_directory: "agentTools.reasonInstallRootNotDirectory",
  install_target_not_directory: "agentTools.reasonInstallTargetNotDirectory",
  install_target_outside_home: "agentTools.reasonInstallTargetOutsideHome",
  install_target_symlink: "agentTools.reasonInstallTargetSymlink",
  installed_file_changed: "agentTools.reasonInstalledFileChanged",
  installed_file_too_large: "agentTools.reasonInstalledFileTooLarge",
  installed_skill_byte_limit: "agentTools.reasonInstalledSkillByteLimit",
  installed_skill_file_count_limit:
    "agentTools.reasonInstalledSkillFileCountLimit",
  installed_skill_nesting_limit:
    "agentTools.reasonInstalledSkillNestingLimit",
  installed_skill_non_unicode_path:
    "agentTools.reasonInstalledSkillNonUnicodePath",
  installed_skill_read_failed: "agentTools.reasonInstalledSkillReadFailed",
  installed_skill_symlink: "agentTools.reasonInstalledSkillSymlink",
  installed_skill_unsafe_path: "agentTools.reasonInstalledSkillUnsafePath",
  installed_skill_unsupported_file:
    "agentTools.reasonInstalledSkillUnsupportedFile",
  inventory_escaped_root: "agentTools.reasonInventoryEscapedRoot",
  provenance_marker_malformed:
    "agentTools.reasonProvenanceMarkerMalformed",
  provenance_marker_not_file: "agentTools.reasonProvenanceMarkerNotFile",
  provenance_marker_unreadable:
    "agentTools.reasonProvenanceMarkerUnreadable",
  unknown_managed_snapshot: "agentTools.reasonUnknownManagedSnapshot",
  unmanaged_files: "agentTools.reasonUnmanagedFiles",
  unsafe_path_component: "agentTools.reasonUnsafePathComponent",
};

export default function AgentTools() {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const statusQ = useQuery(skillStatusQuery());
  const pluginsQ = useQuery(agentPluginStatusQuery());
  const agentsQ = useQuery({
    ...agentCliDetectionQuery(),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const cleanupQ = useQuery(legacyMcpCleanupStatusQuery());
  const [busy, setBusy] = useState<BusyAction | null>(null);
  const [selectedPlugins, setSelectedPlugins] = useState<AcpPluginId[]>([]);
  const [error, setError] = useState<string | null>(null);
  const status = statusQ.data ?? null;

  useEffect(() => {
    if (busy !== "plugin-batch" && !busy?.startsWith("dopedb.acp.")) return;
    const timer = window.setInterval(() => void pluginsQ.refetch(), 500);
    return () => window.clearInterval(timer);
  }, [busy, pluginsQ.refetch]);

  useEffect(() => {
    if (!pluginsQ.data || selectedPlugins.length > 0) return;
    setSelectedPlugins(
      pluginsQ.data
        .filter((plugin) => plugin.state === "not_installed")
        .map((plugin) => plugin.pluginId),
    );
  }, [pluginsQ.data, selectedPlugins.length]);

  async function installPlugins(pluginIds: AcpPluginId[]) {
    if (pluginIds.length === 0) return;
    setBusy(pluginIds.length === 1 ? pluginIds[0] : "plugin-batch");
    setError(null);
    const failures: string[] = [];
    try {
      for (const pluginId of pluginIds) {
        try {
          await installAgentAcpPlugin(pluginId);
        } catch (reason) {
          failures.push(errMessage(reason));
        } finally {
          await pluginsQ.refetch();
        }
      }
      if (failures.length > 0) throw new Error(failures.join("\n"));
      setSelectedPlugins([]);
      toast(t("agentTools.pluginsInstalled", { count: pluginIds.length }));
    } catch (reason) {
      const message = errMessage(reason);
      setError(message);
      toast(message, "error");
    } finally {
      setBusy(null);
    }
  }

  async function removePlugin(pluginId: AcpPluginId) {
    setBusy(pluginId);
    setError(null);
    try {
      await removeAgentAcpPlugin(pluginId);
      await pluginsQ.refetch();
      toast(t("agentTools.pluginRemoved"));
    } catch (reason) {
      const message = errMessage(reason);
      setError(message);
      toast(message, "error");
    } finally {
      setBusy(null);
    }
  }

  async function togglePlugin(pluginId: AcpPluginId, enabled: boolean) {
    setBusy(pluginId);
    setError(null);
    try {
      await setAgentAcpPluginEnabled(pluginId, enabled);
      await pluginsQ.refetch();
    } catch (reason) {
      const message = errMessage(reason);
      setError(message);
      toast(message, "error");
    } finally {
      setBusy(null);
    }
  }

  function expectations(target: SkillTargetSelection): SkillTargetExpectation[] {
    const selected =
      target === "all"
        ? status?.targets
        : status?.targets.filter((item) => item.target === target);
    return (selected ?? []).map((item) => ({
      target: item.target,
      inventoryFingerprint: item.inventoryFingerprint,
    }));
  }

  async function runMutation(mutation: Mutation, target: SkillTargetSelection) {
    if (!status) return;
    setBusy(target);
    setError(null);
    try {
      const expected = expectations(target);
      let receipt: SkillMutationReceipt;
      if (mutation === "repair") {
        receipt = await repairSkill(target, expected);
      } else {
        receipt = await removeSkill(target, expected);
      }
      await statusQ.refetch();
      for (const backup of receipt.backups) {
        toast(t("agentTools.backupCreated", { path: backup.path }));
      }
      if (mutation === "remove") {
        toast(t("agentTools.removed"));
      } else {
        const tested = await skillSelfTest();
        toast(t("agentTools.updated"));
        toast(
          t("agentTools.selfTestPassed", {
            revision: tested.releaseRevision,
            bytes: tested.guideBytes,
          }),
        );
      }
    } catch (reason) {
      const message = errMessage(reason);
      setError(message);
      toast(message, "error");
      await statusQ.refetch();
    } finally {
      setBusy(null);
    }
  }

  async function runInstall(target: SkillTargetSelection) {
    if (!status) return;
    setBusy(target);
    setError(null);
    try {
      const receipt = await installSkill(target, expectations(target));
      await statusQ.refetch();
      for (const backup of receipt.backups) {
        toast(t("agentTools.backupCreated", { path: backup.path }));
      }
      const tested = await skillSelfTest();
      toast(t("agentTools.updated"));
      toast(
        t("agentTools.selfTestPassed", {
          revision: tested.releaseRevision,
          bytes: tested.guideBytes,
        }),
      );
    } catch (reason) {
      const message = errMessage(reason);
      setError(message);
      toast(message, "error");
      await statusQ.refetch();
    } finally {
      setBusy(null);
    }
  }

  async function runSelfTest() {
    setBusy("self-test");
    setError(null);
    try {
      const tested = await skillSelfTest();
      toast(
        t("agentTools.selfTestPassed", {
          revision: tested.releaseRevision,
          bytes: tested.guideBytes,
        }),
      );
    } catch (reason) {
      const message = errMessage(reason);
      setError(message);
      toast(message, "error");
    } finally {
      setBusy(null);
    }
  }

  async function runLegacyCleanup() {
    const expectations =
      cleanupQ.data?.targets.flatMap((target) =>
        target.state === "ready" && target.fingerprint
          ? [{ id: target.id, fingerprint: target.fingerprint }]
          : [],
      ) ?? [];
    if (expectations.length === 0) return;
    setBusy("legacy-cleanup");
    setError(null);
    try {
      const receipt = await legacyMcpCleanupApply(expectations);
      queryClient.setQueryData(qk.legacyMcpCleanup(), receipt.status);
      for (const backup of receipt.backups) {
        toast(t("agentTools.legacyCleanupBackup", { path: backup.path }));
      }
      toast(
        t("agentTools.legacyCleanupComplete", {
          count: receipt.removedTargetIds.length,
        }),
      );
    } catch (reason) {
      const message = errMessage(reason);
      setError(message);
      toast(message, "error");
      await cleanupQ.refetch();
    } finally {
      setBusy(null);
    }
  }

  const combinedSetupPlan = status
    ? buildSkillSetupPlan(status.targets)
    : null;
  const anyCurrent = status?.targets.some(
    (target) => target.state === "managed_current",
  );
  const cleanupReady =
    cleanupQ.data?.targets.filter((target) => target.state === "ready") ?? [];
  const cleanupManual =
    cleanupQ.data?.targets.filter((target) => target.state === "manual_review") ?? [];

  return (
    <div
      className="tw:w-full tw:max-w-[800px] tw:p-4 tw:@max-[700px]:p-0"
      data-primary-flow
    >
      <div className="tw:inline-flex tw:items-center tw:gap-2">
        <h2>{t("agentTools.title")}</h2>
        <InfoTip label={t("agentTools.description")} />
      </div>

      <section className="tw:mt-5 tw:border-t tw:border-border-subtle tw:pt-5">
        <div className="tw:flex tw:items-start tw:justify-between tw:gap-4 tw:@max-[520px]:flex-col">
          <div>
            <h3 className="tw:m-0">{t("agentTools.pluginsTitle")}</h3>
            <p className="tw:mt-1 tw:mb-0 tw:text-muted-foreground">
              {t("agentTools.pluginsDescription")}
            </p>
          </div>
          <Button
            variant="primary"
            disabled={busy !== null || selectedPlugins.length === 0}
            onClick={() => void installPlugins(selectedPlugins)}
          >
            {t("agentTools.installSelected", { count: selectedPlugins.length })}
          </Button>
        </div>

        {pluginsQ.isPending ? (
          <Skeleton lines={4} />
        ) : pluginsQ.error ? (
          <div className="tw:mt-3 tw:text-ui tw:text-danger" role="alert">
            {t("agentTools.pluginsError", { error: errMessage(pluginsQ.error) })}
          </div>
        ) : (
          <div className="tw:mt-3 tw:divide-y tw:divide-border-subtle tw:border-y tw:border-border-subtle">
            {plugins.map((plugin) => {
              const pluginStatus = pluginsQ.data?.find(
                (candidate) => candidate.pluginId === plugin.id,
              );
              if (!pluginStatus) return null;
              const operationActive =
                activePluginStates.has(pluginStatus.state) ||
                busy === plugin.id ||
                busy === "plugin-batch";
              const installed = Boolean(
                pluginStatus.installedVersion ||
                  pluginStatus.candidateVersion ||
                  pluginStatus.lastKnownGoodVersion,
              );
              const selectable =
                pluginStatus.state !== "ready" || Boolean(pluginStatus.failure);
              return (
                <div className="tw:grid tw:gap-3 tw:py-4" key={plugin.id}>
                  <div className="tw:flex tw:items-center tw:justify-between tw:gap-4 tw:@max-[520px]:flex-col tw:@max-[520px]:items-start">
                    <div className="tw:flex tw:min-w-0 tw:items-center tw:gap-2">
                      {selectable ? (
                        <CheckboxField
                          checked={selectedPlugins.includes(plugin.id)}
                          disabled={busy !== null}
                          onChange={(event) =>
                            setSelectedPlugins((current) =>
                              event.target.checked
                                ? [...new Set([...current, plugin.id])]
                                : current.filter((id) => id !== plugin.id),
                            )
                          }
                          label={
                            <span className="tw:flex tw:items-center tw:gap-2">
                              <AgentProviderMark provider={plugin.provider} />
                              <strong>{plugin.label}</strong>
                            </span>
                          }
                        />
                      ) : (
                        <span className="tw:flex tw:items-center tw:gap-2">
                          <AgentProviderMark provider={plugin.provider} />
                          <strong>{plugin.label}</strong>
                        </span>
                      )}
                      <StatusBadge tone={pluginTone(pluginStatus.state)}>
                        {t(pluginStateLabel[pluginStatus.state])}
                      </StatusBadge>
                    </div>
                    <span className="tw:text-ui tw:text-muted-foreground">
                      {pluginStatus.candidateVersion ??
                        pluginStatus.installedVersion ??
                        pluginStatus.lastKnownGoodVersion ??
                        t("agentTools.pluginDownload", { size: plugin.download })}
                    </span>
                  </div>
                  {operationActive ? (
                    <ProgressBar
                      value={null}
                      density="compact"
                      label={t("agentTools.pluginProgress", { provider: plugin.label })}
                    />
                  ) : null}
                  {pluginStatus.failure ? (
                    <p className="tw:m-0 tw:text-ui tw:text-danger" role="alert">
                      {pluginStatus.failure}
                    </p>
                  ) : null}
                  <div className="ds-control-row tw:flex tw:flex-wrap tw:items-center tw:gap-[var(--ds-control-gap)]">
                    {selectable ? (
                      <Button
                        disabled={busy !== null}
                        onClick={() => void installPlugins([plugin.id])}
                      >
                        {t(installed ? "agentTools.retryPlugin" : "agentTools.installPlugin")}
                      </Button>
                    ) : (
                      <Button
                        disabled={busy !== null}
                        onClick={() =>
                          void togglePlugin(plugin.id, !pluginStatus.enabled)
                        }
                      >
                        {t(
                          pluginStatus.enabled
                            ? "agentTools.disablePlugin"
                            : "agentTools.enablePlugin",
                        )}
                      </Button>
                    )}
                    {installed ? (
                      <ConfirmButton
                        disabled={busy !== null}
                        confirmLabel={t("agentTools.removePluginConfirm", {
                          provider: plugin.label,
                        })}
                        onConfirm={() => void removePlugin(plugin.id)}
                      >
                        {t("agentTools.removePlugin")}
                      </ConfirmButton>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="tw:border-t tw:border-border-subtle tw:pt-5 tw:pb-2">
        <h3 className="tw:m-0">{t("agentTools.localClisTitle")}</h3>
        <p className="tw:mt-1 tw:mb-0 tw:text-muted-foreground">
          {t("agentTools.localClisDescription")}
        </p>
        {agentsQ.isPending ? (
          <Skeleton lines={3} />
        ) : (
          <div className="tw:mt-3 tw:divide-y tw:divide-border-subtle tw:border-y tw:border-border-subtle">
            {plugins.map((plugin) => {
              const cli = agentsQ.data?.find((item) => item.id === plugin.provider);
              return (
                <div
                  className="tw:flex tw:items-start tw:justify-between tw:gap-4 tw:py-3 tw:@max-[520px]:flex-col"
                  key={plugin.provider}
                >
                  <div className="tw:flex tw:min-w-0 tw:items-center tw:gap-2">
                    <AgentProviderMark provider={plugin.provider} />
                    <strong>{cli?.name ?? plugin.label}</strong>
                  </div>
                  <div className="tw:flex tw:flex-wrap tw:items-center tw:gap-2">
                    <StatusBadge tone={cli?.installed ? "success" : "warning"}>
                      {t(cli?.installed ? "agentTools.detected" : "agentTools.cliMissing")}
                    </StatusBadge>
                    <StatusBadge tone={cli?.authenticated ? "success" : "warning"}>
                      {t(
                        cli?.authenticated
                          ? "agentTools.authenticated"
                          : "agentTools.notAuthenticated",
                      )}
                    </StatusBadge>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="tw:border-t tw:border-border-subtle tw:pt-5">
        <h3 className="tw:m-0">{t("agentTools.skillTitle")}</h3>
        <p className="tw:mt-1 tw:mb-0 tw:text-muted-foreground">
          {t("agentTools.skillDescription")}
        </p>
      </section>

      {status && (
        <p className="tw:mt-1 tw:mb-4 tw:text-muted-foreground">
          {t("agentTools.version", {
            version: status.skill.appVersion,
            revision: status.skill.releaseRevision,
          })}
        </p>
      )}

      {(error || statusQ.error) && (
        <div className="tw:text-ui tw:text-danger" role="alert">
          {t("agentTools.error", {
            error: error ?? errMessage(statusQ.error),
          })}
        </div>
      )}
      {agentsQ.error && (
        <div className="tw:text-ui tw:text-danger" role="alert">
          {t("agentTools.detectError", { error: errMessage(agentsQ.error) })}
        </div>
      )}

      {!status && statusQ.isPending ? (
        <Skeleton lines={6} />
      ) : (
        status && (
          <div className="tw:mt-3 tw:divide-y tw:divide-border-subtle tw:border-y tw:border-border-subtle">
            {status.targets.map((target) => {
              const canInstall =
                target.state === "missing" || target.state === "managed_older";
              const canRepair =
                target.repairable &&
                ["user_modified", "newer_known", "unknown_conflict", "invalid"].includes(
                  target.state,
                );
              const canRemove = [
                "managed_current",
                "managed_older",
                "newer_known",
              ].includes(target.state);
              return (
                <section className="tw:py-4" key={target.target}>
                  <div className="tw:flex tw:items-center tw:justify-between tw:gap-4 tw:@max-[520px]:flex-col tw:@max-[520px]:items-start tw:@max-[520px]:gap-2">
                    <div className="tw:flex tw:min-w-0 tw:items-center tw:gap-2">
                      <h3 className="tw:m-0 tw:text-title tw:leading-ui tw:font-bold tw:tracking-normal tw:text-foreground tw:normal-case">
                        {target.displayName}
                      </h3>
                      <StatusBadge tone={skillStateTone(target.state)}>
                        {t(skillStateLabel[target.state])}
                      </StatusBadge>
                    </div>
                  </div>

                  <dl className="tw:mt-3 tw:mb-0 tw:grid tw:gap-2">
                    <div className="tw:grid tw:grid-cols-[minmax(120px,0.3fr)_minmax(0,1fr)] tw:gap-3 tw:@max-[520px]:grid-cols-[minmax(0,1fr)] tw:@max-[520px]:gap-1">
                      <dt className="tw:text-muted-foreground">
                        {t("agentTools.path")}
                      </dt>
                      <dd className="tw:m-0 tw:min-w-0">
                        <code className="tw:[overflow-wrap:anywhere]">
                          {target.installPath}
                        </code>
                      </dd>
                    </div>
                    {target.installedRevision !== null && (
                      <div className="tw:grid tw:grid-cols-[minmax(120px,0.3fr)_minmax(0,1fr)] tw:gap-3 tw:@max-[520px]:grid-cols-[minmax(0,1fr)] tw:@max-[520px]:gap-1">
                        <dt className="tw:text-muted-foreground">
                          {t("cli.binaryStatus")}
                        </dt>
                        <dd className="tw:m-0 tw:min-w-0">
                          {t("agentTools.installedRevision", {
                            revision: target.installedRevision,
                          })}
                        </dd>
                      </div>
                    )}
                    <div className="tw:grid tw:grid-cols-[minmax(120px,0.3fr)_minmax(0,1fr)] tw:gap-3 tw:@max-[520px]:grid-cols-[minmax(0,1fr)] tw:@max-[520px]:gap-1">
                      <dt className="tw:text-muted-foreground">
                        {t("agentTools.currentRevision")}
                      </dt>
                      <dd className="tw:m-0 tw:min-w-0">
                        {target.currentRevision}
                      </dd>
                    </div>
                  </dl>
                  {target.reason && (
                    <p className="tw:mt-2 tw:text-muted-foreground">
                      {t(reasonLabel[target.reason])}
                    </p>
                  )}
                  {target.conflicts.length > 0 && (
                    <>
                      <p className="tw:mt-2 tw:font-semibold tw:text-foreground">
                        {t("agentTools.conflicts", {
                          count: target.conflicts.length,
                        })}
                      </p>
                      {target.conflicts.map((conflict) => (
                        <p
                          className="tw:mt-2 tw:flex tw:items-baseline tw:gap-2 tw:text-muted-foreground tw:@max-[520px]:flex-col tw:@max-[520px]:items-start tw:@max-[520px]:gap-1"
                          key={`${conflict.kind}:${conflict.path}`}
                        >
                          <span>{t(conflictLabel[conflict.kind])}</span>
                          <code className="tw:[overflow-wrap:anywhere]">
                            {conflict.path}
                          </code>
                        </p>
                      ))}
                    </>
                  )}

                  {(canInstall || canRepair || canRemove) && (
                    <div className="ds-control-row tw:mt-3 tw:flex tw:flex-wrap tw:items-center tw:gap-[var(--ds-control-gap)]">
                      {canInstall && (
                        <Button
                          disabled={busy !== null}
                          onClick={() => void runInstall(target.target)}
                        >
                          {t(
                            target.state === "managed_older"
                              ? "agentTools.update"
                              : "agentTools.install",
                          )}
                        </Button>
                      )}
                      {canRepair && (
                        <ConfirmButton
                          disabled={busy !== null}
                          confirmLabel={t("agentTools.repairConfirm", {
                            count: target.conflicts.length,
                          })}
                          onConfirm={() => void runMutation("repair", target.target)}
                        >
                          {t("agentTools.repair")}
                        </ConfirmButton>
                      )}
                      {canRemove && (
                        <ConfirmButton
                          disabled={busy !== null}
                          confirmLabel={t("agentTools.removeConfirm")}
                          onConfirm={() => void runMutation("remove", target.target)}
                        >
                          {t("agentTools.remove")}
                        </ConfirmButton>
                      )}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )
      )}

      <section className="tw:border-t tw:border-border-subtle tw:pt-5 tw:pb-2">
        <div className="tw:flex tw:items-center tw:justify-between tw:gap-4 tw:@max-[520px]:flex-col tw:@max-[520px]:items-start">
          <div className="tw:flex tw:min-w-0 tw:flex-col tw:items-start tw:gap-1">
            <h3 className="tw:m-0">
              {t("agentTools.legacyCleanupTitle")}
            </h3>
            <p className="tw:m-0 tw:text-muted-foreground">
              {t("agentTools.legacyCleanupDescription")}
            </p>
          </div>
          {cleanupReady.length > 0 && (
            <ConfirmButton
              disabled={busy !== null}
              confirmLabel={t("agentTools.legacyCleanupConfirm", {
                count: cleanupReady.length,
              })}
              onConfirm={() => void runLegacyCleanup()}
            >
              {t("agentTools.legacyCleanupAction")}
            </ConfirmButton>
          )}
        </div>

        {cleanupQ.isPending ? (
          <Skeleton lines={3} />
        ) : cleanupQ.error ? (
          <div className="tw:text-ui tw:text-danger" role="alert">
            {t("agentTools.legacyCleanupError", {
              error: errMessage(cleanupQ.error),
            })}
          </div>
        ) : (
          <div className="tw:mt-3 tw:divide-y tw:divide-border-subtle tw:border-y tw:border-border-subtle">
            {cleanupQ.data?.targets.map((target) => (
              <div className="tw:grid tw:gap-1 tw:py-3" key={target.id}>
                <div className="tw:flex tw:items-center tw:gap-2">
                  <span>{target.displayName}</span>
                  <StatusBadge
                    tone={
                      target.state === "ready"
                        ? "warning"
                        : target.state === "manual_review"
                          ? "danger"
                          : "success"
                    }
                  >
                    {t(
                      target.state === "ready"
                        ? "agentTools.legacyCleanupReady"
                        : target.state === "manual_review"
                          ? "agentTools.legacyCleanupManual"
                          : "agentTools.legacyCleanupAbsent",
                    )}
                  </StatusBadge>
                </div>
                <code className="tw:[overflow-wrap:anywhere]">
                  {target.path}
                </code>
                {target.redactedDiff && (
                  <span className="tw:text-muted-foreground">
                    {target.redactedDiff}
                  </span>
                )}
                {target.reason && (
                  <span className="tw:text-ui tw:text-danger">
                    {target.reason}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
        {cleanupManual.length > 0 && (
          <p className="tw:text-muted-foreground">
            {t("agentTools.legacyCleanupManualHint")}
          </p>
        )}
      </section>

      <div className="ds-control-row tw:mt-4 tw:flex tw:flex-wrap tw:items-center tw:gap-[var(--ds-control-gap)]">
        {combinedSetupPlan?.selection && (
          <Button
            variant="primary"
            disabled={busy !== null}
            onClick={() => void runInstall(combinedSetupPlan.selection!)}
          >
            {t(
              combinedSetupPlan.action === "update"
                ? "agentTools.updateAll"
                : combinedSetupPlan.action === "install-and-update"
                  ? "agentTools.installAndUpdate"
                  : "agentTools.installAll",
            )}
          </Button>
        )}
        {anyCurrent && (
          <Button
            disabled={busy !== null}
            onClick={() => void runSelfTest()}
          >
            {t("agentTools.selfTest")}
          </Button>
        )}
        <Button
          disabled={
            busy !== null ||
            statusQ.isFetching ||
            pluginsQ.isFetching ||
            agentsQ.isFetching ||
            cleanupQ.isFetching
          }
          onClick={() => {
            setError(null);
            void Promise.all([
              statusQ.refetch(),
              pluginsQ.refetch(),
              agentsQ.refetch(),
              cleanupQ.refetch(),
            ]);
          }}
        >
          {t("agentTools.checkAgain")}
        </Button>
      </div>
    </div>
  );
}
