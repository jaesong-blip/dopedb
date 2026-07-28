// DopeDB-style Data Sources and Drivers editor. Connection parsing and
// persistence stay in the feature layer; this screen composes Tailwind v4
// layout with canonical design-system form, tab, and tool-window primitives.
import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import EngineMark from "../../components/EngineMark";
import { Icon } from "../../components/Icon";
import InfoTip from "../../components/InfoTip";
import { useToast } from "../../components/Toast";
import {
  CheckboxField,
  Field,
  SelectInput,
  TextInput,
} from "../../design-system/components/FormControls";
import {
  PanelTabs,
  type PanelTab,
} from "../../design-system/components/PanelTabs";
import {
  ToolWindowAction,
  ToolWindowSection,
} from "../../design-system/components/ToolWindow";
import { parseConnectionUrl } from "../../features/connections/connectionUrl";
import type {
  ConnectionProfile,
  DriverDescriptor,
} from "../../features/connections/domain";
import {
  blankConnection,
  CONNECTION_DEFAULT_PORTS,
  type ConnectionLaunchPreset,
} from "../../features/connections/presets";
import { ProviderCredentialDialog } from "../../features/providers/ProviderCredentialDialog";
import type { ProviderKind } from "../../features/providers/domain";
import {
  installDriver,
  testConnectionProfile,
  upsertConnection,
} from "../../features/connections/tauriAdapter";
import { pickFile } from "../../ipc/commands";
import type { Engine, Provider } from "../../ipc/types";
import { errMessage } from "../../ipc/types";
import { isDocumentEngine } from "../../lib/capabilities";
import { useI18n } from "../../lib/i18n";
import { driversQuery } from "../../lib/queries";

const PROVIDER_ORDER: Provider[] = [
  "auto",
  "generic",
  "neon",
  "planetScale",
  "gcpCloudSql",
];

type ConnectionTab =
  | "general"
  | "options"
  | "sshSsl"
  | "schemas"
  | "advanced";

function compatibleDrivers(
  drivers: DriverDescriptor[],
  engine: Engine,
  provider: Provider,
): DriverDescriptor[] {
  return drivers.filter(
    (driver) =>
      driver.engine === engine &&
      (provider === "auto" ||
        driver.supportedProviders.includes(provider)),
  );
}

