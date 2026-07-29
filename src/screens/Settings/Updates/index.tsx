import { useEffect, useMemo, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { Icon, type IconName } from "../../../components/Icon";
import InfoTip from "../../../components/InfoTip";
import { errMessage } from "../../../ipc/types";
import { useI18n } from "../../../lib/i18n";

type UpdateState =
  | "idle"
  | "checking"
  | "available"
  | "current"
  | "downloading"
  | "ready"
  | "error";

function bytes(n: number | null) {
  if (n == null || !Number.isFinite(n)) return null;
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function pct(done: number, total: number | null) {
  if (!total || total <= 0) return null;
  return Math.min(100, Math.round((done / total) * 100));
}

function stateIcon(state: UpdateState): IconName {
  switch (state) {
    case "checking":
      return "refresh";
    case "available":
    case "downloading":
      return "download";
    case "current":
    case "ready":
      return "check";
    case "error":
      return "alert";
    case "idle":
    default:
      return "info";
  }
}

export default function Updates({
  initialUpdate = null,
  onChecked,
}: {
  initialUpdate?: Update | null;
  onChecked?: (update: Update | null) => void;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<UpdateState>(initialUpdate ? "available" : "idle");
  const [currentVersion, setCurrentVersion] = useState<string>(t("common.unknown"));
  const [update, setUpdate] = useState<Update | null>(initialUpdate);
  const [error, setError] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState(0);
  const [contentLength, setContentLength] = useState<number | null>(null);

  async function refresh() {
    setState("checking");
    setError(null);
    setDownloaded(0);
    setContentLength(null);
    try {
      const [version, next] = await Promise.all([getVersion(), check()]);
      setCurrentVersion(version);
      setUpdate(next);
      onChecked?.(next);
      setState(next ? "available" : "current");
    } catch (e) {
      setUpdate(null);
      setState("error");
      setError(errMessage(e));
    }
  }

  async function install() {
    if (!update) return;
    setState("downloading");
    setError(null);
    setDownloaded(0);
    setContentLength(null);
    try {
      await update.downloadAndInstall((event: DownloadEvent) => {
        if (event.event === "Started") {
          setContentLength(event.data.contentLength ?? null);
          setDownloaded(0);
        } else if (event.event === "Progress") {
          setDownloaded((n) => n + event.data.chunkLength);
        } else if (event.event === "Finished") {
          setState("ready");
        }
      });
      setState("ready");
      await relaunch();
    } catch (e) {
      setState("error");
      setError(errMessage(e));
    }
  }

  useEffect(() => {
    let alive = true;
    void getVersion().then((version) => {
      if (alive) setCurrentVersion(version);
    });
    if (!initialUpdate) void refresh();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!initialUpdate) return;
    setUpdate(initialUpdate);
    setState("available");
    setError(null);
  }, [initialUpdate]);

  const progress = useMemo(() => pct(downloaded, contentLength), [downloaded, contentLength]);
  const releaseNotes = update?.body?.trim();
  const stateLabel =
    state === "available"
      ? t("updates.available")
      : state === "current"
        ? t("updates.current")
        : state === "checking"
          ? t("updates.checking")
          : state === "downloading"
            ? t("updates.downloading")
            : state === "ready"
              ? t("updates.ready")
              : state === "error"
                ? t("updates.error")
                : t("updates.idle");

  return (
    <div className="tw:w-full tw:max-w-[720px] tw:p-4 tw:max-[760px]:max-w-none">
      <div className="tw:mb-3 tw:flex tw:items-start tw:justify-between tw:gap-4 tw:max-[760px]:flex-col tw:max-[760px]:items-stretch">
        <div className="tw:inline-flex tw:items-center tw:gap-2">
          <h2>{t("updates.title")}</h2>
          <InfoTip label={t("updates.description")} />
        </div>
        <button className="btn small" disabled={state === "checking" || state === "downloading"} onClick={refresh}>
          {t("updates.checkAgain")}
        </button>
      </div>

      <div className="tw:grid tw:border-t tw:border-border-subtle">
        <div className="tw:flex tw:min-h-control-lg tw:items-center tw:justify-between tw:gap-4 tw:border-b tw:border-border-subtle tw:py-2 tw:max-[760px]:flex-col tw:max-[760px]:items-start tw:max-[760px]:gap-1">
          <span className="tw:text-muted-foreground">{t("updates.installedVersion")}</span>
          <strong>{currentVersion}</strong>
        </div>
        <div className="tw:flex tw:min-h-control-lg tw:items-center tw:justify-between tw:gap-4 tw:border-b tw:border-border-subtle tw:py-2 tw:max-[760px]:flex-col tw:max-[760px]:items-start tw:max-[760px]:gap-1">
          <span className="tw:text-muted-foreground">{t("updates.latestRelease")}</span>
          <strong>
            {update
              ? update.version
              : state === "checking"
                ? t("updates.checking")
                : t("updates.none")}
          </strong>
        </div>
        <div className="tw:flex tw:min-h-control-lg tw:items-center tw:justify-between tw:gap-4 tw:border-b tw:border-border-subtle tw:py-2 tw:max-[760px]:flex-col tw:max-[760px]:items-start tw:max-[760px]:gap-1">
          <span className="tw:text-muted-foreground">{t("updates.status")}</span>
          <span
            data-state={state}
            className="badge icon-only-badge tw:text-muted-foreground tw:data-[state=available]:border-success tw:data-[state=available]:text-success tw:data-[state=ready]:border-success tw:data-[state=ready]:text-success tw:data-[state=error]:border-danger tw:data-[state=error]:text-danger"
            title={stateLabel}
            aria-label={stateLabel}
            role="img"
          >
            <Icon name={stateIcon(state)} />
          </span>
        </div>

        {state === "downloading" && (
          <div className="tw:grid tw:gap-2 tw:border-b tw:border-border-subtle tw:py-3">
            <div className="tw:h-2 tw:w-full tw:overflow-hidden tw:rounded-full tw:border tw:border-border-subtle tw:bg-muted">
              <span
                className="tw:block tw:h-full tw:min-w-3 tw:rounded-full tw:bg-primary tw:transition-[width] tw:duration-200"
                style={{ width: `${progress ?? 12}%` }}
              />
            </div>
            <div className="tw:text-muted-foreground">
              {progress == null
                ? t("updates.received", {
                    amount: bytes(downloaded) ?? t("updates.downloadingFallback"),
                  })
                : `${progress}% (${bytes(downloaded)} / ${bytes(contentLength)})`}
            </div>
          </div>
        )}

        {releaseNotes && (
          <details className="tw:border-b tw:border-border-subtle tw:py-3">
            <summary className="tw:cursor-pointer tw:text-muted-foreground">
              {t("updates.releaseNotes")}
            </summary>
            <pre className="tw:mt-2 tw:mb-0 tw:font-mono tw:text-sm tw:whitespace-pre-wrap tw:text-foreground">
              {releaseNotes}
            </pre>
          </details>
        )}

        {error && (
          <div className="tw:border-b tw:border-border-subtle tw:py-3 tw:text-ui tw:text-danger">
            {t("updates.checkFailed", { error })}
          </div>
        )}

        <div className="ds-action-row ds-control-row tw:pt-3">
          <button
            className="btn primary"
            disabled={!update || state === "checking" || state === "downloading"}
            onClick={install}
          >
            {state === "downloading" ? t("updates.installing") : t("updates.updateAndRelaunch")}
          </button>
          <a className="btn" href="https://github.com/json-choi/dopedb/releases/latest">
            {t("updates.openReleases")}
          </a>
        </div>
      </div>
    </div>
  );
}
