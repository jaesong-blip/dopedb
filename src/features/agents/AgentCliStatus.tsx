// Projects the local provider CLI query into one shared loading, failure,
// missing, authentication, and ready vocabulary across Agent setup surfaces.
import { Button } from "../../design-system/components/Button";
import {
  InlineNotice,
  StatusBadge,
} from "../../design-system/components/Status";
import { errMessage } from "../../ipc/types";
import { useI18n } from "../../lib/i18n";
import type { AgentCliInfo } from "./domain";

export function AgentCliStatusBadges({
  cli,
  detecting,
  queryFailed,
  showDetected = false,
}: {
  cli: AgentCliInfo | undefined;
  detecting: boolean;
  queryFailed: boolean;
  showDetected?: boolean;
}) {
  const { t } = useI18n();
  if (detecting) {
    return <StatusBadge>{t("agentTools.detecting")}</StatusBadge>;
  }
  if (queryFailed || !cli || Boolean(cli.detectionError)) {
    return (
      <StatusBadge tone="danger" title={cli?.detectionError ?? undefined}>
        {t("agentTools.detectionFailed")}
      </StatusBadge>
    );
  }
  if (!cli.installed) {
    return <StatusBadge tone="warning">{t("agentTools.cliMissing")}</StatusBadge>;
  }
  return (
    <>
      {showDetected ? (
        <StatusBadge tone="success">{t("agentTools.detected")}</StatusBadge>
      ) : null}
      <StatusBadge tone={cli.authenticated ? "success" : "warning"}>
        {t(
          cli.authenticated
            ? "agentTools.authenticated"
            : "agentTools.notAuthenticated",
        )}
      </StatusBadge>
    </>
  );
}

export function AgentCliDetectionNotice({
  clis,
  queryError,
  onRetry,
  retrying,
}: {
  clis: ReadonlyArray<AgentCliInfo> | undefined;
  queryError: unknown;
  onRetry: () => void;
  retrying: boolean;
}) {
  const { t } = useI18n();
  const failures =
    clis?.filter(
      (cli): cli is AgentCliInfo & { detectionError: string } =>
        Boolean(cli.detectionError),
    ) ?? [];
  if (!queryError && failures.length === 0) return null;
  return (
    <div className="tw:mt-3">
      <InlineNotice
        tone="danger"
        icon="alert"
        role="alert"
        action={
          <Button size="xs" variant="ghost" disabled={retrying} onClick={onRetry}>
            {t("agentTools.checkAgain")}
          </Button>
        }
      >
        <span className="tw:grid tw:gap-1">
          {queryError ? (
            <span>
              {t("agentTools.detectError", { error: errMessage(queryError) })}
            </span>
          ) : null}
          {failures.map((cli) => (
            <span key={cli.id}>
              {t("agentTools.detectProviderError", {
                provider: cli.name,
                error: cli.detectionError,
              })}
            </span>
          ))}
        </span>
      </InlineNotice>
    </div>
  );
}
