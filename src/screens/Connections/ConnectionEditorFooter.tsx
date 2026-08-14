// Presents the editor footer for profile and catalog modes.
import { Button } from "../../design-system/components/Button";
import { ModalFooter } from "../../design-system/components/Modal";
import type { ConnectionEditorController } from "../../features/connections/useConnectionEditorController";
import type { ConnectionEditorProps } from "../../features/connections/useConnectionEditorController";
import { useI18n } from "../../lib/i18n";

export function ConnectionEditorFooter({
  view,
  canEditConnection,
  hasBlockingProblems,
  commands,
  onCancel,
}: {
  view: ConnectionEditorController["catalog"]["navigation"]["view"];
  canEditConnection: boolean;
  hasBlockingProblems: boolean;
  commands: ConnectionEditorController["commands"];
  onCancel: ConnectionEditorProps["onCancel"];
}) {
  const { t } = useI18n();

  return (
    <ModalFooter>
      {view === "dataSources" ? (
        canEditConnection ? (
          <>
            <Button disabled={commands.busy} size="compact" onClick={onCancel}>
              {t("common.cancel")}
            </Button>
            <Button
              disabled={commands.busy || hasBlockingProblems}
              size="compact"
              onClick={() => void commands.save(false)}
            >
              {commands.running === "apply"
                ? t("common.saving")
                : t("common.apply")}
            </Button>
            <Button
              variant="primary"
              disabled={commands.busy || hasBlockingProblems}
              size="compact"
              onClick={() => void commands.save(true)}
            >
              {commands.running === "save"
                ? t("common.saving")
                : t("common.ok")}
            </Button>
          </>
        ) : (
          <Button variant="primary" size="compact" onClick={onCancel}>
            {t("common.ok")}
          </Button>
        )
      ) : (
        <>
          <Button size="compact" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button size="compact" variant="primary" onClick={onCancel}>
            {t("common.ok")}
          </Button>
        </>
      )}
    </ModalFooter>
  );
}
