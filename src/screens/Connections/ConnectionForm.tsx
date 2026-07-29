// DopeDB-style Data Sources and Drivers editor. Connection parsing and
// persistence stay in the feature layer; this screen composes Tailwind v4
// layout with canonical design-system form, tab, and tool-window primitives.
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import ConfirmButton from "../../components/ConfirmButton";
import EngineMark from "../../components/EngineMark";
import { Icon } from "../../components/Icon";
import InfoTip from "../../components/InfoTip";
import { useToast } from "../../components/Toast";
import {
  CommandMenu,
  CommandMenuGroup,
  CommandMenuItem,
} from "../../design-system/components/CommandMenu";
import { Button } from "../../design-system/components/Button";
import {
  DiagnosticCount,
  DiagnosticSummary,
  type DiagnosticItem,
} from "../../design-system/components/Diagnostics";
import {
  CheckboxField,
  Field,
  FieldValidationMessage,
  InlineSelect,
  PropertyRow,
  SelectInput,
  TextAreaInput,
  TextInput,
  type FieldValidation,
} from "../../design-system/components/FormControls";
import {
  ModalBackdrop,
  ModalDetailActionBar,
  ModalFooter,
  ModalSurface,
  ModalTitleBar,
} from "../../design-system/components/Modal";
import {
  PanelTabs,
  type PanelTab,
} from "../../design-system/components/PanelTabs";
import { SegmentedControl } from "../../design-system/components/SegmentedControl";
import { StatusBadge } from "../../design-system/components/Status";
import { TreeSearch } from "../../design-system/components/TreeControls";
import {
  ToolWindowAction,
  ToolWindowSearchRow,
  ToolWindowSection,
} from "../../design-system/components/ToolWindow";
import {
  formatConnectionUrl,
  parseConnectionUrl,
} from "../../features/connections/connectionUrl";
import {
  diagnoseConnection,
  type ConnectionDiagnosticCode,
} from "../../features/connections/diagnostics";
import type {
  ConnectionProfile,
  DriverDescriptor,
} from "../../features/connections/domain";
import { connectionId } from "../../features/connections/domain";
import {
  CONNECTION_AUTO_DISCONNECT_MAX_SECONDS,
  CONNECTION_AUTO_DISCONNECT_MIN_SECONDS,
  CONNECTION_AUTO_DISCONNECT_SECONDS_PARAMETER,
  CONNECTION_INPUT_MODE_PARAMETER,
  CONNECTION_KEEP_ALIVE_MAX_SECONDS,
  CONNECTION_KEEP_ALIVE_MIN_SECONDS,
  CONNECTION_KEEP_ALIVE_SECONDS_PARAMETER,
  CONNECTION_SSH_ALIAS_PARAMETER,
  CONNECTION_STARTUP_SCRIPT_MAX_LENGTH,
  CONNECTION_STARTUP_SCRIPT_PARAMETER,
  CONNECTION_TIME_ZONE_PARAMETER,
  connectionOption,
  isConnectionOptionParameter,
  isConnectionOptionSupported,
} from "../../features/connections/options";
import {
  blankConnection,
  CONNECTION_DEFAULT_PORTS,
  connectionDefaultSslMode,
  isDemoSqliteConnection,
  type ConnectionLaunchPreset,
} from "../../features/connections/presets";
import { ProviderCredentialDialog } from "../../features/providers/ProviderCredentialDialog";
import type { ProviderKind } from "../../features/providers/domain";
import WorkspaceConnectionDialog from "../../features/workspaces/components/WorkspaceConnectionDialog";
import {
  deleteWorkspaceConnection,
  updateWorkspaceConnection,
} from "../../features/workspaces/tauriAdapter";
import {
  isIntrospectionParameter,
  nextSchemaScopeSelection,
  OBJECT_PATTERN_PARAMETER,
  relationNamespace,
  SCHEMA_SCOPE_PARAMETER,
  selectedSchemaScope,
} from "../../features/catalogExplorer/scopeFilter";
import {
  deleteConnection,
  installDriver,
  testConnection,
  testConnectionProfile,
  upsertConnection,
} from "../../features/connections/tauriAdapter";
import { pickFile } from "../../ipc/commands";
import type { Engine, Provider } from "../../ipc/types";
import { errMessage } from "../../ipc/types";
import { isDocumentEngine } from "../../lib/capabilities";
import { useI18n } from "../../lib/i18n";
import {
  catalogOverviewQuery,
  driversQuery,
  useCatalogScope,
} from "../../lib/queries";

type ConnectionEditorView = "dataSources" | "clouds" | "drivers";
type ConnectionInputMode = "default" | "urlOnly";

const POSTGRES_SSL_MODES = [
  "disable",
  "allow",
  "prefer",
  "require",
  "verify-ca",
  "verify-full",
] as const;

const MYSQL_SSL_MODES = [
  "disabled",
  "preferred",
  "required",
  "verify-ca",
  "verify-identity",
] as const;

const SQL_TLS_PARAMETERS = [
  "sslrootcert",
  "sslrootcert_pem",
  "sslcert",
  "sslcert_pem",
  "sslkey",
  "sslkey_pem",
] as const;

const MONGO_TLS_PARAMETERS = [
  "tls",
  "tlsCAFile",
  "tlsCertificateKeyFile",
] as const;

const CONTROLLED_CONNECTION_PARAMETERS = new Set<string>([
  ...SQL_TLS_PARAMETERS,
  ...MONGO_TLS_PARAMETERS,
  CONNECTION_SSH_ALIAS_PARAMETER,
  CONNECTION_INPUT_MODE_PARAMETER,
  CONNECTION_TIME_ZONE_PARAMETER,
  CONNECTION_KEEP_ALIVE_SECONDS_PARAMETER,
  CONNECTION_AUTO_DISCONNECT_SECONDS_PARAMETER,
  CONNECTION_STARTUP_SCRIPT_PARAMETER,
  "srv",
]);

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

function sslModeForEngine(engine: Engine, current: string): string {
  const normalized = current.trim().toLowerCase().replace(/_/g, "-");
  if (engine === "postgres") {
    const mapped =
      normalized === "disabled"
        ? "disable"
        : normalized === "preferred"
          ? "prefer"
          : normalized === "required"
            ? "require"
            : normalized === "verify-identity"
              ? "verify-full"
              : normalized;
    return POSTGRES_SSL_MODES.includes(
      mapped as (typeof POSTGRES_SSL_MODES)[number],
    )
      ? mapped
      : connectionDefaultSslMode(engine);
  }
  if (engine === "mysql") {
    const mapped =
      normalized === "disable"
        ? "disabled"
        : normalized === "prefer"
          ? "preferred"
          : normalized === "require"
            ? "required"
            : normalized === "verify-full"
              ? "verify-identity"
              : normalized;
    return MYSQL_SSL_MODES.includes(
      mapped as (typeof MYSQL_SSL_MODES)[number],
    )
      ? mapped
      : connectionDefaultSslMode(engine);
  }
  return connectionDefaultSslMode(engine);
}

