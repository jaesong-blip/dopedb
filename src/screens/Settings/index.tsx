// Settings shell for agent tools, command-line, safety, language, and updates.
// Kept outside the data tabs so navigation remains focused on the selected database.
import { useEffect, useRef, useState } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import type { ConnectionProfile } from "../../features/connections/domain";
import InfoTip from "../../components/InfoTip";
import {
  Field,
  SelectInput,
} from "../../design-system/components/FormControls";
import { useI18n } from "../../lib/i18n";
import AgentTools from "./AgentTools";
import CliSettings from "./Cli";
import RetiredChatArchive from "./RetiredChatArchive";
import Safety from "./Safety";
import Updates from "./Updates";

export type SettingsSection =
  | "agent-tools"
  | "archive"
  | "cli"
  | "safety"
  | "updates"
  | "language";

export default function Settings({
  connection,
  onClose,
  refreshSafety,
  initialSection,
  availableUpdate,
  onUpdateChecked,
}: {
  connection: ConnectionProfile | null;
  onClose: () => void;
  // Re-loads the App's per-connection safety so Safety edits apply without reselecting.
  refreshSafety: () => void;
  initialSection?: SettingsSection;
  availableUpdate?: Update | null;
  onUpdateChecked?: (update: Update | null) => void;
}) {
  const { lang, setLang, t } = useI18n();
  const [section, setSection] = useState<SettingsSection>(
    initialSection ?? "agent-tools",
  );

  // Safety may have changed while this menu was open — refresh App's copy on the way out.
  function close() {
    refreshSafety();
    onClose();
  }

  // Esc closes the overlay, matching other full-screen overlays. Ref keeps the handler
  // pinned to the latest close() (refreshSafety side-effect) without re-binding.
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Don't hijack Escape while a field has focus — close() reloads Safety and would
      // discard unsaved edits. Let the input's own Escape (blur/revert) win instead.
      if ((e.target as HTMLElement)?.closest("input, textarea, select")) return;
      closeRef.current();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  return (
    <div
      data-settings
      className="tw:grid tw:h-full tw:min-h-0 tw:grid-cols-[192px_minmax(0,1fr)] tw:@max-[700px]:grid-cols-1 tw:@max-[700px]:grid-rows-[auto_minmax(0,1fr)]"
    >
      <aside className="tw:flex tw:flex-col tw:gap-0.5 tw:border-r tw:border-border-subtle tw:p-2 tw:@max-[700px]:flex-row tw:@max-[700px]:items-center tw:@max-[700px]:overflow-x-auto tw:@max-[700px]:border-r-0 tw:@max-[700px]:border-b">
        <div className="tw:flex tw:items-center tw:justify-between tw:px-2 tw:pt-2 tw:pb-3 tw:@max-[700px]:shrink-0 tw:@max-[700px]:gap-2 tw:@max-[700px]:py-1">
          <strong>{t("common.settings")}</strong>
          <button className="btn small" onClick={close}>
            {t("common.done")}
          </button>
        </div>
        {(
          [
            ["agent-tools", t("settings.agentTools"), false],
            ["cli", t("settings.cli"), false],
            ["archive", t("settings.retiredArchive"), false],
            [
              "safety",
              `${t("settings.safety")}${
                connection ? ` · ${connection.name || t("app.unnamed")}` : ""
              }`,
              !connection,
            ],
            ["language", t("settings.languageTitle"), false],
            ["updates", t("settings.updates"), false],
          ] satisfies ReadonlyArray<
            readonly [SettingsSection, string, boolean]
          >
        ).map(([id, label, disabled]) => (
          <button
            key={id}
            type="button"
            data-active={section === id}
            className="tw:shrink-0 tw:cursor-pointer tw:rounded-sm tw:border-0 tw:bg-transparent tw:px-3 tw:py-2 tw:font-sans tw:text-left tw:text-ui tw:text-foreground tw:whitespace-nowrap tw:data-[active=true]:bg-selection tw:data-[active=true]:text-selection-foreground tw:disabled:cursor-default tw:disabled:opacity-50 tw:not-disabled:hover:bg-muted"
            onClick={() => setSection(id)}
            disabled={disabled}
            title={
              id === "safety" && !connection
                ? t("settings.selectConnectionTitle")
                : undefined
            }
          >
            {label}
          </button>
        ))}
      </aside>

      <div className="tw:min-w-0 tw:overflow-auto tw:p-[var(--ds-pane-pad)] tw:[container-name:settings-body] tw:[container-type:inline-size] tw:@max-[700px]:p-3">
        {section === "agent-tools" && <AgentTools />}
        {section === "cli" && <CliSettings />}
        {section === "archive" && <RetiredChatArchive connection={connection} />}
        {section === "updates" && (
          <Updates initialUpdate={availableUpdate} onChecked={onUpdateChecked} />
        )}
        {section === "language" && (
          <div className="tw:grid tw:max-w-[560px] tw:gap-4 tw:p-4">
            <div className="tw:inline-flex tw:items-center tw:gap-2">
              <h2>{t("settings.languageTitle")}</h2>
              <InfoTip label={t("settings.languageBody")} />
            </div>
            <Field label={t("language.label")}>
              <SelectInput
                value={lang}
                onChange={(e) => setLang(e.target.value as typeof lang)}
              >
                <option value="ko">{t("language.korean")}</option>
                <option value="en">{t("language.english")}</option>
              </SelectInput>
            </Field>
          </div>
        )}
        {section === "safety" &&
          (connection ? (
            <Safety connectionId={connection.id} />
          ) : (
            <div className="tw:text-muted-foreground">
              {t("settings.selectConnection")}
            </div>
          ))}
      </div>
    </div>
  );
}
