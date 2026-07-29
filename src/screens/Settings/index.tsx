// Settings shell for agent tools, command-line, safety, language, and updates.
// Kept outside the data tabs so navigation remains focused on the selected database.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import type { ConnectionProfile } from "../../features/connections/domain";
import { Icon } from "../../components/Icon";
import InfoTip from "../../components/InfoTip";
import { Button } from "../../design-system/components/Button";
import {
  Field,
  SelectInput,
} from "../../design-system/components/FormControls";
import {
  ModalBackdrop,
  ModalFooter,
  ModalSurface,
  ModalTitleBar,
} from "../../design-system/components/Modal";
import { TreeSearch } from "../../design-system/components/TreeControls";
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

type SettingsScope = "application" | "dataSource";

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
  const [filter, setFilter] = useState("");
  const settingsEntries = useMemo(
    () =>
      [
        {
          id: "agent-tools",
          label: t("settings.agentTools"),
          scope: "application",
          disabled: false,
          keywords: "agent codex claude tools",
        },
        {
          id: "cli",
          label: t("settings.cli"),
          scope: "application",
          disabled: false,
          keywords: "command line terminal path cli",
        },
        {
          id: "archive",
          label: t("settings.retiredArchive"),
          scope: "application",
          disabled: false,
          keywords: "chat history archive conversation",
        },
        {
          id: "language",
          label: t("settings.languageTitle"),
          scope: "application",
          disabled: false,
          keywords: "locale korean english",
        },
        {
          id: "updates",
          label: t("settings.updates"),
          scope: "application",
          disabled: false,
          keywords: "version release upgrade",
        },
        {
          id: "safety",
          label: `${t("settings.safety")}${
            connection
              ? ` · ${connection.name || t("app.unnamed")}`
              : ""
          }`,
          scope: "dataSource",
          disabled: !connection,
          keywords: "read only write approval policy audit",
        },
      ] satisfies ReadonlyArray<{
        id: SettingsSection;
        label: string;
        scope: SettingsScope;
        disabled: boolean;
        keywords: string;
      }>,
    [connection, t],
  );
  const filteredEntries = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase().normalize("NFKC");
    if (!query) return settingsEntries;
    return settingsEntries.filter((entry) =>
      `${entry.label} ${entry.keywords}`
        .toLocaleLowerCase()
        .normalize("NFKC")
        .includes(query),
    );
  }, [filter, settingsEntries]);
  const filteredIds = filteredEntries
    .map((entry) => entry.id)
    .join(":");

  useEffect(() => {
    if (!filter || filteredEntries.some((entry) => entry.id === section)) {
      return;
    }
    const next = filteredEntries.find((entry) => !entry.disabled);
    if (next) setSection(next.id);
  }, [filter, filteredEntries, filteredIds, section]);

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

  const activeEntry =
    settingsEntries.find((entry) => entry.id === section) ??
    settingsEntries[0];

  return (
    <ModalBackdrop>
      <ModalSurface
        size="settings"
        aria-labelledby="settings-dialog-title"
      >
        <div
          data-settings
          className="tw:flex tw:h-full tw:min-h-0 tw:flex-col tw:bg-background"
        >
          <ModalTitleBar
            title={t("common.settings")}
            titleId="settings-dialog-title"
            closeLabel={t("common.close")}
            onClose={close}
          />

          <div className="tw:grid tw:min-h-0 tw:flex-1 tw:grid-cols-[300px_minmax(0,1fr)] tw:@max-[700px]:grid-cols-1 tw:@max-[700px]:grid-rows-[auto_minmax(0,1fr)]">
            <aside className="tw:flex tw:min-h-0 tw:flex-col tw:border-r tw:border-border-subtle tw:bg-card tw:py-2 tw:@max-[700px]:max-h-[188px] tw:@max-[700px]:border-r-0 tw:@max-[700px]:border-b">
              <div className="tw:px-2 tw:py-1">
                <TreeSearch
                  value={filter}
                  autoFocus
                  placeholder={t("settings.searchPlaceholder")}
                  clearLabel={t("common.close")}
                  onChange={setFilter}
                  onEscape={() => {
                    if (filter) setFilter("");
                    else close();
                  }}
                />
              </div>
              <nav className="tw:min-h-0 tw:flex-1 tw:overflow-y-auto tw:pt-2">
                {(["application", "dataSource"] as const).map((scope) => {
                  const entries = filteredEntries.filter(
                    (entry) => entry.scope === scope,
                  );
                  if (entries.length === 0) return null;
                  return (
                    <section
                      key={scope}
                      className="tw:grid tw:gap-0.5 tw:pb-2"
                    >
                      <div className="tw:flex tw:min-h-control-sm tw:items-center tw:gap-1 tw:px-2 tw:text-ui tw:font-semibold">
                        <Icon
                          name="chevronDown"
                          className="tw:text-muted-foreground"
                        />
                        <span>
                          {t(
                            scope === "application"
                              ? "settings.scopeApplication"
                              : "settings.scopeDataSource",
                          )}
                        </span>
                      </div>
                      {entries.map((entry) => (
                        <button
                          key={entry.id}
                          type="button"
                          data-active={section === entry.id}
                          className="tw:min-h-control-sm tw:cursor-pointer tw:rounded-none tw:border-0 tw:bg-transparent tw:pr-3 tw:pl-8 tw:font-sans tw:text-left tw:text-ui tw:text-foreground tw:data-[active=true]:bg-selection tw:data-[active=true]:text-selection-foreground tw:disabled:cursor-default tw:disabled:opacity-50 tw:not-disabled:hover:bg-muted"
                          onClick={() => setSection(entry.id)}
                          disabled={entry.disabled}
                          title={
                            entry.id === "safety" && !connection
                              ? t("settings.selectConnectionTitle")
                              : undefined
                          }
                        >
                          {entry.label}
                        </button>
                      ))}
                    </section>
                  );
                })}
                {filteredEntries.length === 0 ? (
                  <p className="tw:m-0 tw:px-3 tw:py-4 tw:text-sm tw:text-muted-foreground">
                    {t("settings.noSearchResults")}
                  </p>
                ) : null}
              </nav>
            </aside>

            <section className="tw:flex tw:min-h-0 tw:min-w-0 tw:flex-col">
              <div className="tw:flex tw:h-[42px] tw:min-h-[42px] tw:shrink-0 tw:items-center tw:gap-2 tw:border-b tw:border-border-subtle tw:bg-card tw:px-4 tw:text-ui tw:font-semibold">
                <span className="tw:text-muted-foreground">
                  {t(
                    activeEntry?.scope === "dataSource"
                      ? "settings.scopeDataSource"
                      : "settings.scopeApplication",
                  )}
                </span>
                <Icon
                  name="chevronRight"
                  className="tw:text-muted-foreground"
                />
                <span>{activeEntry?.label}</span>
              </div>
              <div className="tw:min-h-0 tw:min-w-0 tw:flex-1 tw:overflow-auto tw:p-[var(--ds-pane-pad)] tw:[container-name:settings-body] tw:[container-type:inline-size] tw:@max-[700px]:p-3">
                {section === "agent-tools" && <AgentTools />}
                {section === "cli" && <CliSettings />}
                {section === "archive" && (
                  <RetiredChatArchive connection={connection} />
                )}
                {section === "updates" && (
                  <Updates
                    initialUpdate={availableUpdate}
                    onChecked={onUpdateChecked}
                  />
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
                        onChange={(e) =>
                          setLang(e.target.value as typeof lang)
                        }
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
            </section>
          </div>

          <ModalFooter>
            <Button
              size="compact"
              variant="primary"
              onClick={close}
            >
              {t("common.done")}
            </Button>
          </ModalFooter>
        </div>
      </ModalSurface>
    </ModalBackdrop>
  );
}
