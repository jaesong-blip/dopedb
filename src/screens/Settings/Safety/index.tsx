// Per-connection SafetySettings editor. Loads via get_safety, saves via set_safety.
import { useEffect, useState } from "react";
import { getSafety, setSafety } from "../../../ipc/commands";
import type { SafetySettings } from "../../../ipc/types";
import { errMessage } from "../../../ipc/types";
import InfoTip from "../../../components/InfoTip";
import { useToast } from "../../../components/Toast";
import { Button } from "../../../design-system/components/Button";
import { SettingsGroup } from "../../../design-system/components/Settings";
import { StatusBadge } from "../../../design-system/components/Status";
import { useI18n, type I18nKey } from "../../../lib/i18n";
import MonitoringAccess from "./MonitoringAccess";

const TOGGLES: { key: keyof SafetySettings; label: I18nKey; hint: I18nKey }[] = [
  { key: "allowWrites", label: "safety.allowWrites", hint: "safety.allowWritesHint" },
  { key: "autoRunReads", label: "safety.autoRunReads", hint: "safety.autoRunReadsHint" },
  { key: "explainPreview", label: "safety.explainPreview", hint: "safety.explainPreviewHint" },
];

const NUMBERS: { key: keyof SafetySettings; label: I18nKey; hint: I18nKey }[] = [
  { key: "maxRows", label: "safety.maxRows", hint: "safety.maxRowsHint" },
  { key: "execPreviewRowLimit", label: "safety.execPreviewRowLimit", hint: "safety.execPreviewRowLimitHint" },
];

export default function Safety({ connectionId }: { connectionId: string }) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<SafetySettings | null>(null);
  const [msg, setMsg] = useState<string | null>(null); // load-failure only; save feedback goes through toast
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    let alive = true;
    setSettings(null);
    setMsg(null);
    getSafety(connectionId)
      .then((s) => {
        if (alive) setSettings(s);
      })
      .catch((e) => {
        if (alive) setMsg(errMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [connectionId]);

  if (!settings) {
    return (
      <div
        role={msg ? "alert" : "status"}
        className="tw:p-4 tw:text-muted-foreground"
      >
        {msg ?? t("safety.loading")}
      </div>
    );
  }

  function set<K extends keyof SafetySettings>(key: K, value: SafetySettings[K]) {
    setSettings((s) => (s ? { ...s, [key]: value } : s));
  }

  async function save() {
    if (!settings) return;
    setBusy(true);
    try {
      await setSafety(connectionId, settings);
      toast(t("safety.saved"));
    } catch (e) {
      toast(errMessage(e), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="tw:flex tw:w-full tw:max-w-[880px] tw:flex-col tw:gap-4 tw:max-[640px]:max-w-none">
      <div className="tw:flex tw:items-center tw:justify-between tw:gap-3 tw:max-[860px]:flex-col tw:max-[860px]:items-start">
        <div className="tw:inline-flex tw:items-center tw:gap-2 tw:max-[640px]:flex-col tw:max-[640px]:items-start">
          <h2>{t("safety.title")}</h2>
          <InfoTip label={t("safety.body")} />
        </div>
        <StatusBadge
          tone={settings.allowWrites ? "warning" : "success"}
        >
          {settings.allowWrites ? t("safety.modeWrites") : t("safety.modeReadOnly")}
        </StatusBadge>
      </div>

      <div className="tw:grid tw:grid-cols-[minmax(0,1.2fr)_minmax(264px,0.8fr)] tw:gap-4 tw:max-[1180px]:grid-cols-2 tw:max-[860px]:grid-cols-1">
        <SettingsGroup title={t("safety.guardrails")}>
          {TOGGLES.map((item) => (
            <label
              key={item.key}
              className="tw:grid tw:min-h-control-lg tw:grid-cols-[16px_minmax(0,1fr)_20px] tw:items-center tw:gap-2 tw:border-t tw:border-border-subtle tw:py-2 tw:first-of-type:border-t-0"
            >
              <input
                className="tw:m-0"
                type="checkbox"
                checked={settings[item.key] as boolean}
                onChange={(e) => set(item.key, e.target.checked as never)}
              />
              <span>
                <strong>{t(item.label)}</strong>
              </span>
              <InfoTip label={t(item.hint)} />
            </label>
          ))}
        </SettingsGroup>

        <SettingsGroup title={t("safety.limits")}>
          {NUMBERS.map((n) => (
            <label
              key={n.key}
              className="tw:grid tw:min-h-control-lg tw:grid-cols-[minmax(0,1fr)_120px_20px] tw:items-center tw:gap-2 tw:border-t tw:border-border-subtle tw:py-2 tw:first-of-type:border-t-0 tw:max-[640px]:grid-cols-1"
            >
              <span className="tw:text-sm tw:text-muted-foreground">
                {t(n.label)}
              </span>
              <input
                className="tw:w-full tw:bg-muted"
                type="number"
                min={n.key === "maxRows" ? 1 : 0}
                step={1}
                value={settings[n.key] as number}
                onChange={(e) => {
                  // Clamp to backend-enforced bounds; guard NaN from an empty field.
                  const raw = Math.floor(Number(e.target.value));
                  const v =
                    n.key === "maxRows"
                      ? Math.min(100000, Math.max(1, raw || 1))
                      : Math.min(1000000, Math.max(0, raw || 0));
                  set(n.key, v as never);
                }}
              />
              <InfoTip label={t(n.hint)} />
            </label>
          ))}
        </SettingsGroup>
      </div>

      <div className="tw:flex tw:justify-start tw:max-[640px]:[&>button]:w-full">
        <Button
          disabled={busy}
          onClick={save}
        >
          {busy ? t("common.saving") : t("common.save")}
        </Button>
      </div>

      <MonitoringAccess connectionId={connectionId} />
    </div>
  );
}
