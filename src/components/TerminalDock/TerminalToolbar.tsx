// Compact utility-dock toolbar for archive, activity, sizing, and close actions.
import type { RefObject } from "react";
import { Icon } from "../Icon";
import { useI18n } from "../../lib/i18n";

interface TerminalToolbarProps {
  sessionCount: number;
  unseen: number;
  maximized: boolean;
  archiveButtonRef: RefObject<HTMLButtonElement | null>;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
  onOpenArchive: () => void;
  onOpenActivity: () => void;
  onToggleMaximize: () => void;
  onClose: () => void;
}

export default function TerminalToolbar({
  sessionCount,
  unseen,
  maximized,
  archiveButtonRef,
  closeButtonRef,
  onOpenArchive,
  onOpenActivity,
  onToggleMaximize,
  onClose,
}: TerminalToolbarProps) {
  const { t } = useI18n();

  return (
    <header className="terminal-dock-toolbar ds-control-row">
      <div className="terminal-dock-title">
        <Icon name="terminal" />
        <strong>{t("terminal.title")}</strong>
        {sessionCount > 0 && (
          <span className="terminal-count">{sessionCount}</span>
        )}
      </div>
      <div className="terminal-dock-actions ds-control-row">
        <button
          ref={archiveButtonRef}
          type="button"
          className="btn small"
          onClick={onOpenArchive}
          title={t("terminal.openArchive")}
          aria-label={t("terminal.openArchive")}
        >
          <Icon name="history" />
        </button>
        <button
          type="button"
          className="btn small"
          onClick={onOpenActivity}
          title={t("terminal.operationActivity")}
          aria-label={t("terminal.operationActivity")}
        >
          <Icon name="list" />
          {unseen > 0 && (
            <span className="tab-dot">{unseen > 9 ? "9+" : unseen}</span>
          )}
        </button>
        <button
          type="button"
          className="btn small"
          onClick={onToggleMaximize}
          title={maximized ? t("terminal.restore") : t("terminal.maximize")}
          aria-label={
            maximized ? t("terminal.restore") : t("terminal.maximize")
          }
          aria-pressed={maximized}
        >
          <Icon name={maximized ? "minimize" : "maximize"} />
        </button>
        <button
          ref={closeButtonRef}
          type="button"
          className="btn small"
          onClick={onClose}
          title={t("common.close")}
          aria-label={t("common.close")}
        >
          <Icon name="close" />
        </button>
      </div>
    </header>
  );
}