export function ConnectionForm({
  initial,
  preset,
  connections,
  creatingDemo,
  onCreateDemoDatabase,
  onNewConnection,
  onEditConnection,
  onDeletedConnection,
  onSaved,
  onCancel,
}: {
  initial: ConnectionProfile | null;
  preset: ConnectionLaunchPreset | null;
  connections: ConnectionProfile[];
  creatingDemo: boolean;
  onCreateDemoDatabase: () => void;
  onNewConnection: (preset?: ConnectionLaunchPreset) => void;
  onEditConnection: (connection: ConnectionProfile) => void;
  onDeletedConnection: (id: string) => Promise<void>;
  onSaved: (
    profile: ConnectionProfile,
    closeEditor: boolean,
  ) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const driverCatalog = useQuery(driversQuery());
  const catalogScope = useCatalogScope();
  const [form, setForm] = useState<ConnectionProfile>(() => {
    const profile = initial ?? blankConnection(preset);
    return {
      ...profile,
      sslmode: sslModeForEngine(profile.engine, profile.sslmode),
    };
  });
  const [isNew, setIsNew] = useState(initial === null);
  const [persisted, setPersisted] = useState(initial !== null);
  const [password, setPassword] = useState("");
  const [connectionInputMode, setConnectionInputMode] =
    useState<ConnectionInputMode>(
      form.extraParams[CONNECTION_INPUT_MODE_PARAMETER] === "urlOnly"
        ? "urlOnly"
        : "default",
    );
  const [connectionUrlDraft, setConnectionUrlDraft] = useState(() =>
    formatConnectionUrl(form),
  );
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
    useState<ProviderKind | "all" | null>(null);
  const [editorView, setEditorView] =
    useState<ConnectionEditorView>("dataSources");
  const [sourceSearch, setSourceSearch] = useState("");
  const [driverSearch, setDriverSearch] = useState("");
  const [catalogSearchOpen, setCatalogSearchOpen] = useState(false);
  const [catalogCloudProvider, setCatalogCloudProvider] =
    useState<ProviderKind>("neon");
  const [catalogDriverId, setCatalogDriverId] = useState<string | null>(
    null,
  );
  const [workspaceDialogMode, setWorkspaceDialogMode] = useState<
    "copy" | "credentials" | null
  >(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [addSearch, setAddSearch] = useState("");
  const [problemsOpen, setProblemsOpen] = useState(false);
  const addMenuAnchorRef = useRef<HTMLDivElement | null>(null);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const workspaceButtonRef = useRef<HTMLButtonElement | null>(null);
  const providerReturnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (initial !== null || preset !== null) return;
    const frame = window.requestAnimationFrame(() => {
      setAddMenuOpen(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [initial, preset]);

  const isSqlite = form.engine === "sqlite";
  const isMongo = form.engine === "mongodb";
  const isSharedTemplate = form.workspaceAccess !== "local";
  const canEditConnection =
    !isSharedTemplate || form.workspaceAccess === "manage";
  const supportsSqlSessionOptions =
    form.engine === "postgres" || form.engine === "mysql";
  const supportsStartupScript = supportsSqlSessionOptions;
  const keepAliveEnabled =
    CONNECTION_KEEP_ALIVE_SECONDS_PARAMETER in form.extraParams;
  const autoDisconnectEnabled =
    CONNECTION_AUTO_DISCONNECT_SECONDS_PARAMETER in form.extraParams;
  const srv = form.extraParams.srv === "true";
  const mongoTlsEnabled =
    form.extraParams.tls?.toLowerCase() === "true";
  const sqlSslModes =
    form.engine === "mysql"
      ? MYSQL_SSL_MODES
      : POSTGRES_SSL_MODES;
  const sqlTlsEnabled = !["disable", "disabled"].includes(
    form.sslmode,
  );
  const schemaDiscovery = useQuery({
    ...catalogOverviewQuery(form.id, catalogScope),
    enabled:
      persisted &&
      activeTab === "schemas" &&
      !isSharedTemplate &&
      !isMongo &&
      catalogScope.ready,
  });
  const discoveredSchemas = Array.from(
    new Set(
      [
        ...(schemaDiscovery.data?.namespaces ?? []),
        ...(schemaDiscovery.data?.relations
          .map((relation) =>
            relationNamespace(form, relation.schema),
          )
          .filter(Boolean) ?? []),
      ],
    ),
  ).sort((left, right) => left.localeCompare(right));
  const discoveredSchemaRelationCounts = new Map<string, number>();
  for (const relation of schemaDiscovery.data?.relations ?? []) {
    const namespace = relationNamespace(form, relation.schema);
    discoveredSchemaRelationCounts.set(
      namespace,
      (discoveredSchemaRelationCounts.get(namespace) ?? 0) + 1,
    );
  }
  const scopedSchemas = selectedSchemaScope(form);
  const advancedParameters = Object.entries(form.extraParams).filter(
    ([key]) =>
      !isIntrospectionParameter(key) &&
      !CONTROLLED_CONNECTION_PARAMETERS.has(key),
  );

  const drivers = compatibleDrivers(
    driverCatalog.data ?? [],
    form.engine,
    form.provider,
  );
  const activeDriver = form.driverId
    ? drivers.find((driver) => driver.id === form.driverId) ?? null
    : drivers.find((driver) => driver.recommended) ??
      drivers[0] ??
      null;
  const normalizedSourceSearch = sourceSearch.trim().toLocaleLowerCase();
  const visibleConnections = normalizedSourceSearch
    ? connections.filter((connection) =>
        [
          connection.name,
          connection.engine,
          connection.provider,
          connection.host,
          connection.database,
        ].some((value) =>
          value.toLocaleLowerCase().includes(normalizedSourceSearch),
        ),
      )
    : connections;
  const normalizedDriverSearch = driverSearch.trim().toLocaleLowerCase();
  const visibleCatalogDrivers = (driverCatalog.data ?? []).filter(
    (driver) =>
      normalizedDriverSearch.length === 0 ||
      [
        driver.name,
        driver.engine,
        driver.version,
        ...driver.supportedProviders,
        ...driver.capabilities,
      ].some((value) =>
        value.toLocaleLowerCase().includes(normalizedDriverSearch),
      ),
  );
  const catalogDriver =
    visibleCatalogDrivers.find(
      (driver) => driver.id === catalogDriverId,
    ) ??
    visibleCatalogDrivers.find(
      (driver) => driver.id === activeDriver?.id,
    ) ??
    visibleCatalogDrivers[0] ??
    null;
  const diagnosticProfile = isSharedTemplate
    ? { ...form, extraParams: {} }
    : form;
  const connectionDiagnostics = diagnoseConnection(
    diagnosticProfile,
    connections,
    driverCatalog.data ?? [],
    driverCatalog.isError,
    driverCatalog.isPending,
  );
  const parsedConnectionUrl =
    !isSharedTemplate && connectionInputMode === "urlOnly"
      ? parseConnectionUrl(connectionUrlDraft)
      : null;
  const connectionUrlInvalid =
    !isSharedTemplate &&
    connectionInputMode === "urlOnly" &&
    parsedConnectionUrl === null;
  const hasBlockingProblems =
    connectionUrlInvalid ||
    connectionDiagnostics.some(
      (diagnostic) => diagnostic.tone === "danger",
    );
  const problemItems: DiagnosticItem[] = connectionDiagnostics.map(
    (diagnostic) => ({
      id: diagnostic.id,
      tone: diagnostic.tone,
      title: diagnosticMessage(diagnostic.code),
    }),
  );
  if (connectionUrlInvalid) {
    problemItems.push({
      id: "connection-url-invalid",
      tone: "danger",
      title: t("connections.problemConnectionUrlInvalid"),
    });
  }
  if (messageIsError && message) {
    problemItems.push({
      id: "connection-runtime",
      tone: "danger",
      title: t("connections.problemRuntime"),
      description: message,
    });
  }
  const nameValidation = fieldValidation("connection-name");
  const driverValidation = fieldValidation("connection-driver");
  const hostValidation = fieldValidation("connection-host");
  const portValidation = fieldValidation("connection-port");
  const databaseValidation = fieldValidation("connection-database");
  const timeZoneValidation = fieldValidation("connection-time-zone");
  const keepAliveValidation = fieldValidation(
    "connection-keep-alive",
  );
  const autoDisconnectValidation = fieldValidation(
    "connection-auto-disconnect",
  );
  const startupScriptValidation = fieldValidation(
    "connection-startup-script",
  );
  const sshAliasValidation = fieldValidation(
    "connection-ssh-alias",
  );
  const connectionUrlValidation: FieldValidation | undefined =
    connectionUrlInvalid
      ? {
          tone: "danger",
          message: t("connections.problemConnectionUrlInvalid"),
        }
      : undefined;
  const tabs: readonly PanelTab<ConnectionTab>[] = isSharedTemplate
    ? [{ id: "general", label: t("connections.general") }]
    : [
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
    category: "database" | "file";
  }> = [
    {
      engine: "postgres",
      provider: "auto",
      label: "PostgreSQL",
      category: "database",
    },
    {
      engine: "mysql",
      provider: "auto",
      label: "MySQL / MariaDB",
      category: "database",
    },
    {
      engine: "mongodb",
      provider: "generic",
      label: "MongoDB",
      category: "database",
    },
    {
      engine: "sqlite",
      provider: "generic",
      label: "SQLite",
      category: "file",
    },
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
  const normalizedAddSearch = addSearch.trim().toLocaleLowerCase();
  const matchesAddSearch = (...values: string[]) =>
    normalizedAddSearch.length === 0 ||
    values.some((value) =>
      value.toLocaleLowerCase().includes(normalizedAddSearch),
    );
  const filteredDatabaseSources = standardSources.filter(
    (source) =>
      source.category === "database" &&
      matchesAddSearch(
        source.label,
        source.engine,
        t("connections.database"),
        "sql",
        sourceDriverDescription(source),
      ),
  );
  const filteredFileSources = standardSources.filter(
    (source) =>
      source.category === "file" &&
      matchesAddSearch(
        source.label,
        source.engine,
        t("connections.fileAndSample"),
        "file",
        sourceDriverDescription(source),
      ),
  );
  const filteredCloudProviders = cloudProviders.filter((provider) =>
    matchesAddSearch(
      provider.label,
      provider.provider,
      t("connections.clouds"),
      t("connections.dataSourceFromCloudProvider"),
      "cloud",
    ),
  );
  const demoMatches = matchesAddSearch(
    t("connections.demoSqlite"),
    t("connections.sampleDatabase"),
    "demo sqlite",
    "sample",
  );
  const hasAddResults =
    filteredDatabaseSources.length > 0 ||
    filteredFileSources.length > 0 ||
    filteredCloudProviders.length > 0 ||
    demoMatches;

  useEffect(() => {
    if (!addMenuOpen) return;
    function closeOnOutsidePointer(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !addMenuAnchorRef.current?.contains(event.target)
      ) {
        setAddMenuOpen(false);
      }
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () =>
      document.removeEventListener(
        "pointerdown",
        closeOnOutsidePointer,
      );
  }, [addMenuOpen]);

  function set<K extends keyof ConnectionProfile>(
    key: K,
    value: ConnectionProfile[K],
  ) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function diagnosticMessage(
    code: ConnectionDiagnosticCode,
  ): string {
    switch (code) {
      case "nameRequired":
        return t("connections.problemNameRequired");
      case "duplicateName":
        return t("connections.problemDuplicateName");
      case "hostRequired":
        return t("connections.problemHostRequired");
      case "hostInvalid":
        return t("connections.problemHostInvalid");
      case "portInvalid":
        return t("connections.problemPortInvalid");
      case "sqliteFileRequired":
        return t("connections.problemSqliteFileRequired");
      case "mongoDatabaseRequired":
        return t("connections.problemMongoDatabaseRequired");
      case "timeZoneInvalid":
        return t("connections.problemTimeZoneInvalid");
      case "keepAliveInvalid":
        return t("connections.problemKeepAliveInvalid");
      case "autoDisconnectInvalid":
        return t("connections.problemAutoDisconnectInvalid");
      case "startupScriptTooLong":
        return t("connections.problemStartupScriptTooLong");
      case "sshAliasInvalid":
        return t("connections.problemSshAliasInvalid");
      case "sshTunnelSingleHostRequired":
        return t(
          "connections.problemSshTunnelSingleHostRequired",
        );
      case "sshTunnelSrvUnsupported":
        return t("connections.problemSshTunnelSrvUnsupported");
      case "driverCatalogUnavailable":
        return t(
          "connections.problemDriverCatalogUnavailable",
        );
      case "driverUnavailable":
        return t("connections.problemDriverUnavailable");
      case "driverInstallRequired":
        return t("connections.problemDriverInstallRequired");
    }
  }

  function fieldValidation(
    fieldId: string,
  ): FieldValidation | undefined {
    const diagnostic = connectionDiagnostics.find(
      (candidate) => candidate.fieldId === fieldId,
    );
    return diagnostic
      ? {
          tone: diagnostic.tone,
          message: diagnosticMessage(diagnostic.code),
        }
      : undefined;
  }

  function openDiagnostic(diagnosticId: string) {
    if (diagnosticId === "connection-url-invalid") {
      setProblemsOpen(false);
      setActiveTab("general");
      requestAnimationFrame(() =>
        document.getElementById("connection-url")?.focus(),
      );
      return;
    }
    const diagnostic = connectionDiagnostics.find(
      (candidate) => candidate.id === diagnosticId,
    );
    if (!diagnostic) return;
    setProblemsOpen(false);
    setActiveTab(diagnostic.tab);
    if (diagnostic.fieldId) {
      const fieldId = diagnostic.fieldId;
      requestAnimationFrame(() =>
        document.getElementById(fieldId)?.focus(),
      );
    }
  }

  function selectSource(
    engine: Engine,
    provider: Provider = "auto",
  ) {
    setForm((current) => {
      const extraParams = { ...current.extraParams };
      if (isDocumentEngine(engine)) {
        delete extraParams[SCHEMA_SCOPE_PARAMETER];
        delete extraParams[OBJECT_PATTERN_PARAMETER];
        delete extraParams[CONNECTION_TIME_ZONE_PARAMETER];
        delete extraParams[CONNECTION_STARTUP_SCRIPT_PARAMETER];
        delete extraParams[CONNECTION_KEEP_ALIVE_SECONDS_PARAMETER];
      }
      if (engine === "sqlite") {
        delete extraParams[CONNECTION_TIME_ZONE_PARAMETER];
        delete extraParams[CONNECTION_KEEP_ALIVE_SECONDS_PARAMETER];
        delete extraParams[CONNECTION_STARTUP_SCRIPT_PARAMETER];
        delete extraParams[CONNECTION_SSH_ALIAS_PARAMETER];
      }
      if (engine === "mongodb" || engine === "sqlite") {
        for (const key of SQL_TLS_PARAMETERS) delete extraParams[key];
      }
      if (engine !== "mongodb") {
        for (const key of MONGO_TLS_PARAMETERS) delete extraParams[key];
      }
      return {
        ...current,
        engine,
        provider,
        extraParams,
        sslmode: sslModeForEngine(engine, current.sslmode),
        driverId: null,
        port:
          current.port === CONNECTION_DEFAULT_PORTS[current.engine]
            ? CONNECTION_DEFAULT_PORTS[engine]
            : current.port,
        schemaGroup: isDocumentEngine(engine)
          ? null
          : current.schemaGroup,
      };
    });
    if (activeTab === "schemas" && isDocumentEngine(engine)) {
      setActiveTab("general");
    }
  }

  function selectAddSource(
    source: (typeof standardSources)[number],
  ) {
    setAddMenuOpen(false);
    setAddSearch("");
    if (isNew) {
      selectSource(source.engine, source.provider);
      return;
    }
    onNewConnection({
      engine: source.engine,
      provider: source.provider,
      source: "standard",
    });
  }

  function sourceDriverDescription(
    source: (typeof standardSources)[number],
  ): string {
    const compatible = compatibleDrivers(
      driverCatalog.data ?? [],
      source.engine,
      source.provider,
    );
    const driver =
      compatible.find((candidate) => candidate.recommended) ??
      compatible[0];
    return driver
      ? `${driver.name} ${driver.version}`
      : t("connections.driverCatalogLoading");
  }

  function openProviderCredentials(
    provider?: ProviderKind,
    returnFocus?: HTMLElement | null,
  ) {
    providerReturnFocusRef.current =
      returnFocus ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);
    setProviderCredentialsOpen(provider ?? "all");
  }

  function setSrv(checked: boolean) {
    setForm((current) => {
      const extraParams = { ...current.extraParams };
      if (checked) extraParams.srv = "true";
      else delete extraParams.srv;
      return { ...current, extraParams };
    });
  }

  function setMongoTls(checked: boolean) {
    setForm((current) => {
      const extraParams = { ...current.extraParams };
      if (checked) {
        extraParams.tls = "true";
      } else {
        for (const key of MONGO_TLS_PARAMETERS) delete extraParams[key];
      }
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

  function toggleTimedConnectionOption(
    key: string,
    checked: boolean,
    defaultSeconds: number,
  ) {
    setExtraParameter(key, checked ? String(defaultSeconds) : "");
  }

  function setTimedConnectionOptionValue(
    key: string,
    value: string,
  ) {
    setForm((current) => ({
      ...current,
      extraParams: {
        ...current.extraParams,
        [key]: value,
      },
    }));
  }

  async function pickExtraParameterFile(key: string) {
    const file = await pickFile();
    if (file) setExtraParameter(key, file);
  }

  function updateAdvancedParameter(
    currentKey: string,
    nextKey: string,
    nextValue: string,
  ) {
    setForm((current) => {
      const extraParams = { ...current.extraParams };
      delete extraParams[currentKey];
      if (nextKey.trim()) extraParams[nextKey] = nextValue;
      return {
        ...current,
        extraParams,
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

  function setSchemaScope(schemas: string[]) {
    setExtraParameter(
      SCHEMA_SCOPE_PARAMETER,
      schemas.length > 0 ? JSON.stringify(schemas) : "",
    );
  }

  function toggleSchemaScope(schema: string, checked: boolean) {
    setSchemaScope(
      nextSchemaScopeSelection(
        discoveredSchemas,
        scopedSchemas,
        schema,
        checked,
      ),
    );
  }

  function selectConnectionInputMode(mode: ConnectionInputMode) {
    if (mode === connectionInputMode) return;
    if (mode === "urlOnly") {
      setConnectionUrlDraft(formatConnectionUrl(form));
    }
    setForm((current) => {
      const extraParams = { ...current.extraParams };
      if (mode === "urlOnly") {
        extraParams[CONNECTION_INPUT_MODE_PARAMETER] = "urlOnly";
      } else {
        delete extraParams[CONNECTION_INPUT_MODE_PARAMETER];
      }
      return { ...current, extraParams };
    });
    setConnectionInputMode(mode);
    setMessage(null);
    setMessageIsError(false);
  }

  function applyConnectionUrl(
    raw: string,
    showFeedback: boolean,
    normalizeDraft = false,
    inputMode = connectionInputMode,
  ) {
    const parsed = parseConnectionUrl(raw);
    if (!parsed) return false;
    const parsedEngine = parsed.update.engine ?? form.engine;
    const internalExtraParams = Object.fromEntries(
      Object.entries(form.extraParams).filter(
        ([key]) =>
          (!isDocumentEngine(parsedEngine) &&
            isIntrospectionParameter(key)) ||
          (isConnectionOptionParameter(key) &&
            isConnectionOptionSupported(key, parsedEngine)),
      ),
    );
    if (inputMode === "urlOnly") {
      internalExtraParams[CONNECTION_INPUT_MODE_PARAMETER] = "urlOnly";
    }
    const nextForm: ConnectionProfile = {
      ...form,
      ...parsed.update,
      name:
        normalizeDraft && !form.name.trim()
          ? (parsed.update.name ?? form.name)
          : form.name,
      extraParams: {
        ...internalExtraParams,
        ...(parsed.update.extraParams ?? {}),
      },
      id: form.id,
      secretRef: form.secretRef,
    };
    setForm(nextForm);
    if (parsed.password != null) setPassword(parsed.password);
    if (normalizeDraft) {
      setConnectionUrlDraft(formatConnectionUrl(nextForm));
    }
    setMessage(null);
    setMessageIsError(false);
    if (showFeedback) {
      toast(t("connections.clipboardImported"));
    }
    return true;
  }

  function editConnectionUrl(raw: string) {
    setConnectionUrlDraft(raw);
    applyConnectionUrl(raw, false);
  }

  function normalizeConnectionUrl(raw = connectionUrlDraft) {
    applyConnectionUrl(raw, false, true);
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
      const imported = applyConnectionUrl(
        text,
        showFeedback,
        true,
        "urlOnly",
      );
      if (imported) setConnectionInputMode("urlOnly");
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
    if (hasBlockingProblems) {
      setProblemsOpen(true);
      return;
    }
    setBusy(true);
    setRunning(closeEditor ? "save" : "apply");
    setMessage(null);
    try {
      const saved = isSharedTemplate
        ? await updateWorkspaceConnection({
            ...form,
            readonlyDefault: true,
            allowWrites: false,
          })
        : await upsertConnection(form, password || undefined);
      setForm(saved);
      if (connectionInputMode === "urlOnly") {
        setConnectionUrlDraft(formatConnectionUrl(saved));
      }
      setIsNew(false);
      setPersisted(true);
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

  function duplicateCurrentConnection() {
    if (isNew || form.workspaceAccess !== "local") return;
    setForm((current) => {
      const extraParams = { ...current.extraParams };
      delete extraParams[CONNECTION_INPUT_MODE_PARAMETER];
      return {
        ...current,
        id: connectionId(crypto.randomUUID()),
        name: t("connections.copyName", {
          name: current.name || t("app.unnamed"),
        }),
        extraParams,
        secretRef: null,
        workspaceAccess: "local",
        credentialMode: "local",
      };
    });
    setIsNew(true);
    setPersisted(false);
    setPassword("");
    setConnectionInputMode("default");
    setConnectionUrlDraft("");
    setActiveTab("general");
    setMessage(null);
    setMessageIsError(false);
    toast(t("connections.connectionDuplicated"));
  }

  async function removeCurrentConnection() {
    if (
      isNew ||
      (isSharedTemplate && form.workspaceAccess !== "manage")
    ) {
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      if (isSharedTemplate) {
        await deleteWorkspaceConnection(form.id);
      } else {
        await deleteConnection(form.id);
      }
      toast(t("connections.connectionDeleted"));
      await onDeletedConnection(form.id);
      onCancel();
    } catch (error) {
      setMessage(errMessage(error));
      setMessageIsError(true);
      setBusy(false);
    }
  }

  async function test() {
    if (hasBlockingProblems) {
      setProblemsOpen(true);
      return;
    }
    setBusy(true);
    setRunning("test");
    setMessage(null);
    try {
      if (isSharedTemplate) {
        await testConnection(form.id);
      } else {
        await testConnectionProfile(form, password || undefined);
      }
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
    <ModalBackdrop>
      <ModalSurface
        size="dataSources"
        aria-labelledby="connection-editor-title"
        aria-busy={busy}
      >
        <div
          className="tw:flex tw:h-full tw:min-h-0 tw:flex-col tw:overflow-hidden tw:bg-background"
          onKeyDown={(event) => {
            const target = event.target as HTMLInputElement;
            if (
              event.key === "Enter" &&
              target.id === "connection-url" &&
              !busy
            ) {
              event.preventDefault();
              normalizeConnectionUrl(target.value);
            } else if (
              event.key === "Enter" &&
              target.tagName === "INPUT" &&
              target.type !== "search" &&
              !busy
            ) {
              event.preventDefault();
              void save(true);
            } else if (event.key === "Escape") {
              if (addMenuOpen) {
                event.stopPropagation();
                setAddMenuOpen(false);
                setAddSearch("");
                addButtonRef.current?.focus();
              } else {
                onCancel();
              }
            }
          }}
        >
      <ModalTitleBar
        title={t("connections.dataSourcesAndDrivers")}
        titleId="connection-editor-title"
        closeLabel={t("common.close")}
        onClose={onCancel}
      />

      <div className="tw:flex tw:min-h-0 tw:flex-1 tw:@max-[760px]:flex-col">
        <div className="tw:hidden tw:shrink-0 tw:justify-center tw:border-b tw:border-border-subtle tw:bg-card tw:p-2 tw:@max-[760px]:flex">
          <SegmentedControl
            value={editorView}
            options={[
              {
                value: "dataSources",
                label: t("connections.dataSources"),
              },
              {
                value: "clouds",
                label: t("connections.clouds"),
              },
              {
                value: "drivers",
                label: t("connections.drivers"),
              },
            ]}
            label={t("connections.dataSourceCatalogNavigation")}
            onChange={setEditorView}
          />
        </div>
        <aside className="tw:flex tw:w-[258px] tw:shrink-0 tw:flex-col tw:overflow-visible tw:border-r tw:border-border-subtle tw:bg-card tw:@max-[760px]:hidden">
          <PanelTabs
            tabs={[
              {
                id: "dataSources",
                label: t("connections.dataSources"),
              },
              {
                id: "clouds",
                label: t("connections.clouds"),
              },
              {
                id: "drivers",
                label: t("connections.drivers"),
              },
            ]}
            active={editorView}
            onChange={setEditorView}
            label={t("connections.dataSourceCatalogNavigation")}
          />
          <div className="tw:flex tw:h-control-lg tw:min-h-control-lg tw:items-center tw:border-b tw:border-border-subtle tw:px-3">
            {editorView === "dataSources" ? (
              <div className="tw:flex tw:items-center tw:gap-1">
                <div
                  ref={addMenuAnchorRef}
                  className="tw:relative tw:flex"
                >
                  <Button
                    ref={addButtonRef}
                    iconOnly
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      setAddSearch("");
                      setAddMenuOpen((open) => !open);
                    }}
                    title={t("common.add")}
                    aria-label={t("common.add")}
                    aria-haspopup="dialog"
                    aria-expanded={addMenuOpen}
                    aria-controls="connection-add-menu"
                  >
                    <Icon name="plus" />
                  </Button>
                  {addMenuOpen ? (
                    <CommandMenu
                      id="connection-add-menu"
                      label={t("connections.addDataSourceMenu")}
                      searchLabel={t(
                        "connections.addDataSourceSearchLabel",
                      )}
                      searchPlaceholder={t(
                        "connections.addDataSourceSearchPlaceholder",
                      )}
                      searchValue={addSearch}
                      onSearchChange={setAddSearch}
                    >
                    {filteredDatabaseSources.length > 0 ? (
                      <CommandMenuGroup
                        title={t("connections.database")}
                      >
                        {filteredDatabaseSources.map((source) => (
                          <CommandMenuItem
                            key={`${source.engine}-${source.provider}`}
                            leading={
                              <EngineMark engine={source.engine} />
                            }
                            trailing={<Icon name="chevronRight" />}
                            description={sourceDriverDescription(
                              source,
                            )}
                            onClick={() => selectAddSource(source)}
                          >
                            {source.label}
                          </CommandMenuItem>
                        ))}
                      </CommandMenuGroup>
                    ) : null}
                    {filteredFileSources.length > 0 ||
                    demoMatches ? (
                      <CommandMenuGroup
                        title={t("connections.fileAndSample")}
                      >
                        {filteredFileSources.map((source) => (
                          <CommandMenuItem
                            key={`${source.engine}-${source.provider}`}
                            leading={
                              <EngineMark engine={source.engine} />
                            }
                            trailing={<Icon name="chevronRight" />}
                            description={sourceDriverDescription(
                              source,
                            )}
                            onClick={() => selectAddSource(source)}
                          >
                            {source.label}
                          </CommandMenuItem>
                        ))}
                        {demoMatches ? (
                          <CommandMenuItem
                            leading={<EngineMark engine="sqlite" />}
                            trailing={<Icon name="download" />}
                            description={t(
                              "connections.demoDescription",
                            )}
                            disabled={creatingDemo}
                            onClick={() => {
                              setAddMenuOpen(false);
                              setAddSearch("");
                              onCreateDemoDatabase();
                            }}
                          >
                            {creatingDemo
                              ? t("connections.demoCreating")
                              : t("connections.demoSqlite")}
                          </CommandMenuItem>
                        ) : null}
                      </CommandMenuGroup>
                    ) : null}
                    {filteredCloudProviders.length > 0 ? (
                      <CommandMenuGroup
                        title={t(
                          "connections.dataSourceFromCloudProvider",
                        )}
                      >
                        {filteredCloudProviders.map((provider) => (
                          <CommandMenuItem
                            key={provider.provider}
                            leading={<Icon name="key" />}
                            trailing={<Icon name="chevronRight" />}
                            description={t(
                              "connections.cloudCredentialDescription",
                            )}
                            onClick={() => {
                              setAddMenuOpen(false);
                              setAddSearch("");
                              openProviderCredentials(
                                provider.provider,
                                addButtonRef.current,
                              );
                            }}
                          >
                            {provider.label}
                          </CommandMenuItem>
                        ))}
                      </CommandMenuGroup>
                    ) : null}
                    {!hasAddResults ? (
                      <p className="tw:px-2 tw:py-5 tw:text-center tw:text-sm tw:text-muted-foreground">
                        {t("connections.noDataSourceResults")}
                      </p>
                    ) : null}
                  </CommandMenu>
                ) : null}
              </div>
              {!isNew && form.workspaceAccess === "local" ? (
                <>
                  <Button
                    ref={workspaceButtonRef}
                    iconOnly
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setWorkspaceDialogMode("copy")}
                    title={t("workspace.copyToWorkspace")}
                    aria-label={t("workspace.copyToWorkspace")}
                  >
                    <Icon name="upload" />
                  </Button>
                  <Button
                    iconOnly
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    onClick={duplicateCurrentConnection}
                    title={t("connections.duplicate")}
                    aria-label={t("connections.duplicate")}
                  >
                    <Icon name="copy" />
                  </Button>
                  <ConfirmButton
                    disabled={busy}
                    iconOnly
                    label={t("common.delete")}
                    size="xs"
                    variant="ghost"
                    confirmLabel={t(
                      isDemoSqliteConnection(form)
                        ? "connections.reallyDeleteDemo"
                        : "common.reallyDelete",
                    )}
                    onConfirm={() =>
                      void removeCurrentConnection()
                    }
                  >
                    <Icon name="trash" />
                  </ConfirmButton>
                </>
              ) : null}
              {!isNew &&
              isSharedTemplate &&
              form.credentialMode === "memberLocal" &&
              form.workspaceAccess !== "view" ? (
                <Button
                  ref={workspaceButtonRef}
                  iconOnly
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    setWorkspaceDialogMode("credentials")
                  }
                  title={t("workspace.bindCredentialsShort")}
                  aria-label={t("workspace.bindCredentialsShort")}
                >
                  <Icon name="key" />
                </Button>
              ) : null}
              {!isNew && form.workspaceAccess === "manage" ? (
                <ConfirmButton
                  disabled={busy}
                  iconOnly
                  label={t("common.delete")}
                  size="xs"
                  variant="ghost"
                  confirmLabel={t("common.reallyDelete")}
                  onConfirm={() => void removeCurrentConnection()}
                >
                  <Icon name="trash" />
                </ConfirmButton>
              ) : null}
              {isNew ? (
                <Button
                  iconOnly
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void importConnectionUrlFromClipboard(true)
                  }
                  title={t("connections.importClipboard")}
                  aria-label={t("connections.importClipboard")}
                >
                  <Icon name="copy" />
                </Button>
              ) : null}
              <Button
                active={catalogSearchOpen}
                iconOnly
                size="xs"
                variant="ghost"
                onClick={() => setCatalogSearchOpen((open) => !open)}
                title={t("connections.searchDataSources")}
                aria-label={t("connections.searchDataSources")}
                aria-pressed={catalogSearchOpen}
              >
                <Icon name="search" />
              </Button>
              </div>
            ) : editorView === "drivers" ? (
              <div className="tw:flex tw:items-center tw:gap-1">
                <Button
                  iconOnly
                  size="xs"
                  variant="ghost"
                  disabled={driverCatalog.isFetching}
                  onClick={() => void driverCatalog.refetch()}
                  title={t("common.refresh")}
                  aria-label={t("common.refresh")}
                >
                  <Icon name="refresh" />
                </Button>
                <Button
                  active={catalogSearchOpen}
                  iconOnly
                  size="xs"
                  variant="ghost"
                  onClick={() => setCatalogSearchOpen((open) => !open)}
                  title={t("connections.searchDrivers")}
                  aria-label={t("connections.searchDrivers")}
                  aria-pressed={catalogSearchOpen}
                >
                  <Icon name="search" />
                </Button>
              </div>
            ) : null}
          </div>
          {editorView !== "clouds" && catalogSearchOpen ? (
            <ToolWindowSearchRow>
              <TreeSearch
                value={
                  editorView === "dataSources"
                    ? sourceSearch
                    : driverSearch
                }
                autoFocus
                placeholder={t(
                  editorView === "dataSources"
                    ? "connections.searchDataSources"
                    : "connections.searchDrivers",
                )}
                clearLabel={t("common.close")}
                onChange={
                  editorView === "dataSources"
                    ? setSourceSearch
                    : setDriverSearch
                }
                onEscape={() => {
                  if (editorView === "dataSources" && sourceSearch) {
                    setSourceSearch("");
                  } else if (editorView === "drivers" && driverSearch) {
                    setDriverSearch("");
                  } else {
                    setCatalogSearchOpen(false);
                  }
                }}
              />
            </ToolWindowSearchRow>
          ) : null}
          <nav className="tw:min-h-0 tw:flex-1 tw:overflow-y-auto tw:py-2">
            {editorView === "dataSources" &&
            visibleConnections.length > 0 ? (
              <ToolWindowSection
                title={t("connections.dataSources")}
                prominence="catalog"
              >
                {visibleConnections.map((connection) => (
                  <ToolWindowAction
                    key={connection.id}
                    flush
                    leading={
                      <EngineMark engine={connection.engine} size="tree" />
                    }
                    selected={!isNew && connection.id === form.id}
                    onClick={() => onEditConnection(connection)}
                  >
                    {connection.name || t("app.unnamed")}
                  </ToolWindowAction>
                ))}
              </ToolWindowSection>
            ) : null}
            {editorView === "dataSources" &&
            connections.length > 0 &&
            visibleConnections.length === 0 ? (
              <p className="tw:px-2 tw:py-4 tw:text-center tw:text-sm tw:text-muted-foreground">
                {t("connections.noDataSourceResults")}
              </p>
            ) : null}
            {editorView === "drivers" ? (
              driverCatalog.isPending ? (
                <p className="tw:px-2 tw:py-4 tw:text-center tw:text-sm tw:text-muted-foreground">
                  {t("connections.driverCatalogLoading")}
                </p>
              ) : driverCatalog.isError ? (
                <p
                  className="tw:px-2 tw:py-4 tw:text-center tw:text-sm tw:text-danger"
                  role="alert"
                >
                  {t("connections.problemDriverCatalogUnavailable")}
                </p>
              ) : visibleCatalogDrivers.length > 0 ? (
                <ToolWindowSection
                  title={t("connections.drivers")}
                  prominence="catalog"
                >
                  {visibleCatalogDrivers.map((driver) => (
                    <ToolWindowAction
                      key={driver.id}
                      flush
                      leading={
                        <EngineMark engine={driver.engine} size="tree" />
                      }
                      trailing={
                        driver.installState === "installed" ? (
                          <Icon name="check" />
                        ) : null
                      }
                      selected={catalogDriver?.id === driver.id}
                      onClick={() => setCatalogDriverId(driver.id)}
                    >
                      {driver.name}
                    </ToolWindowAction>
                  ))}
                </ToolWindowSection>
              ) : (
                <p className="tw:px-2 tw:py-4 tw:text-center tw:text-sm tw:text-muted-foreground">
                  {t("connections.noDriverResults")}
                </p>
              )
            ) : null}
            {editorView === "clouds" ? (
              <ToolWindowSection
                title={t("connections.clouds")}
                prominence="catalog"
              >
                {cloudProviders.map((provider) => (
                  <ToolWindowAction
                    key={provider.provider}
                    flush
                    leading={<Icon name="key" />}
                    selected={
                      catalogCloudProvider === provider.provider
                    }
                    onClick={() =>
                      setCatalogCloudProvider(provider.provider)
                    }
                  >
                    {provider.label}
                  </ToolWindowAction>
                ))}
              </ToolWindowSection>
            ) : null}
          </nav>
          {editorView === "dataSources" ? (
            <div className="tw:shrink-0 tw:border-t tw:border-border-subtle tw:py-2">
              <ToolWindowAction
                flush
                leading={
                  <span
                    data-danger={
                      problemItems.some(
                        (item) => item.tone === "danger",
                      ) || undefined
                    }
                    className="tw:text-muted-foreground tw:data-[danger=true]:text-danger"
                  >
                    <Icon name="alert" />
                  </span>
                }
                trailing={
                  <DiagnosticCount
                    count={problemItems.length}
                    hasErrors={problemItems.some(
                      (item) => item.tone === "danger",
                    )}
                  />
                }
                selected={problemsOpen}
                onClick={() => setProblemsOpen((open) => !open)}
              >
                {t("connections.problems")}
              </ToolWindowAction>
            </div>
          ) : null}
        </aside>

        <section className="tw:flex tw:min-w-0 tw:flex-1 tw:flex-col tw:overflow-hidden">
          <div className="tw:hidden tw:shrink-0 tw:items-center tw:gap-2 tw:border-b tw:border-border-subtle tw:bg-card tw:p-2 tw:@max-[760px]:flex">
            {editorView === "dataSources" ? (
              <>
                <SelectInput
                  value={isNew ? "__new__" : form.id}
                  onChange={(event) => {
                    const connection = connections.find(
                      (candidate) =>
                        candidate.id === event.target.value,
                    );
                    if (connection) onEditConnection(connection);
                  }}
                  aria-label={t("connections.dataSources")}
                >
                  {isNew ? (
                    <option value="__new__">
                      {t("connections.new")}
                    </option>
                  ) : null}
                  {connections.map((connection) => (
                    <option key={connection.id} value={connection.id}>
                      {connection.name || t("app.unnamed")}
                    </option>
                  ))}
                </SelectInput>
                <Button
                  iconOnly
                  size="compact"
                  variant="ghost"
                  onClick={() => onNewConnection()}
                  title={t("connections.new")}
                  aria-label={t("connections.new")}
                >
                  <Icon name="plus" />
                </Button>
              </>
            ) : editorView === "clouds" ? (
              <SelectInput
                value={catalogCloudProvider}
                onChange={(event) =>
                  setCatalogCloudProvider(
                    event.target.value as ProviderKind,
                  )
                }
                aria-label={t("connections.clouds")}
              >
                {cloudProviders.map((provider) => (
                  <option
                    key={provider.provider}
                    value={provider.provider}
                  >
                    {provider.label}
                  </option>
                ))}
              </SelectInput>
            ) : (
              <SelectInput
                value={catalogDriver?.id ?? ""}
                disabled={visibleCatalogDrivers.length === 0}
                onChange={(event) =>
                  setCatalogDriverId(event.target.value)
                }
                aria-label={t("connections.drivers")}
              >
                {visibleCatalogDrivers.map((driver) => (
                  <option key={driver.id} value={driver.id}>
                    {driver.name}
                  </option>
                ))}
              </SelectInput>
            )}
          </div>
          {editorView === "dataSources" ? (
            <>
          <div className="tw:grid tw:shrink-0 tw:grid-cols-[75px_minmax(0,1fr)] tw:items-center tw:gap-3 tw:border-b tw:border-border-subtle tw:bg-card tw:px-4 tw:py-3">
            <label
              htmlFor="connection-name"
              className="tw:text-sm tw:text-foreground"
            >
              {t("connections.name")}
            </label>
            <span className="tw:grid tw:min-w-0 tw:max-w-[360px] tw:gap-1">
              <TextInput
                id="connection-name"
                density="compact"
                value={form.name}
                disabled={!canEditConnection}
                aria-invalid={
                  nameValidation?.tone === "danger" || undefined
                }
                onChange={(event) => set("name", event.target.value)}
                placeholder="prod-readonly"
                autoFocus
              />
              {nameValidation ? (
                <FieldValidationMessage
                  validation={nameValidation}
                />
              ) : null}
            </span>
          </div>

          {!problemsOpen ? (
            <PanelTabs
              tabs={tabs}
              active={activeTab}
              onChange={setActiveTab}
              label={t("connections.tabList")}
            />
          ) : null}

          <div className="tw:min-h-0 tw:flex-1 tw:overflow-y-auto tw:p-5">
            {problemsOpen ? (
              <DiagnosticSummary
                title={t("connections.problems")}
                items={problemItems}
                emptyMessage={t("connections.problemsEmpty")}
                onSelect={openDiagnostic}
              />
            ) : null}
            {!problemsOpen && activeTab === "general" ? (
              <div className="tw:mx-auto tw:grid tw:w-full tw:max-w-[840px] tw:gap-4">
                <section className="tw:grid tw:gap-1.5">
                  <div className="tw:flex tw:min-h-control-md tw:flex-wrap tw:items-center tw:gap-x-6 tw:gap-y-1 tw:text-sm tw:text-foreground">
                    {!isSharedTemplate ? (
                      <label className="tw:inline-flex tw:min-w-0 tw:items-center tw:gap-1.5">
                        <span>{t("connections.connectionType")}:</span>
                        <InlineSelect
                          value={connectionInputMode}
                          aria-label={t("connections.connectionType")}
                          disabled={busy}
                          onChange={(event) =>
                            selectConnectionInputMode(
                              event.target.value as ConnectionInputMode,
                            )
                          }
                        >
                          <option value="default">
                            {t(
                              "connections.connectionTypeDefault",
                            )}
                          </option>
                          <option value="urlOnly">
                            {t(
                              "connections.connectionTypeUrlOnly",
                            )}
                          </option>
                        </InlineSelect>
                      </label>
                    ) : null}

                    <label className="tw:inline-flex tw:min-w-0 tw:items-center tw:gap-1.5">
                      <span>{t("connections.driver")}:</span>
                      <InlineSelect
                        id="connection-driver"
                        title={t("connections.driverHint")}
                        value={form.driverId ?? ""}
                        aria-invalid={
                          driverValidation?.tone === "danger" ||
                          undefined
                        }
                        onChange={(event) =>
                          set(
                            "driverId",
                            event.target.value || null,
                          )
                        }
                        disabled={
                          !canEditConnection ||
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
                      </InlineSelect>
                    </label>

                    {activeDriver?.installMode === "managed" &&
                    activeDriver.installState === "available" ? (
                      <Button
                        size="compact"
                        disabled={installingDriverId !== null}
                        onClick={() =>
                          void downloadDriver(activeDriver)
                        }
                      >
                        <Icon name="download" />
                        {installingDriverId === activeDriver.id
                          ? t("connections.driverDownloading")
                          : t("connections.driverDownload")}
                      </Button>
                    ) : null}
                  </div>
                  {driverValidation ? (
                    <FieldValidationMessage
                      validation={driverValidation}
                    />
                  ) : null}
                </section>

                {!isSharedTemplate &&
                connectionInputMode === "urlOnly" ? (
                  <section className="tw:grid tw:gap-2">
                    <PropertyRow
                      label={t("connections.connectionUrl")}
                      htmlFor="connection-url"
                      validation={connectionUrlValidation}
                    >
                      <TextInput
                        id="connection-url"
                        density="compact"
                        value={connectionUrlDraft}
                        aria-invalid={
                          connectionUrlValidation?.tone === "danger" ||
                          undefined
                        }
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        onChange={(event) =>
                          editConnectionUrl(event.target.value)
                        }
                        onBlur={(event) =>
                          normalizeConnectionUrl(event.target.value)
                        }
                      />
                    </PropertyRow>
                    <p className="tw:m-0 tw:pl-[112px] tw:text-xs tw:text-muted-foreground tw:@max-[560px]:pl-0">
                      {t("connections.connectionUrlOverrides")}
                    </p>
                  </section>
                ) : isSqlite ? (
                  <section className="tw:grid tw:gap-3">
                    <PropertyRow
                      label={t("connections.databaseFile")}
                      htmlFor="connection-database"
                      validation={databaseValidation}
                    >
                      <div className="tw:grid tw:grid-cols-[minmax(0,1fr)_auto] tw:items-center tw:gap-2">
                        <TextInput
                          id="connection-database"
                          density="compact"
                          value={form.database}
                          aria-invalid={
                            databaseValidation?.tone === "danger" ||
                            undefined
                          }
                          onChange={(event) =>
                            set("database", event.target.value)
                          }
                          placeholder="/path/to/app.db"
                        />
                        <Button
                          size="compact"
                          onClick={() =>
                            void pickFile().then(
                              (file) =>
                                file && set("database", file),
                            )
                          }
                        >
                          {t("connections.browse")}
                        </Button>
                      </div>
                    </PropertyRow>
                  </section>
                ) : (
                  <section className="tw:grid tw:gap-3">
                    <PropertyRow
                      label={t("connections.host")}
                      htmlFor="connection-host"
                    >
                      <div className="tw:grid tw:grid-cols-[minmax(0,1fr)_auto_112px] tw:items-start tw:gap-3 tw:@max-[560px]:grid-cols-1 tw:@max-[560px]:gap-1.5">
                        <div className="tw:grid tw:gap-1.5">
                          <TextInput
                            id="connection-host"
                            density="compact"
                            value={form.host}
                            disabled={!canEditConnection}
                            aria-invalid={
                              hostValidation?.tone === "danger" ||
                              undefined
                            }
                            onChange={(event) =>
                              set("host", event.target.value)
                            }
                          />
                          {hostValidation ? (
                            <FieldValidationMessage
                              validation={hostValidation}
                            />
                          ) : null}
                        </div>
                        <label
                          htmlFor="connection-port"
                          className="tw:inline-flex tw:min-h-control-md tw:items-center tw:text-sm tw:text-foreground tw:@max-[560px]:min-h-0"
                        >
                          {t("connections.port")}
                        </label>
                        <div className="tw:grid tw:gap-1.5">
                          <TextInput
                            id="connection-port"
                            density="compact"
                            type="number"
                            value={form.port}
                            min={1}
                            max={65_535}
                            aria-invalid={
                              portValidation?.tone === "danger" ||
                              undefined
                            }
                            disabled={
                              !canEditConnection ||
                              (isMongo && srv)
                            }
                            onChange={(event) => {
                              if (event.target.value !== "") {
                                set(
                                  "port",
                                  Number(event.target.value),
                                );
                              }
                            }}
                          />
                          {portValidation ? (
                            <FieldValidationMessage
                              validation={portValidation}
                            />
                          ) : null}
                        </div>
                      </div>
                    </PropertyRow>

                    <PropertyRow
                      label={t("connections.database")}
                      htmlFor="connection-database"
                      validation={databaseValidation}
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
                        id="connection-database"
                        density="compact"
                        value={form.database}
                        disabled={!canEditConnection}
                        required={isMongo}
                        aria-invalid={
                          databaseValidation?.tone === "danger" ||
                          undefined
                        }
                        onChange={(event) =>
                          set("database", event.target.value)
                        }
                      />
                    </PropertyRow>

                    {isMongo && !isSharedTemplate ? (
                      <PropertyRow label={t("connections.srv")}>
                        <CheckboxField
                          label={t("connections.srv")}
                          checked={srv}
                          onChange={(event) =>
                            setSrv(event.target.checked)
                          }
                        />
                      </PropertyRow>
                    ) : null}

                    {isSharedTemplate ? (
                      <>
                        <PropertyRow
                          label={t("connections.sslMode")}
                        >
                          <SelectInput
                            density="compact"
                            value={form.sslmode}
                            disabled={!canEditConnection}
                            onChange={(event) =>
                              set("sslmode", event.target.value)
                            }
                          >
                            {(isMongo
                              ? ["disable", "require"]
                              : sqlSslModes
                            ).map((mode) => (
                              <option key={mode} value={mode}>
                                {mode}
                              </option>
                            ))}
                          </SelectInput>
                        </PropertyRow>
                        <PropertyRow
                          label={t("connections.environment")}
                        >
                          <SelectInput
                            density="compact"
                            value={form.env ?? ""}
                            disabled={!canEditConnection}
                            onChange={(event) =>
                              set(
                                "env",
                                event.target.value || null,
                              )
                            }
                          >
                            <option value="">
                              {t("common.none")}
                            </option>
                            <option value="dev">dev</option>
                            <option value="staging">staging</option>
                            <option value="prod">prod</option>
                          </SelectInput>
                        </PropertyRow>
                        {!isMongo ? (
                          <PropertyRow
                            label={t("connections.schemaGroup")}
                          >
                            <TextInput
                              density="compact"
                              value={form.schemaGroup ?? ""}
                              disabled={!canEditConnection}
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
                          </PropertyRow>
                        ) : null}
                        <PropertyRow
                          label={t("workspace.bindCredentialsShort")}
                        >
                          <div className="tw:flex tw:min-h-control-md tw:flex-wrap tw:items-center tw:gap-2">
                            <StatusBadge
                              tone={
                                form.credentialMode === "managed" ||
                                form.secretRef
                                  ? "success"
                                  : "warning"
                              }
                            >
                              {form.credentialMode === "managed" ||
                              form.secretRef
                                ? t("providerCredentials.ready")
                                : t(
                                    "providerCredentials.credentialsRequired",
                                  )}
                            </StatusBadge>
                            {form.credentialMode === "memberLocal" &&
                            form.workspaceAccess !== "view" ? (
                              <Button
                                size="compact"
                                onClick={() =>
                                  setWorkspaceDialogMode(
                                    "credentials",
                                  )
                                }
                              >
                                {t(
                                  "workspace.bindCredentialsShort",
                                )}
                              </Button>
                            ) : null}
                          </div>
                        </PropertyRow>
                        <p className="tw:m-0 tw:border-t tw:border-border-subtle tw:pt-3 tw:text-sm tw:leading-body tw:text-muted-foreground">
                          {t("workspace.copySecurityNote")}
                        </p>
                      </>
                    ) : (
                      <>
                        <PropertyRow
                          label={t("connections.user")}
                        >
                          <TextInput
                            density="compact"
                            aria-label={t("connections.user")}
                            value={form.username}
                            onChange={(event) =>
                              set("username", event.target.value)
                            }
                          />
                        </PropertyRow>

                        <PropertyRow
                          label={t("connections.password")}
                        >
                          <TextInput
                            density="compact"
                            type="password"
                            aria-label={t("connections.password")}
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
                        </PropertyRow>
                      </>
                    )}
                  </section>
                )}

              </div>
            ) : null}

            {!problemsOpen && activeTab === "options" ? (
              <div className="tw:mx-auto tw:grid tw:w-full tw:max-w-[760px] tw:gap-6">
                <section className="tw:grid tw:gap-4">
                  <h3>{t("connections.connection")}</h3>

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

                  {!isMongo ? (
                    <div className="tw:grid tw:grid-cols-[220px_minmax(0,1fr)] tw:items-start tw:gap-3 tw:border-y tw:border-border-subtle tw:py-3 tw:@max-[620px]:grid-cols-1">
                      <span className="tw:text-sm tw:font-medium tw:text-muted-foreground">
                        {t("connections.transactionControl")}
                      </span>
                      <div className="tw:grid tw:gap-1">
                        <strong className="tw:text-ui tw:font-medium tw:text-foreground">
                          {t("connections.transactionAuto")}
                        </strong>
                        <p className="tw:m-0 tw:text-xs tw:text-muted-foreground">
                          {t(
                            "connections.transactionOperationScoped",
                          )}
                        </p>
                      </div>
                    </div>
                  ) : null}

                  {supportsSqlSessionOptions ? (
                    <Field
                      label={t("connections.timeZone")}
                      validation={timeZoneValidation}
                    >
                      <TextInput
                        id="connection-time-zone"
                        value={connectionOption(
                          form,
                          CONNECTION_TIME_ZONE_PARAMETER,
                        )}
                        aria-invalid={
                          timeZoneValidation?.tone === "danger" ||
                          undefined
                        }
                        onChange={(event) =>
                          setExtraParameter(
                            CONNECTION_TIME_ZONE_PARAMETER,
                            event.target.value,
                          )
                        }
                        placeholder={t(
                          "connections.timeZonePlaceholder",
                        )}
                      />
                    </Field>
                  ) : null}

                  {supportsSqlSessionOptions ? (
                    <div className="tw:grid tw:gap-2">
                      <CheckboxField
                        label={t("connections.keepAlive")}
                        checked={keepAliveEnabled}
                        onChange={(event) =>
                          toggleTimedConnectionOption(
                            CONNECTION_KEEP_ALIVE_SECONDS_PARAMETER,
                            event.target.checked,
                            60,
                          )
                        }
                      />
                      <div className="tw:flex tw:items-center tw:gap-2 tw:pl-6">
                        <div className="tw:w-32">
                          <TextInput
                            id="connection-keep-alive"
                            type="number"
                            inputMode="numeric"
                            min={CONNECTION_KEEP_ALIVE_MIN_SECONDS}
                            max={CONNECTION_KEEP_ALIVE_MAX_SECONDS}
                            value={connectionOption(
                              form,
                              CONNECTION_KEEP_ALIVE_SECONDS_PARAMETER,
                            )}
                            disabled={!keepAliveEnabled}
                            aria-invalid={
                              keepAliveValidation?.tone ===
                                "danger" || undefined
                            }
                            aria-label={t(
                              "connections.keepAliveSeconds",
                            )}
                            onChange={(event) =>
                              setTimedConnectionOptionValue(
                                CONNECTION_KEEP_ALIVE_SECONDS_PARAMETER,
                                event.target.value,
                              )
                            }
                          />
                        </div>
                        <span className="tw:shrink-0 tw:text-sm tw:text-muted-foreground">
                          {t("connections.seconds")}
                        </span>
                      </div>
                      {keepAliveValidation ? (
                        <div className="tw:pl-6">
                          <FieldValidationMessage
                            validation={keepAliveValidation}
                          />
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  <div className="tw:grid tw:gap-2">
                    <CheckboxField
                      label={t("connections.autoDisconnect")}
                      checked={autoDisconnectEnabled}
                      onChange={(event) =>
                        toggleTimedConnectionOption(
                          CONNECTION_AUTO_DISCONNECT_SECONDS_PARAMETER,
                          event.target.checked,
                          600,
                        )
                      }
                    />
                    <div className="tw:flex tw:items-center tw:gap-2 tw:pl-6">
                      <div className="tw:w-32">
                        <TextInput
                          id="connection-auto-disconnect"
                          type="number"
                          inputMode="numeric"
                          min={
                            CONNECTION_AUTO_DISCONNECT_MIN_SECONDS
                          }
                          max={
                            CONNECTION_AUTO_DISCONNECT_MAX_SECONDS
                          }
                          value={connectionOption(
                            form,
                            CONNECTION_AUTO_DISCONNECT_SECONDS_PARAMETER,
                          )}
                          disabled={!autoDisconnectEnabled}
                          aria-invalid={
                            autoDisconnectValidation?.tone ===
                              "danger" || undefined
                          }
                          aria-label={t(
                            "connections.autoDisconnectSeconds",
                          )}
                          onChange={(event) =>
                            setTimedConnectionOptionValue(
                              CONNECTION_AUTO_DISCONNECT_SECONDS_PARAMETER,
                              event.target.value,
                            )
                          }
                        />
                      </div>
                      <span className="tw:shrink-0 tw:text-sm tw:text-muted-foreground">
                        {t("connections.seconds")}
                      </span>
                    </div>
                    {autoDisconnectValidation ? (
                      <div className="tw:pl-6">
                        <FieldValidationMessage
                          validation={autoDisconnectValidation}
                        />
                      </div>
                    ) : null}
                  </div>

                  {supportsStartupScript ? (
                    <Field
                      label={t("connections.startupScript")}
                      hint={
                        <InfoTip
                          label={t(
                            "connections.startupScriptHint",
                          )}
                        />
                      }
                      validation={startupScriptValidation}
                    >
                      <TextAreaInput
                        id="connection-startup-script"
                        value={connectionOption(
                          form,
                          CONNECTION_STARTUP_SCRIPT_PARAMETER,
                        )}
                        maxLength={
                          CONNECTION_STARTUP_SCRIPT_MAX_LENGTH
                        }
                        aria-invalid={
                          startupScriptValidation?.tone ===
                            "danger" || undefined
                        }
                        onChange={(event) =>
                          setExtraParameter(
                            CONNECTION_STARTUP_SCRIPT_PARAMETER,
                            event.target.value,
                          )
                        }
                        placeholder={t(
                          "connections.startupScriptPlaceholder",
                        )}
                      />
                    </Field>
                  ) : null}
                </section>

                <section className="tw:grid tw:gap-4 tw:border-t tw:border-border-subtle tw:pt-5">
                  <h3>{t("connections.safety")}</h3>
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
                  <div className="tw:flex tw:items-center tw:gap-2 tw:text-sm tw:text-muted-foreground">
                    <Icon name="info" />
                    <span>{t("connections.writeAccessHint")}</span>
                  </div>
                </section>
              </div>
            ) : null}

            {!problemsOpen && activeTab === "sshSsl" ? (
              <div className="tw:mx-auto tw:grid tw:w-full tw:max-w-[720px] tw:gap-5">
                <section className="tw:grid tw:gap-3">
                  <h3>{t("connections.sslConfiguration")}</h3>
                  {isSqlite ? (
                    <p className="tw:m-0 tw:text-sm tw:text-muted-foreground">
                      {t("connections.sqliteNoTls")}
                    </p>
                  ) : isMongo ? (
                    <>
                      <CheckboxField
                        label={t("connections.enableTls")}
                        checked={mongoTlsEnabled}
                        onChange={(event) =>
                          setMongoTls(event.target.checked)
                        }
                      />
                      <div className="tw:grid tw:grid-cols-2 tw:gap-3 tw:@max-[620px]:grid-cols-1">
                        <Field
                          label={t("connections.caCertificate")}
                        >
                          <div className="tw:grid tw:grid-cols-[minmax(0,1fr)_auto] tw:gap-2">
                            <TextInput
                              value={
                                form.extraParams.tlsCAFile ?? ""
                              }
                              disabled={!mongoTlsEnabled}
                              onChange={(event) =>
                                setExtraParameter(
                                  "tlsCAFile",
                                  event.target.value,
                                )
                              }
                              placeholder="/path/to/ca.pem"
                            />
                            <Button
                              disabled={!mongoTlsEnabled}
                              size="compact"
                              onClick={() =>
                                void pickExtraParameterFile(
                                  "tlsCAFile",
                                )
                              }
                            >
                              {t("connections.browse")}
                            </Button>
                          </div>
                        </Field>
                        <Field
                          label={t(
                            "connections.clientCertificateKey",
                          )}
                        >
                          <div className="tw:grid tw:grid-cols-[minmax(0,1fr)_auto] tw:gap-2">
                            <TextInput
                              value={
                                form.extraParams
                                  .tlsCertificateKeyFile ?? ""
                              }
                              disabled={!mongoTlsEnabled}
                              onChange={(event) =>
                                setExtraParameter(
                                  "tlsCertificateKeyFile",
                                  event.target.value,
                                )
                              }
                              placeholder="/path/to/client.pem"
                            />
                            <Button
                              disabled={!mongoTlsEnabled}
                              size="compact"
                              onClick={() =>
                                void pickExtraParameterFile(
                                  "tlsCertificateKeyFile",
                                )
                              }
                            >
                              {t("connections.browse")}
                            </Button>
                          </div>
                        </Field>
                      </div>
                    </>
                  ) : (
                    <>
                      <Field label={t("connections.sslMode")}>
                        <SelectInput
                          value={form.sslmode}
                          onChange={(event) =>
                            set("sslmode", event.target.value)
                          }
                        >
                          {sqlSslModes.map((mode) => (
                            <option key={mode} value={mode}>
                              {mode}
                            </option>
                          ))}
                        </SelectInput>
                      </Field>
                      <div className="tw:grid tw:gap-3">
                        {(
                          [
                            [
                              "sslrootcert",
                              "connections.caCertificate",
                              "/path/to/ca.pem",
                            ],
                            [
                              "sslcert",
                              "connections.clientCertificate",
                              "/path/to/client.crt",
                            ],
                            [
                              "sslkey",
                              "connections.clientKey",
                              "/path/to/client.key",
                            ],
                          ] as const
                        ).map(([key, label, placeholder]) => (
                          <Field key={key} label={t(label)}>
                            <div className="tw:grid tw:grid-cols-[minmax(0,1fr)_auto] tw:gap-2">
                              <TextInput
                                value={form.extraParams[key] ?? ""}
                                disabled={!sqlTlsEnabled}
                                onChange={(event) =>
                                  setExtraParameter(
                                    key,
                                    event.target.value,
                                  )
                                }
                                placeholder={placeholder}
                              />
                              <Button
                                disabled={!sqlTlsEnabled}
                                size="compact"
                                onClick={() =>
                                  void pickExtraParameterFile(key)
                                }
                              >
                                {t("connections.browse")}
                              </Button>
                            </div>
                          </Field>
                        ))}
                      </div>
                    </>
                  )}
                </section>
                {!isSqlite ? (
                  <section className="tw:grid tw:gap-3 tw:border-t tw:border-border-subtle tw:pt-4">
                    <h3>{t("connections.sshTunnel")}</h3>
                    <Field label={t("connections.sshHostAlias")}>
                      <div className="tw:grid tw:gap-1.5">
                        <TextInput
                          id="connection-ssh-alias"
                          value={
                            form.extraParams[
                              CONNECTION_SSH_ALIAS_PARAMETER
                            ] ?? ""
                          }
                          aria-invalid={
                            sshAliasValidation?.tone === "danger" ||
                            undefined
                          }
                          autoCapitalize="none"
                          autoCorrect="off"
                          spellCheck={false}
                          maxLength={255}
                          placeholder={t(
                            "connections.sshHostAliasPlaceholder",
                          )}
                          onChange={(event) =>
                            setExtraParameter(
                              CONNECTION_SSH_ALIAS_PARAMETER,
                              event.target.value,
                            )
                          }
                        />
                        {sshAliasValidation ? (
                          <FieldValidationMessage
                            validation={sshAliasValidation}
                          />
                        ) : null}
                      </div>
                    </Field>
                    <p className="tw:m-0 tw:text-sm tw:leading-body tw:text-muted-foreground">
                      {t("connections.sshHostAliasHint")}
                    </p>
                  </section>
                ) : null}
              </div>
            ) : null}

            {!problemsOpen && activeTab === "schemas" && !isMongo ? (
              <div className="tw:mx-auto tw:grid tw:w-full tw:max-w-[720px] tw:gap-5">
                <section className="tw:grid tw:gap-3">
                  <h3>{t("connections.introspectionScope")}</h3>
                  <p className="tw:m-0 tw:text-sm tw:leading-body tw:text-muted-foreground">
                    {t("connections.introspectionScopeBody")}
                  </p>
                  {!persisted ? (
                    <div className="tw:rounded-sm tw:border tw:border-border-subtle tw:bg-card tw:p-3 tw:text-sm tw:text-muted-foreground">
                      {t("connections.schemaScopeSaveFirst")}
                    </div>
                  ) : schemaDiscovery.error ? (
                    <div className="tw:flex tw:items-start tw:gap-2 tw:rounded-sm tw:border tw:border-danger tw:bg-card tw:p-3 tw:text-sm tw:text-danger">
                      <span className="tw:min-w-0 tw:flex-1 tw:wrap-break-word">
                        {errMessage(schemaDiscovery.error)}
                      </span>
                      <Button
                        size="compact"
                        disabled={schemaDiscovery.isFetching}
                        onClick={() => void schemaDiscovery.refetch()}
                      >
                        <Icon name="refresh" />
                        {t("common.refresh")}
                      </Button>
                    </div>
                  ) : !schemaDiscovery.data ? (
                    <div className="tw:text-sm tw:text-muted-foreground">
                      {t("connections.loadingSchemaScope")}
                    </div>
                  ) : discoveredSchemas.length === 0 ? (
                    <div className="tw:rounded-sm tw:border tw:border-border-subtle tw:bg-card tw:p-3 tw:text-sm tw:text-muted-foreground">
                      {t("connections.noSchemasDiscovered")}
                    </div>
                  ) : (
                    <div className="tw:grid tw:overflow-hidden tw:rounded-sm tw:border tw:border-border-subtle tw:bg-card">
                      <div className="tw:flex tw:min-h-10 tw:items-center tw:gap-2 tw:border-b tw:border-border-subtle tw:bg-muted/40 tw:px-3">
                        <Icon
                          name="database"
                          className="tw:text-muted-foreground"
                        />
                        <strong className="tw:min-w-0 tw:flex-1 tw:truncate tw:text-ui tw:font-medium">
                          {form.database}
                        </strong>
                        <span className="tw:text-xs tw:text-muted-foreground">
                          {t("connections.discoveredSchemaCount", {
                            count: discoveredSchemas.length,
                          })}
                        </span>
                      </div>
                      <div className="tw:grid tw:gap-1 tw:p-2 tw:pl-8">
                        <CheckboxField
                          label={t("connections.allSchemas")}
                          checked={scopedSchemas.length === 0}
                          indeterminate={
                            scopedSchemas.length > 0 &&
                            scopedSchemas.length <
                              discoveredSchemas.length
                          }
                          onChange={(event) => {
                            if (event.target.checked) {
                              setSchemaScope([]);
                            }
                          }}
                        />
                        <div className="tw:my-1 tw:h-px tw:bg-border-subtle" />
                        {discoveredSchemas.map((schema) => (
                          <CheckboxField
                            key={schema}
                            label={
                              <span className="tw:flex tw:min-w-0 tw:flex-1 tw:items-center tw:gap-2">
                                <span className="tw:min-w-0 tw:flex-1 tw:truncate">
                                  {schema}
                                </span>
                                <span className="tw:text-xs tw:tabular-nums tw:text-muted-foreground">
                                  {discoveredSchemaRelationCounts.get(
                                    schema,
                                  ) ?? 0}
                                </span>
                              </span>
                            }
                            checked={
                              scopedSchemas.length === 0 ||
                              scopedSchemas.includes(schema)
                            }
                            onChange={(event) =>
                              toggleSchemaScope(
                                schema,
                                event.target.checked,
                              )
                            }
                          />
                        ))}
                      </div>
                    </div>
                  )}
                  <Field
                    label={t("connections.objectNamePattern")}
                    hint={t("connections.objectNamePatternHint")}
                  >
                    <TextInput
                      value={
                        form.extraParams[
                          OBJECT_PATTERN_PARAMETER
                        ] ?? ""
                      }
                      onChange={(event) =>
                        setExtraParameter(
                          OBJECT_PATTERN_PARAMETER,
                          event.target.value,
                        )
                      }
                      placeholder="audit_*"
                    />
                  </Field>
                </section>

                <div className="tw:h-px tw:bg-border-subtle" />

                <section className="tw:grid tw:gap-3">
                  <h3>{t("connections.schemaComparison")}</h3>
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
                </section>
              </div>
            ) : null}

            {!problemsOpen && activeTab === "advanced" ? (
              <div className="tw:mx-auto tw:grid tw:w-full tw:max-w-[840px] tw:gap-5">
                <section className="tw:grid tw:gap-3">
                  <div className="tw:flex tw:items-center tw:justify-between tw:gap-3">
                    <h3>
                      {t("connections.advancedParameters")}
                    </h3>
                    <Button
                      size="compact"
                      onClick={addAdvancedParameter}
                    >
                      <Icon name="plus" />
                      {t("connections.addParameter")}
                    </Button>
                  </div>
                  {advancedParameters.length === 0 ? (
                    <p className="tw:m-0 tw:border-y tw:border-border-subtle tw:py-4 tw:text-sm tw:text-muted-foreground">
                      {t("connections.noParameters")}
                    </p>
                  ) : (
                    <div className="tw:grid tw:gap-2">
                      {advancedParameters.map(
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
                                  key,
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
                                  key,
                                  key,
                                  event.target.value,
                                )
                              }
                            />
                            <Button
                              iconOnly
                              size="xs"
                              variant="ghost"
                              onClick={() =>
                                removeAdvancedParameter(key)
                              }
                              title={t("common.remove")}
                              aria-label={t("common.remove")}
                            >
                              <Icon name="close" />
                            </Button>
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
          <ModalDetailActionBar>
            <button
              type="button"
              className="tw:cursor-pointer tw:border-0 tw:bg-transparent tw:p-0 tw:font-sans tw:text-sm tw:font-medium tw:text-info tw:disabled:cursor-default tw:disabled:text-muted-foreground"
              disabled={busy || hasBlockingProblems}
              onClick={() => void test()}
            >
              {running === "test"
                ? t("connections.testing")
                : t("connections.test")}
            </button>
            {message ? (
              <span
                data-error={messageIsError || undefined}
                className="tw:min-w-0 tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap tw:text-sm tw:text-muted-foreground tw:data-[error=true]:text-danger"
                role={messageIsError ? "alert" : "status"}
                title={message}
              >
                {message}
              </span>
            ) : activeDriver ? (
              <span className="tw:min-w-0 tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap tw:text-sm tw:text-muted-foreground">
                {activeDriver.name} {activeDriver.version}
              </span>
            ) : null}
          </ModalDetailActionBar>
            </>
          ) : editorView === "clouds" ? (
            <>
              <div className="tw:flex tw:min-h-control-lg tw:shrink-0 tw:items-center tw:gap-3 tw:border-b tw:border-border-subtle tw:bg-card tw:px-4">
                <Icon name="key" />
                <strong className="tw:min-w-0 tw:flex-1 tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap">
                  {providerLabel(catalogCloudProvider)}
                </strong>
              </div>
              <div className="tw:min-h-0 tw:flex-1 tw:overflow-y-auto tw:p-5">
                <div className="tw:mx-auto tw:grid tw:w-full tw:max-w-[760px] tw:gap-5">
                  <section className="tw:grid tw:gap-3">
                    <h3>{t("connections.clouds")}</h3>
                    <div className="tw:grid tw:grid-cols-[20px_minmax(0,1fr)] tw:gap-3 tw:border-y tw:border-border-subtle tw:py-3">
                      <Icon
                        name="info"
                        className="tw:mt-0.5 tw:text-info"
                      />
                      <p className="tw:m-0 tw:text-sm tw:leading-body tw:text-muted-foreground">
                        {t("connections.cloudCatalogDescription")}
                      </p>
                    </div>
                    <div>
                      <Button
                        variant="primary"
                        onClick={(event) =>
                          openProviderCredentials(
                            catalogCloudProvider,
                            event.currentTarget,
                          )
                        }
                      >
                        <Icon name="key" />
                        {t("connections.cloudCredentialDescription")}
                      </Button>
                    </div>
                  </section>
                </div>
              </div>
            </>
          ) : catalogDriver ? (
            <>
              <div className="tw:flex tw:min-h-control-lg tw:shrink-0 tw:items-center tw:gap-3 tw:border-b tw:border-border-subtle tw:bg-card tw:px-4">
                <EngineMark engine={catalogDriver.engine} />
                <strong className="tw:min-w-0 tw:flex-1 tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap">
                  {catalogDriver.name}
                </strong>
                <StatusBadge
                  tone={
                    catalogDriver.installState === "installed"
                      ? "success"
                      : "neutral"
                  }
                >
                  {driverStatus(catalogDriver)}
                </StatusBadge>
              </div>
              <div className="tw:min-h-0 tw:flex-1 tw:overflow-y-auto tw:p-5">
                <div className="tw:mx-auto tw:grid tw:w-full tw:max-w-[760px] tw:gap-5">
                  <section className="tw:grid tw:gap-3">
                    <h3>{t("connections.driverDetails")}</h3>
                    <dl className="tw:grid tw:grid-cols-[140px_minmax(0,1fr)] tw:gap-x-4 tw:text-sm tw:[&>*]:border-b tw:[&>*]:border-border-subtle tw:[&>*]:py-2.5">
                      <dt className="tw:text-muted-foreground">
                        {t("connections.engine")}
                      </dt>
                      <dd className="tw:m-0">{catalogDriver.engine}</dd>
                      <dt className="tw:text-muted-foreground">
                        {t("connections.driverVersion")}
                      </dt>
                      <dd className="tw:m-0 tw:font-mono">
                        {catalogDriver.version}
                      </dd>
                      <dt className="tw:text-muted-foreground">
                        {t("connections.driverInstallation")}
                      </dt>
                      <dd className="tw:m-0">
                        {driverStatus(catalogDriver)}
                      </dd>
                      <dt className="tw:text-muted-foreground">
                        {t("connections.supportedProviders")}
                      </dt>
                      <dd className="tw:m-0 tw:flex tw:flex-wrap tw:gap-1">
                        {catalogDriver.supportedProviders.map(
                          (provider) => (
                            <span className="badge" key={provider}>
                              {providerLabel(provider)}
                            </span>
                          ),
                        )}
                      </dd>
                    </dl>
                    {catalogDriver.installMode === "managed" &&
                    catalogDriver.installState === "available" ? (
                      <div>
                        <Button
                          variant="primary"
                          disabled={installingDriverId !== null}
                          onClick={() =>
                            void downloadDriver(catalogDriver)
                          }
                        >
                          <Icon name="download" />
                          {installingDriverId === catalogDriver.id
                            ? t("connections.driverDownloading")
                            : t("connections.driverDownload")}
                        </Button>
                      </div>
                    ) : null}
                  </section>
                  <section className="tw:grid tw:gap-3">
                    <h3>{t("connections.driverCapabilities")}</h3>
                    <div className="tw:flex tw:flex-wrap tw:gap-2">
                      {catalogDriver.capabilities.map((capability) => (
                        <span className="badge" key={capability}>
                          {capability}
                        </span>
                      ))}
                    </div>
                  </section>
                  <section className="tw:grid tw:grid-cols-[20px_minmax(0,1fr)] tw:gap-3 tw:border-t tw:border-border-subtle tw:pt-3">
                    <Icon name="info" className="tw:mt-0.5 tw:text-info" />
                    <p className="tw:m-0 tw:text-sm tw:leading-body tw:text-muted-foreground">
                      {t("connections.driverCatalogScope")}
                    </p>
                  </section>
                </div>
              </div>
            </>
          ) : (
            <div className="tw:grid tw:min-h-0 tw:flex-1 tw:place-items-center tw:p-6 tw:text-center tw:text-sm tw:text-muted-foreground">
              {driverCatalog.isError
                ? t("connections.problemDriverCatalogUnavailable")
                : t("connections.noDriverResults")}
            </div>
          )}
        </section>
      </div>

      <ModalFooter>
        {editorView === "dataSources" ? (
          canEditConnection ? (
            <>
              <Button
                disabled={busy}
                size="compact"
                onClick={onCancel}
              >
                {t("common.cancel")}
              </Button>
              <Button
                disabled={busy || hasBlockingProblems}
                size="compact"
                onClick={() => void save(false)}
              >
                {running === "apply"
                  ? t("common.saving")
                  : t("common.apply")}
              </Button>
              <Button
                variant="primary"
                disabled={busy || hasBlockingProblems}
                size="compact"
                onClick={() => void save(true)}
              >
                {running === "save"
                  ? t("common.saving")
                  : t("common.ok")}
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              size="compact"
              onClick={onCancel}
            >
              {t("common.ok")}
            </Button>
          )
        ) : (
          <>
            <Button size="compact" onClick={onCancel}>
              {t("common.cancel")}
            </Button>
            <Button size="compact" disabled>
              {t("common.apply")}
            </Button>
            <Button
              size="compact"
              variant="primary"
              onClick={onCancel}
            >
              {t("common.ok")}
            </Button>
          </>
        )}
      </ModalFooter>
      {providerCredentialsOpen ? (
        <ProviderCredentialDialog
          initialProvider={
            providerCredentialsOpen === "all"
              ? undefined
              : providerCredentialsOpen
          }
          onClose={() => setProviderCredentialsOpen(null)}
          returnFocus={() => providerReturnFocusRef.current?.focus()}
        />
      ) : null}
      {workspaceDialogMode && !isNew ? (
        <WorkspaceConnectionDialog
          connection={form}
          mode={workspaceDialogMode}
          onBound={(bound) => {
            setForm(bound);
            void onSaved(bound, false).catch((error) => {
              setMessage(errMessage(error));
              setMessageIsError(true);
            });
          }}
          onClose={() => setWorkspaceDialogMode(null)}
          returnFocusRef={workspaceButtonRef}
        />
      ) : null}
        </div>
      </ModalSurface>
    </ModalBackdrop>
  );
}
