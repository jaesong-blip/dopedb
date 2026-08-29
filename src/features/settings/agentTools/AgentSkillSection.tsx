// Renders Skill inventory, conflicts, and explicit install/repair/remove actions.
import ConfirmButton from "../../../components/ConfirmButton";
import Skeleton from "../../../components/Skeleton";
import { Button } from "../../../design-system/components/Button";
import { StatusBadge } from "../../../design-system/components/Status";
import { errMessage } from "../../../ipc/types";
import { useI18n } from "../../../lib/i18n";
import {
  skillStateLabel,
  skillStateTone,
} from "../../skills/presentation";
import { skillConflictLabel, skillReasonLabel } from "./model";
import type { AgentToolsController } from "./useAgentToolsController";

interface AgentSkillSectionProps {
  controller: AgentToolsController;
}

export function AgentSkillSection({ controller }: AgentSkillSectionProps) {
  const { t } = useI18n();
  const {
    busy,
    error,
    status,
    statusQuery,
    runInstall,
    runMutation,
  } = controller;

  return (
    <>
      <section className="tw:border-t tw:border-border-subtle tw:pt-5">
        <h3 className="tw:m-0">{t("agentTools.skillTitle")}</h3>
        <p className="tw:mt-1 tw:mb-0 tw:text-muted-foreground">
          {t("agentTools.skillDescription")}
        </p>
      </section>

      {status ? (
        <p className="tw:mt-1 tw:mb-4 tw:text-muted-foreground">
          {t("agentTools.version", {
            version: status.skill.appVersion,
            revision: status.skill.releaseRevision,
          })}
        </p>
      ) : null}

      {error || statusQuery.error ? (
        <div className="tw:text-ui tw:text-danger" role="alert">
          {t("agentTools.error", {
            error: error ?? errMessage(statusQuery.error),
          })}
        </div>
      ) : null}
      {!status && statusQuery.isPending ? (
        <Skeleton lines={6} />
      ) : status ? (
        <div className="tw:mt-3 tw:divide-y tw:divide-border-subtle tw:border-y tw:border-border-subtle">
          {status.targets.map((target) => {
            const canInstall =
              target.state === "missing" || target.state === "managed_older";
            const canRepair =
              target.repairable &&
              [
                "user_modified",
                "newer_known",
                "unknown_conflict",
                "invalid",
              ].includes(target.state);
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
                  {target.installedRevision !== null ? (
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
                  ) : null}
                  <div className="tw:grid tw:grid-cols-[minmax(120px,0.3fr)_minmax(0,1fr)] tw:gap-3 tw:@max-[520px]:grid-cols-[minmax(0,1fr)] tw:@max-[520px]:gap-1">
                    <dt className="tw:text-muted-foreground">
                      {t("agentTools.currentRevision")}
                    </dt>
                    <dd className="tw:m-0 tw:min-w-0">
                      {target.currentRevision}
                    </dd>
                  </div>
                </dl>
                {target.reason ? (
                  <p className="tw:mt-2 tw:text-muted-foreground">
                    {t(skillReasonLabel[target.reason])}
                  </p>
                ) : null}
                {target.conflicts.length > 0 ? (
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
                        <span>{t(skillConflictLabel[conflict.kind])}</span>
                        <code className="tw:[overflow-wrap:anywhere]">
                          {conflict.path}
                        </code>
                      </p>
                    ))}
                  </>
                ) : null}

                {canInstall || canRepair || canRemove ? (
                  <div className="ds-control-row tw:mt-3 tw:flex tw:flex-wrap tw:items-center tw:gap-[var(--ds-control-gap)]">
                    {canInstall ? (
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
                    ) : null}
                    {canRepair ? (
                      <ConfirmButton
                        disabled={busy !== null}
                        confirmLabel={t("agentTools.repairConfirm", {
                          count: target.conflicts.length,
                        })}
                        onConfirm={() =>
                          void runMutation("repair", target.target)
                        }
                      >
                        {t("agentTools.repair")}
                      </ConfirmButton>
                    ) : null}
                    {canRemove ? (
                      <ConfirmButton
                        disabled={busy !== null}
                        confirmLabel={t("agentTools.removeConfirm")}
                        onConfirm={() =>
                          void runMutation("remove", target.target)
                        }
                      >
                        {t("agentTools.remove")}
                      </ConfirmButton>
                    ) : null}
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      ) : null}
    </>
  );
}
