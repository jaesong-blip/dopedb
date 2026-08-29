// Presents the explicit one-time cleanup for retired general MCP configuration.
import ConfirmButton from "../../../components/ConfirmButton";
import Skeleton from "../../../components/Skeleton";
import { StatusBadge } from "../../../design-system/components/Status";
import { errMessage } from "../../../ipc/types";
import { useI18n } from "../../../lib/i18n";
import type { AgentToolsController } from "./useAgentToolsController";

interface LegacyMcpCleanupSectionProps {
  controller: AgentToolsController;
}

export function LegacyMcpCleanupSection({
  controller,
}: LegacyMcpCleanupSectionProps) {
  const { t } = useI18n();
  const {
    busy,
    cleanupQuery,
    cleanupReady,
    cleanupManual,
    runLegacyCleanup,
  } = controller;

  return (
    <section className="tw:border-t tw:border-border-subtle tw:pt-5 tw:pb-2">
      <div className="tw:flex tw:items-center tw:justify-between tw:gap-4 tw:@max-[520px]:flex-col tw:@max-[520px]:items-start">
        <div className="tw:flex tw:min-w-0 tw:flex-col tw:items-start tw:gap-1">
          <h3 className="tw:m-0">{t("agentTools.legacyCleanupTitle")}</h3>
          <p className="tw:m-0 tw:text-muted-foreground">
            {t("agentTools.legacyCleanupDescription")}
          </p>
        </div>
        {cleanupReady.length > 0 ? (
          <ConfirmButton
            disabled={busy !== null}
            confirmLabel={t("agentTools.legacyCleanupConfirm", {
              count: cleanupReady.length,
            })}
            onConfirm={() => void runLegacyCleanup()}
          >
            {t("agentTools.legacyCleanupAction")}
          </ConfirmButton>
        ) : null}
      </div>

      {cleanupQuery.isPending ? (
        <Skeleton lines={3} />
      ) : cleanupQuery.error ? (
        <div className="tw:text-ui tw:text-danger" role="alert">
          {t("agentTools.legacyCleanupError", {
            error: errMessage(cleanupQuery.error),
          })}
        </div>
      ) : (
        <div className="tw:mt-3 tw:divide-y tw:divide-border-subtle tw:border-y tw:border-border-subtle">
          {cleanupQuery.data?.targets.map((target) => (
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
              <code className="tw:[overflow-wrap:anywhere]">{target.path}</code>
              {target.redactedDiff ? (
                <span className="tw:text-muted-foreground">
                  {target.redactedDiff}
                </span>
              ) : null}
              {target.reason ? (
                <span className="tw:text-ui tw:text-danger">
                  {target.reason}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      )}
      {cleanupManual.length > 0 ? (
        <p className="tw:text-muted-foreground">
          {t("agentTools.legacyCleanupManualHint")}
        </p>
      ) : null}
    </section>
  );
}