export function ConnectionForm({
  initial,
  preset,
  creatingDemo,
  onCreateDemoDatabase,
  onSaved,
  onCancel,
}: {
  initial: ConnectionProfile | null;
  preset: ConnectionLaunchPreset | null;
  creatingDemo: boolean;
  onCreateDemoDatabase: () => void;
  onSaved: (
    profile: ConnectionProfile,
    closeEditor: boolean,
  ) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const driverCatalog = useQuery(driversQuery());
  const [form, setForm] = useState<ConnectionProfile>(
    initial ?? blankConnection(preset),
  );
  const [password, setPassword] = useState("");
  const [activeTab, setActiveTab] =
    useState<ConnectionTab>("general");
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState<
    "save" | "apply" | "test" | null
  >(null);
  const [installingDriverId, setInstallingDriverId] = useState<
    string | null
  >(null);
  const [message, setMessage] = useState<string | null>(null);
  const [messageIsError, setMessageIsError] = useState(false);
  const [providerCredentialsOpen, setProviderCredentialsOpen] =
    useState<ProviderKind | null>(null);
  const providerReturnFocusRef = useRef<HTMLElement | null>(null);
  const isNew = initial === null;
  const isSqlite = form.engine === "sqlite";
  const isMongo = form.engine === "mongodb";
  const srv = form.extraParams.srv === "true";

  const drivers = compatibleDrivers(
    driverCatalog.data ?? [],
    form.engine,
    form.provider,
  );
  const activeDriver =
    drivers.find((driver) => driver.id === form.driverId) ??
    drivers.find((driver) => driver.recommended) ??
    drivers[0] ??
    null;
  const providers = PROVIDER_ORDER.filter(
    (provider) =>
      provider === "auto" ||
      provider === form.provider ||
      (driverCatalog.data ?? []).some(
        (driver) =>
          driver.engine === form.engine &&
          driver.supportedProviders.includes(provider),
      ),
  );
  const tabs: readonly PanelTab<ConnectionTab>[] = [
    { id: "general", label: t("connections.general") },
    { id: "options", label: t("connections.options") },
    { id: "sshSsl", label: t("connections.sshSsl") },
    {
      id: "schemas",
      label: t("connections.schemas"),
      disabled: isMongo,
    },
    { id: "advanced", label: t("connections.advanced") },
  ];
  const standardSources: Array<{
    engine: Engine;
    provider: Provider;
    label: string;
  }> = [
    { engine: "postgres", provider: "auto", label: "PostgreSQL" },
    { engine: "mysql", provider: "auto", label: "MySQL / MariaDB" },
    { engine: "sqlite", provider: "generic", label: "SQLite" },
    { engine: "mongodb", provider: "generic", label: "MongoDB" },
  ];
  const cloudProviders: Array<{
    provider: ProviderKind;
    label: string;
  }> = [
    {
      provider: "neon",
      label: t("connections.providerNeon"),
    },
    {
      provider: "gcpCloudSql",
      label: t("connections.providerGcpCloudSql"),
    },
    {
      provider: "planetScale",
      label: t("connections.providerPlanetScale"),
    },
  ];

  function set<K extends keyof ConnectionProfile>(
    key: K,
    value: ConnectionProfile[K],
  ) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function selectSource(
    engine: Engine,
    provider: Provider = "auto",
  ) {
    setForm((current) => ({
      ...current,
      engine,
      provider,
      driverId: null,
      port:
        current.port === CONNECTION_DEFAULT_PORTS[current.engine]
          ? CONNECTION_DEFAULT_PORTS[engine]
          : current.port,
      schemaGroup: isDocumentEngine(engine)
        ? null
        : current.schemaGroup,
    }));
    if (activeTab === "schemas" && isDocumentEngine(engine)) {
      setActiveTab("general");
    }
  }

  function openProviderCredentials(provider: ProviderKind) {
    providerReturnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setProviderCredentialsOpen(provider);
  }

  function setSrv(checked: boolean) {
    setForm((current) => {
      const extraParams = { ...current.extraParams };
      if (checked) extraParams.srv = "true";
      else delete extraParams.srv;
      return { ...current, extraParams };
    });
  }

  function setExtraParameter(key: string, value: string) {
    setForm((current) => {
      const extraParams = { ...current.extraParams };
      if (value) extraParams[key] = value;
      else delete extraParams[key];
      return { ...current, extraParams };
    });
  }

  function updateAdvancedParameter(
    index: number,
    nextKey: string,
    nextValue: string,
  ) {
    setForm((current) => {
      const entries = Object.entries(current.extraParams);
      entries[index] = [nextKey, nextValue];
      return {
        ...current,
        extraParams: Object.fromEntries(
          entries.filter(([key]) => key.trim().length > 0),
        ),
      };
    });
  }

  function addAdvancedParameter() {
    setForm((current) => {
      let suffix = 1;
      let key = "parameter";
      while (key in current.extraParams) {
        suffix += 1;
        key = `parameter${suffix}`;
      }
      return {
        ...current,
        extraParams: { ...current.extraParams, [key]: "" },
      };
    });
  }

  function removeAdvancedParameter(key: string) {
    setForm((current) => {
      const extraParams = { ...current.extraParams };
      delete extraParams[key];
      return { ...current, extraParams };
    });
  }

  function applyConnectionUrl(raw: string, showFeedback: boolean) {
    const parsed = parseConnectionUrl(raw);
    if (!parsed) return false;
    setForm((current) => ({
      ...current,
      ...parsed.update,
      id: current.id,
      secretRef: current.secretRef,
    }));
    if (parsed.password != null) setPassword(parsed.password);
    setMessage(null);
    setMessageIsError(false);
    if (showFeedback) {
      toast(t("connections.clipboardImported"));
    }
    return true;
  }

  async function importConnectionUrlFromClipboard(
    showFeedback = true,
  ) {
    if (!navigator.clipboard?.readText) {
      if (showFeedback) {
        toast(t("connections.clipboardUnavailable"), "error");
      }
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      const imported = applyConnectionUrl(text, showFeedback);
      if (!imported && showFeedback) {
        toast(t("connections.clipboardNoConnectionUrl"), "error");
      }
    } catch {
      if (showFeedback) {
        toast(t("connections.clipboardUnavailable"), "error");
      }
    }
  }

  async function save(closeEditor: boolean) {
    setBusy(true);
    setRunning(closeEditor ? "save" : "apply");
    setMessage(null);
    try {
      const saved = await upsertConnection(
        form,
        password || undefined,
      );
      setForm(saved);
      setPassword("");
      await onSaved(saved, closeEditor);
      toast(t("connections.connectionSaved"));
      setMessage(t("connections.saved"));
      setMessageIsError(false);
    } catch (error) {
      setMessage(errMessage(error));
      setMessageIsError(true);
    } finally {
      setBusy(false);
      setRunning(null);
    }
  }

  async function test() {
    setBusy(true);
    setRunning("test");
    setMessage(null);
    try {
      await testConnectionProfile(form, password || undefined);
      setMessage(`✓ ${t("connections.connectionOk")}`);
      setMessageIsError(false);
    } catch (error) {
      setMessage(errMessage(error));
      setMessageIsError(true);
    } finally {
      setBusy(false);
      setRunning(null);
    }
  }

  async function downloadDriver(driver: DriverDescriptor) {
    setInstallingDriverId(driver.id);
    setMessage(null);
    try {
      await installDriver(driver.id);
      await driverCatalog.refetch();
      setMessage(
        t("connections.driverInstalled", { name: driver.name }),
      );
      setMessageIsError(false);
    } catch (error) {
      setMessage(errMessage(error));
      setMessageIsError(true);
    } finally {
      setInstallingDriverId(null);
    }
  }

  function driverStatus(driver: DriverDescriptor): string {
    if (driver.installState === "planned") {
      return t("connections.driverPlanned");
    }
    if (driver.installMode === "bundled") {
      return t("connections.driverBundled");
    }
    if (driver.installState === "installed") {
      return t("connections.driverInstalledStatus");
    }
    return t("connections.driverDownloadRequired");
  }

  function providerLabel(provider: Provider): string {
    if (provider === "auto") return t("connections.providerAuto");
    if (provider === "generic") {
      return t("connections.providerGeneric");
    }
    if (provider === "neon") {
      return t("connections.providerNeon");
    }
    if (provider === "planetScale") {
      return t("connections.providerPlanetScale");
    }
    return t("connections.providerGcpCloudSql");
  }

  return (
    <div
      className="tw:flex tw:h-full tw:min-h-0 tw:flex-col tw:overflow-hidden tw:bg-background"
      onKeyDown={(event) => {
        if (
          event.key === "Enter" &&
          (event.target as HTMLElement).tagName === "INPUT" &&
          !busy
        ) {
          event.preventDefault();
          void save(true);
        } else if (event.key === "Escape") {
          onCancel();
        }
      }}
    >
      <header className="tw:flex tw:min-h-12 tw:shrink-0 tw:items-center tw:justify-between tw:gap-3 tw:border-b tw:border-border-subtle tw:bg-card tw:px-4">
        <div className="tw:flex tw:min-w-0 tw:items-center tw:gap-2">
          <Icon name="database" className="tw:text-info" />
          <h2 className="tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap">
            {t("connections.dataSourcesAndDrivers")}
          </h2>
          <span className="tw:text-sm tw:text-muted-foreground">
            — {isNew ? t("connections.new") : t("connections.edit")}
          </span>
        </div>
        <button
          type="button"
          className="btn small icon-only icon-xs"
          onClick={onCancel}
          title={t("common.close")}
          aria-label={t("common.close")}
        >
          <Icon name="close" />
        </button>
      </header>

      <div className="tw:flex tw:min-h-0 tw:flex-1">
        <aside className="tw:flex tw:w-[244px] tw:shrink-0 tw:flex-col tw:overflow-hidden tw:border-r tw:border-border-subtle tw:bg-card tw:@max-[760px]:hidden">
          <div className="tw:flex tw:min-h-control-lg tw:items-center tw:justify-between tw:border-b tw:border-border-subtle tw:px-3">
            <strong className="tw:text-sm">
              {t("connections.dataSources")}
            </strong>
            <div className="tw:flex tw:items-center tw:gap-1">
              <button
                type="button"
                className="btn small icon-only icon-xs"
                onClick={() => selectSource("postgres")}
                title={t("common.add")}
                aria-label={t("common.add")}
              >
                <Icon name="plus" />
              </button>
              {isNew ? (
                <button
                  type="button"
                  className="btn small icon-only icon-xs"
                  disabled={busy}
                  onClick={() =>
                    void importConnectionUrlFromClipboard(true)
                  }
                  title={t("connections.importClipboard")}
                  aria-label={t("connections.importClipboard")}
                >
                  <Icon name="copy" />
                </button>
              ) : null}
            </div>
          </div>
          <nav className="tw:min-h-0 tw:flex-1 tw:overflow-y-auto tw:p-2">
            <ToolWindowSection
              title={t("connections.createDataSource")}
            >
              {standardSources.map((source) => (
                <ToolWindowAction
                  key={`${source.engine}-${source.provider}`}
                  leading={<EngineMark engine={source.engine} />}
                  trailing={<Icon name="chevronRight" />}
                  selected={
                    form.engine === source.engine
                  }
                  onClick={() =>
                    selectSource(source.engine, source.provider)
                  }
                >
                  {source.label}
                </ToolWindowAction>
              ))}
            </ToolWindowSection>
            <div className="tw:h-5" />
            <ToolWindowSection
              title={t("connections.connectCloudProvider")}
            >
              {cloudProviders.map((provider) => (
                <ToolWindowAction
                  key={provider.provider}
                  leading={<Icon name="key" />}
                  trailing={<Icon name="chevronRight" />}
                  onClick={() =>
                    openProviderCredentials(provider.provider)
                  }
                >
                  {provider.label}
                </ToolWindowAction>
              ))}
            </ToolWindowSection>
            <div className="tw:h-5" />
            <ToolWindowSection
              title={t("connections.sampleDatabase")}
            >
              <ToolWindowAction
                leading={<EngineMark engine="sqlite" />}
                trailing={<Icon name="download" />}
                disabled={creatingDemo}
                onClick={onCreateDemoDatabase}
              >
                {creatingDemo
                  ? t("connections.demoCreating")
                  : t("connections.demoSqlite")}
              </ToolWindowAction>
            </ToolWindowSection>
          </nav>
        </aside>

        <section className="tw:flex tw:min-w-0 tw:flex-1 tw:flex-col tw:overflow-hidden">
          <div className="tw:grid tw:shrink-0 tw:grid-cols-[92px_minmax(0,1fr)] tw:items-center tw:gap-3 tw:border-b tw:border-border-subtle tw:bg-card tw:px-4 tw:py-3">
            <span className="tw:text-sm tw:text-muted-foreground">
              {t("connections.name")}
            </span>
            <TextInput
              value={form.name}
              onChange={(event) => set("name", event.target.value)}
              placeholder="prod-readonly"
              autoFocus
            />
          </div>

          <PanelTabs
            tabs={tabs}
            active={activeTab}
            onChange={setActiveTab}
            label={t("connections.tabList")}
          />

          <div className="tw:min-h-0 tw:flex-1 tw:overflow-y-auto tw:p-5">
            {activeTab === "general" ? (
              <div className="tw:mx-auto tw:grid tw:w-full tw:max-w-[840px] tw:gap-5">
                <section className="tw:grid tw:gap-3">
                  <h3>{t("connections.connection")}</h3>
                  <div className="tw:grid tw:grid-cols-2 tw:gap-3 tw:@max-[760px]:grid-cols-1">
                    <Field label={t("connections.engine")}>
                      <SelectInput
                        value={form.engine}
                        onChange={(event) =>
                          selectSource(event.target.value as Engine)
                        }
                      >
                        <option value="postgres">PostgreSQL</option>
                        <option value="mysql">
                          MySQL / MariaDB
                        </option>
                        <option value="sqlite">SQLite</option>
                        <option value="mongodb">MongoDB</option>
                      </SelectInput>
                    </Field>
                    <Field
                      label={t("connections.connectionMethod")}
                      hint={
                        <InfoTip
                          label={t(
                            "connections.connectionMethodHint",
                          )}
                        />
                      }
                    >
                      <SelectInput
                        value={form.provider}
                        onChange={(event) => {
                          const provider =
                            event.target.value as Provider;
                          setForm((current) => ({
                            ...current,
                            provider,
                            driverId: null,
                          }));
                        }}
                      >
                        {providers.map((provider) => (
                          <option key={provider} value={provider}>
                            {providerLabel(provider)}
                          </option>
                        ))}
                      </SelectInput>
                    </Field>
                  </div>

                  <div className="tw:grid tw:grid-cols-[minmax(0,1fr)_auto] tw:items-end tw:gap-3">
                    <Field
                      label={t("connections.driver")}
                      hint={
                        <InfoTip
                          label={t("connections.driverHint")}
                        />
                      }
                    >
                      <SelectInput
                        value={form.driverId ?? ""}
                        onChange={(event) =>
                          set(
                            "driverId",
                            event.target.value || null,
                          )
                        }
                        disabled={
                          driverCatalog.isPending ||
                          drivers.length === 0
                        }
                      >
                        <option value="">
                          {t("connections.driverAutomatic")}
                        </option>
                        {drivers.map((driver) => (
                          <option key={driver.id} value={driver.id}>
                            {driver.name} {driver.version}
                          </option>
                        ))}
                      </SelectInput>
                    </Field>
                    {activeDriver?.installMode === "managed" &&
                    activeDriver.installState === "available" ? (
                      <button
                        type="button"
                        className="btn"
                        disabled={installingDriverId !== null}
                        onClick={() =>
                          void downloadDriver(activeDriver)
                        }
                      >
                        <Icon name="download" />
                        {installingDriverId === activeDriver.id
                          ? t("connections.driverDownloading")
                          : t("connections.driverDownload")}
                      </button>
                    ) : null}
                  </div>

                  {activeDriver ? (
                    <div className="tw:flex tw:items-center tw:justify-between tw:gap-3 tw:rounded-sm tw:border tw:border-border-subtle tw:bg-card tw:px-3 tw:py-2">
                      <div className="tw:grid tw:gap-0.5">
                        <strong className="tw:text-ui">
                          {activeDriver.name}
                        </strong>
                        <span className="tw:text-xs tw:text-muted-foreground">
                          {activeDriver.version} ·{" "}
                          {driverStatus(activeDriver)}
                        </span>
                      </div>
                      <span
                        className={
                          activeDriver.installState === "installed"
                            ? "badge status-ok"
                            : "badge"
                        }
                      >
                        {driverStatus(activeDriver)}
                      </span>
                    </div>
                  ) : null}
                </section>

                <div className="tw:h-px tw:bg-border-subtle" />

                {isSqlite ? (
                  <section className="tw:grid tw:gap-3">
                    <h3>{t("connections.database")}</h3>
                    <div className="tw:grid tw:grid-cols-[minmax(0,1fr)_auto] tw:items-end tw:gap-2">
                      <Field
                        label={t("connections.databaseFile")}
                      >
                        <TextInput
                          value={form.database}
                          onChange={(event) =>
                            set("database", event.target.value)
                          }
                          placeholder="/path/to/app.db"
                        />
                      </Field>
                      <button
                        type="button"
                        className="btn"
                        onClick={() =>
                          void pickFile().then(
                            (file) =>
                              file && set("database", file),
                          )
                        }
                      >
                        {t("connections.browse")}
                      </button>
                    </div>
                  </section>
                ) : (
                  <>
                    <section className="tw:grid tw:gap-3">
                      <h3>{t("connections.connection")}</h3>
                      <div className="tw:grid tw:grid-cols-[minmax(0,1fr)_112px] tw:gap-3 tw:@max-[560px]:grid-cols-1">
                        <Field label={t("connections.host")}>
                          <TextInput
                            value={form.host}
                            onChange={(event) =>
                              set("host", event.target.value)
                            }
                          />
                        </Field>
                        <Field label={t("connections.port")}>
                          <TextInput
                            type="number"
                            value={form.port}
                            disabled={isMongo && srv}
                            onChange={(event) => {
                              if (event.target.value !== "") {
                                set(
                                  "port",
                                  Number(event.target.value),
                                );
                              }
                            }}
                          />
                        </Field>
                      </div>
                      <Field
                        label={t("connections.database")}
                        hint={
                          isMongo ? (
                            <InfoTip
                              label={t(
                                "connections.databaseRequiredHint",
                              )}
                            />
                          ) : null
                        }
                      >
                        <TextInput
                          value={form.database}
                          required={isMongo}
                          onChange={(event) =>
                            set("database", event.target.value)
                          }
                        />
                      </Field>
                      {isMongo ? (
                        <CheckboxField
                          label={t("connections.srv")}
                          checked={srv}
                          onChange={(event) =>
                            setSrv(event.target.checked)
                          }
                        />
                      ) : null}
                    </section>

                    <div className="tw:h-px tw:bg-border-subtle" />

                    <section className="tw:grid tw:gap-3">
                      <h3>{t("connections.authentication")}</h3>
                      <div className="tw:grid tw:grid-cols-2 tw:gap-3 tw:@max-[560px]:grid-cols-1">
                        <Field label={t("connections.user")}>
                          <TextInput
                            value={form.username}
                            onChange={(event) =>
                              set("username", event.target.value)
                            }
                          />
                        </Field>
                        <Field label={t("connections.password")}>
                          <TextInput
                            type="password"
                            value={password}
                            onChange={(event) =>
                              setPassword(event.target.value)
                            }
                            placeholder={
                              form.secretRef
                                ? `•••••• (${t(
                                    "connections.passwordStoredExisting",
                                  )})`
                                : t("connections.passwordStored")
                            }
                          />
                        </Field>
                      </div>
                    </section>
                  </>
                )}

                {isNew ? (
                  <div className="tw:flex tw:justify-end">
                    <button
                      type="button"
                      className="btn small"
                      disabled={busy}
                      onClick={() =>
                        void importConnectionUrlFromClipboard(true)
                      }
                    >
                      <Icon name="copy" />
                      {t("connections.importClipboard")}
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}

            {activeTab === "options" ? (
              <div className="tw:mx-auto tw:grid tw:w-full tw:max-w-[720px] tw:gap-5">
                <Field
                  label={t("connections.environment")}
                  hint={
                    <InfoTip
                      label={t("connections.environmentHint")}
                    />
                  }
                >
                  <SelectInput
                    value={form.env ?? ""}
                    onChange={(event) =>
                      set("env", event.target.value || null)
                    }
                  >
                    <option value="">{t("common.none")}</option>
                    <option value="dev">dev</option>
                    <option value="staging">staging</option>
                    <option value="prod">prod</option>
                  </SelectInput>
                </Field>
                <div className="tw:grid tw:gap-4 tw:border-y tw:border-border-subtle tw:py-4">
                  <div className="tw:grid tw:gap-1">
                    <CheckboxField
                      label={t("connections.readOnlyDefault")}
                      checked={form.readonlyDefault}
                      onChange={(event) =>
                        set(
                          "readonlyDefault",
                          event.target.checked,
                        )
                      }
                    />
                    <p className="tw:m-0 tw:pl-6 tw:text-sm tw:text-muted-foreground">
                      {t("connections.readOnlyDefaultBody")}
                    </p>
                  </div>
                  <div className="tw:grid tw:gap-1">
                    <CheckboxField
                      label={t("connections.allowWrites")}
                      checked={form.allowWrites}
                      onChange={(event) =>
                        set("allowWrites", event.target.checked)
                      }
                    />
                    <p className="tw:m-0 tw:pl-6 tw:text-sm tw:text-muted-foreground">
                      {t("connections.allowWritesBody")}
                    </p>
                  </div>
                </div>
                <div className="tw:flex tw:items-center tw:gap-2 tw:text-sm tw:text-muted-foreground">
                  <Icon name="info" />
                  <span>{t("connections.writeAccessHint")}</span>
                </div>
              </div>
            ) : null}

            {activeTab === "sshSsl" ? (
              <div className="tw:mx-auto tw:grid tw:w-full tw:max-w-[720px] tw:gap-5">
                <section className="tw:grid tw:gap-3">
                  <h3>{t("connections.sslConfiguration")}</h3>
                  {isSqlite ? (
                    <p className="tw:m-0 tw:text-sm tw:text-muted-foreground">
                      {t("connections.sqliteNoTls")}
                    </p>
                  ) : isMongo ? (
                    <p className="tw:m-0 tw:text-sm tw:text-muted-foreground">
                      {t("connections.mongoTlsAdvanced")}
                    </p>
                  ) : (
                    <>
                      <Field label={t("connections.sslMode")}>
                        <SelectInput
                          value={form.sslmode}
                          onChange={(event) =>
                            set("sslmode", event.target.value)
                          }
                        >
                          <option value="disable">disable</option>
                          <option value="prefer">prefer</option>
                          <option value="require">require</option>
                          <option value="verify-full">
                            verify-full
                          </option>
                        </SelectInput>
                      </Field>
                      <Field
                        label={t("connections.caCertificate")}
                      >
                        <TextInput
                          value={
                            form.extraParams.sslrootcert ?? ""
                          }
                          onChange={(event) =>
                            setExtraParameter(
                              "sslrootcert",
                              event.target.value,
                            )
                          }
                          placeholder="/path/to/ca.pem"
                        />
                      </Field>
                    </>
                  )}
                </section>
                <div className="tw:grid tw:grid-cols-[20px_minmax(0,1fr)] tw:gap-3 tw:rounded-sm tw:border tw:border-border-subtle tw:bg-card tw:p-3">
                  <Icon
                    name="info"
                    className="tw:mt-0.5 tw:text-info"
                  />
                  <div className="tw:grid tw:gap-1">
                    <strong>
                      {t("connections.sshUnsupportedTitle")}
                    </strong>
                    <p className="tw:m-0 tw:text-sm tw:leading-body tw:text-muted-foreground">
                      {t("connections.sshUnsupportedBody")}
                    </p>
                  </div>
                </div>
              </div>
            ) : null}

            {activeTab === "schemas" && !isMongo ? (
              <div className="tw:mx-auto tw:grid tw:w-full tw:max-w-[720px] tw:gap-3">
                <h3>{t("connections.schemas")}</h3>
                <p className="tw:m-0 tw:text-sm tw:leading-body tw:text-muted-foreground">
                  {t("connections.schemasBody")}
                </p>
                <Field label={t("connections.schemaGroup")}>
                  <TextInput
                    value={form.schemaGroup ?? ""}
                    onChange={(event) =>
                      set(
                        "schemaGroup",
                        event.target.value.trim() || null,
                      )
                    }
                    placeholder={t(
                      "connections.schemaGroupPlaceholder",
                    )}
                  />
                </Field>
              </div>
            ) : null}

            {activeTab === "advanced" ? (
              <div className="tw:mx-auto tw:grid tw:w-full tw:max-w-[840px] tw:gap-5">
                <section className="tw:grid tw:gap-3">
                  <div className="tw:flex tw:items-center tw:justify-between tw:gap-3">
                    <h3>
                      {t("connections.advancedParameters")}
                    </h3>
                    <button
                      type="button"
                      className="btn small"
                      onClick={addAdvancedParameter}
                    >
                      <Icon name="plus" />
                      {t("connections.addParameter")}
                    </button>
                  </div>
                  {Object.entries(form.extraParams).length ===
                  0 ? (
                    <p className="tw:m-0 tw:border-y tw:border-border-subtle tw:py-4 tw:text-sm tw:text-muted-foreground">
                      {t("connections.noParameters")}
                    </p>
                  ) : (
                    <div className="tw:grid tw:gap-2">
                      {Object.entries(form.extraParams).map(
                        ([key, value], index) => (
                          <div
                            key={`${index}-${key}`}
                            className="tw:grid tw:grid-cols-[minmax(140px,0.42fr)_minmax(0,1fr)_32px] tw:items-center tw:gap-2"
                          >
                            <TextInput
                              value={key}
                              aria-label={t(
                                "connections.parameterKey",
                              )}
                              onChange={(event) =>
                                updateAdvancedParameter(
                                  index,
                                  event.target.value,
                                  value,
                                )
                              }
                            />
                            <TextInput
                              value={value}
                              aria-label={t(
                                "connections.parameterValue",
                              )}
                              onChange={(event) =>
                                updateAdvancedParameter(
                                  index,
                                  key,
                                  event.target.value,
                                )
                              }
                            />
                            <button
                              type="button"
                              className="btn small icon-only icon-xs"
                              onClick={() =>
                                removeAdvancedParameter(key)
                              }
                              title={t("common.remove")}
                              aria-label={t("common.remove")}
                            >
                              <Icon name="close" />
                            </button>
                          </div>
                        ),
                      )}
                    </div>
                  )}
                </section>

                {activeDriver ? (
                  <section className="tw:grid tw:gap-3">
                    <h3>
                      {t("connections.driverCapabilities")}
                    </h3>
                    <div className="tw:flex tw:flex-wrap tw:gap-2">
                      {activeDriver.capabilities.map(
                        (capability) => (
                          <span
                            key={capability}
                            className="badge"
                          >
                            {capability}
                          </span>
                        ),
                      )}
                    </div>
                  </section>
                ) : null}
              </div>
            ) : null}
          </div>
        </section>
      </div>

      <footer
        className="tw:flex tw:min-h-[52px] tw:shrink-0 tw:items-center tw:gap-2 tw:border-t tw:border-border-subtle tw:bg-card tw:px-4"
        data-primary-flow
      >
        <button
          className="btn"
          disabled={busy}
          onClick={() => void test()}
        >
          {running === "test"
            ? t("connections.testing")
            : t("connections.test")}
        </button>
        {message ? (
          <span
            className={
              messageIsError
                ? "tw:min-w-0 tw:flex-1 tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap tw:text-sm tw:text-danger"
                : "tw:min-w-0 tw:flex-1 tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap tw:text-sm tw:text-success"
            }
            role={messageIsError ? "alert" : "status"}
            title={message}
          >
            {message}
          </span>
        ) : (
          <span className="tw:flex-1" />
        )}
        <button
          className="btn"
          disabled={busy}
          onClick={onCancel}
        >
          {t("common.cancel")}
        </button>
        <button
          className="btn"
          disabled={busy}
          onClick={() => void save(false)}
        >
          {running === "apply"
            ? t("common.saving")
            : t("common.apply")}
        </button>
        <button
          className="btn primary"
          disabled={busy}
          onClick={() => void save(true)}
        >
          {running === "save"
            ? t("common.saving")
            : t("common.ok")}
        </button>
      </footer>
      {providerCredentialsOpen ? (
        <ProviderCredentialDialog
          initialProvider={providerCredentialsOpen}
          onClose={() => setProviderCredentialsOpen(null)}
          returnFocus={() => providerReturnFocusRef.current?.focus()}
        />
      ) : null}
    </div>
  );
}
