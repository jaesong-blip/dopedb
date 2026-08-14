// Owns Connection profile validation and save/test/delete lifecycle commands;
// editable draft mechanics stay in the profile state model.
import type { DiagnosticItem } from "../../design-system/components/Diagnostics";
import type { FieldValidation } from "../../design-system/components/FormControls";
import type { PanelTab } from "../../design-system/components/PanelTabs";
import { errMessage } from "../../ipc/types";
import { useI18n } from "../../lib/i18n";
import { useCatalogScope } from "../../lib/queries";
import { useToast } from "../../components/Toast";
import { captureProductEvent } from "../productAnalytics/client";
import {
  productAnalyticsConnectionEngine,
  productAnalyticsCredentialMode,
  productAnalyticsWorkspaceContext,
} from "../productAnalytics/outcomes";
import {
  deleteWorkspaceConnection,
  updateWorkspaceConnection,
} from "../workspaces/tauriAdapter";
import {
  type ConnectionTab,
} from "./connectionEditorModel";
import { formatConnectionUrl, parseConnectionUrl } from "./connectionUrl";
import {
  diagnoseConnection,
  type ConnectionDiagnosticCode,
} from "./diagnostics";
import {
  connectionId,
  type ConnectionProfile,
} from "./domain";
import {
  CONNECTION_INPUT_MODE_PARAMETER,
  CONNECTION_SSH_ALIAS_PARAMETER,
} from "./options";
import {
  deleteConnection,
  testConnection,
  testConnectionProfile,
  upsertConnection,
} from "./tauriAdapter";
import type { ConnectionCatalogController } from "./useConnectionCatalogController";
import type { ConnectionEditorDialogs } from "./useConnectionEditorDialogs";
import type { ConnectionProfileState } from "./useConnectionProfileState";

export function useConnectionProfileController({
  connections,
  onDeletedConnection,
  onSaved,
  onCancel,
  profileState,
  catalog,
  dialogs,
}: {
  connections: ConnectionProfile[];
  onDeletedConnection: (id: string) => Promise<void>;
  onSaved: (
    profile: ConnectionProfile,
    closeEditor: boolean,
  ) => Promise<void>;
  onCancel: () => void;
  profileState: ConnectionProfileState;
  catalog: ConnectionCatalogController;
  dialogs: ConnectionEditorDialogs;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const catalogScope = useCatalogScope();
  const { form, identity, credentials, tabs: tabState, url, status } =
    profileState;
  const { isSharedTemplate, isMongo } = form.flags;
  const driverCatalog = catalog.model.driverCatalog;
  const diagnosticProfile = isSharedTemplate
    ? { ...form.value, extraParams: {} }
    : form.value;
  const diagnostics = diagnoseConnection(
    diagnosticProfile,
    connections,
    driverCatalog.data ?? [],
    driverCatalog.isError,
    driverCatalog.isPending,
  );
  const parsedConnectionUrl =
    !isSharedTemplate && url.mode === "urlOnly"
      ? parseConnectionUrl(url.draft)
      : null;
  const connectionUrlInvalid =
    !isSharedTemplate && url.mode === "urlOnly" && parsedConnectionUrl === null;
  const hasBlockingProblems =
    connectionUrlInvalid ||
    diagnostics.some((diagnostic) => diagnostic.tone === "danger");
  const problemItems: DiagnosticItem[] = diagnostics.map((diagnostic) => ({
    id: diagnostic.id,
    tone: diagnostic.tone,
    title: diagnosticMessage(diagnostic.code),
  }));
  if (connectionUrlInvalid) {
    problemItems.push({
      id: "connection-url-invalid",
      tone: "danger",
      title: t("connections.problemConnectionUrlInvalid"),
    });
  }
  if (status.messageIsError && status.message) {
    problemItems.push({
      id: "connection-runtime",
      tone: "danger",
      title: t("connections.problemRuntime"),
      description: status.message,
    });
  }
  const validation = {
    name: fieldValidation("connection-name"),
    driver: fieldValidation("connection-driver"),
    host: fieldValidation("connection-host"),
    port: fieldValidation("connection-port"),
    database: fieldValidation("connection-database"),
    timeZone: fieldValidation("connection-time-zone"),
    keepAlive: fieldValidation("connection-keep-alive"),
    autoDisconnect: fieldValidation("connection-auto-disconnect"),
    startupScript: fieldValidation("connection-startup-script"),
    sshAlias: fieldValidation("connection-ssh-alias"),
    connectionUrl: connectionUrlInvalid
      ? {
          tone: "danger",
          message: t("connections.problemConnectionUrlInvalid"),
        } satisfies FieldValidation
      : undefined,
  };
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

  function diagnosticMessage(code: ConnectionDiagnosticCode) {
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
        return t("connections.problemSshTunnelSingleHostRequired");
      case "sshTunnelSrvUnsupported":
        return t("connections.problemSshTunnelSrvUnsupported");
      case "driverCatalogUnavailable":
        return t("connections.problemDriverCatalogUnavailable");
      case "driverUnavailable":
        return t("connections.problemDriverUnavailable");
      case "driverInstallRequired":
        return t("connections.problemDriverInstallRequired");
    }
  }

  function fieldValidation(fieldId: string): FieldValidation | undefined {
    const diagnostic = diagnostics.find(
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
      dialogs.problems.setOpen(false);
      tabState.setActive("general");
      requestAnimationFrame(() =>
        document.getElementById("connection-url")?.focus(),
      );
      return;
    }
    const diagnostic = diagnostics.find(
      (candidate) => candidate.id === diagnosticId,
    );
    if (!diagnostic) return;
    dialogs.problems.setOpen(false);
    tabState.setActive(diagnostic.tab);
    if (diagnostic.fieldId) {
      const fieldId = diagnostic.fieldId;
      requestAnimationFrame(() => document.getElementById(fieldId)?.focus());
    }
  }

  async function save(closeEditor: boolean) {
    if (hasBlockingProblems) {
      dialogs.problems.setOpen(true);
      return;
    }
    status.setBusy(true);
    status.setRunning(closeEditor ? "save" : "apply");
    status.setMessage(null);
    try {
      const saved = isSharedTemplate
        ? await updateWorkspaceConnection({
            ...form.value,
            readonlyDefault: true,
            allowWrites: false,
          })
        : await upsertConnection(
            form.value,
            credentials.password || undefined,
          );
      form.setValue(saved);
      if (url.mode === "urlOnly") {
        url.setDraft(formatConnectionUrl(saved));
      }
      identity.setIsNew(false);
      identity.setPersisted(true);
      credentials.setPassword("");
      await onSaved(saved, closeEditor);
      toast(t("connections.connectionSaved"));
      status.setMessage(t("connections.saved"));
      status.setMessageIsError(false);
    } catch (error) {
      status.setMessage(errMessage(error));
      status.setMessageIsError(true);
    } finally {
      status.setBusy(false);
      status.setRunning(null);
    }
  }

  function bindWorkspaceConnection(bound: ConnectionProfile) {
    form.setValue(bound);
    void onSaved(bound, false).catch((error) => {
      status.setMessage(errMessage(error));
      status.setMessageIsError(true);
    });
  }

  function duplicateCurrentConnection() {
    if (identity.isNew || form.value.workspaceAccess !== "local") return;
    form.setValue((current) => {
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
        providerTarget: null,
      };
    });
    identity.setIsNew(true);
    identity.setPersisted(false);
    credentials.setPassword("");
    url.setMode("default");
    url.setDraft("");
    tabState.setActive("general");
    status.setMessage(null);
    status.setMessageIsError(false);
    toast(t("connections.connectionDuplicated"));
  }

  async function removeCurrentConnection() {
    if (
      identity.isNew ||
      (isSharedTemplate && form.value.workspaceAccess !== "manage")
    ) {
      return;
    }
    status.setBusy(true);
    status.setMessage(null);
    try {
      if (isSharedTemplate) {
        await deleteWorkspaceConnection(form.value.id);
      } else {
        await deleteConnection(form.value.id);
      }
      toast(t("connections.connectionDeleted"));
      await onDeletedConnection(form.value.id);
      onCancel();
    } catch (error) {
      status.setMessage(errMessage(error));
      status.setMessageIsError(true);
      status.setBusy(false);
    }
  }

  async function test() {
    if (hasBlockingProblems) {
      dialogs.problems.setOpen(true);
      return;
    }
    const analyticsContext = productAnalyticsWorkspaceContext(catalogScope);
    const analyticsDedupeId = crypto.randomUUID();
    const analyticsEngine = productAnalyticsConnectionEngine(form.value.engine);
    const analyticsCredentialMode =
      form.value.engine === "sqlite"
        ? "none"
        : productAnalyticsCredentialMode(form.value.credentialMode);
    const analyticsSsh =
      form.value.engine !== "sqlite" &&
      Boolean(
        form.value.extraParams[CONNECTION_SSH_ALIAS_PARAMETER]?.trim(),
      );
    const recordVerification = (outcome: "success" | "failed") => {
      if (!analyticsContext) return;
      void captureProductEvent({
        name: "connection_verification_completed",
        dedupeId: analyticsDedupeId,
        context: analyticsContext,
        properties: {
          outcome,
          engine: analyticsEngine,
          credentialMode: analyticsCredentialMode,
          ssh: analyticsSsh,
        },
      });
    };
    status.setBusy(true);
    status.setRunning("test");
    status.setMessage(null);
    try {
      if (isSharedTemplate) {
        await testConnection(form.value.id);
      } else {
        await testConnectionProfile(
          form.value,
          credentials.password || undefined,
        );
      }
      status.setMessage(`✓ ${t("connections.connectionOk")}`);
      status.setMessageIsError(false);
      recordVerification("success");
    } catch (error) {
      status.setMessage(errMessage(error));
      status.setMessageIsError(true);
      recordVerification("failed");
    } finally {
      status.setBusy(false);
      status.setRunning(null);
    }
  }

  return {
    view: {
      form: form.value,
      set: form.set,
      flags: form.flags,
      identity: {
        isNew: identity.isNew,
        persisted: identity.persisted,
      },
      credentials,
      tabs: {
        items: tabs,
        active: tabState.active,
        setActive: tabState.setActive,
      },
      url: {
        mode: url.mode,
        draft: url.draft,
        selectMode: url.selectMode,
        edit: url.edit,
        normalize: url.normalize,
        importFromClipboard: url.importFromClipboard,
      },
      options: {
        advancedParameters: form.advancedParameters,
        addAdvancedParameter: form.addAdvancedParameter,
        removeAdvancedParameter: form.removeAdvancedParameter,
        updateAdvancedParameter: form.updateAdvancedParameter,
        setExtraParameter: form.setExtraParameter,
        setMongoTls: form.setMongoTls,
        setSrv: form.setSrv,
        toggleTimedConnectionOption: form.toggleTimedConnectionOption,
        setTimedConnectionOptionValue: form.setTimedConnectionOptionValue,
        pickDatabaseFile: form.pickDatabaseFile,
        pickExtraParameterFile: form.pickExtraParameterFile,
      },
      validation,
    },
    problems: {
      items: problemItems,
      hasBlocking: hasBlockingProblems,
      openDiagnostic,
    },
    commands: {
      busy: status.busy,
      running: status.running,
      message: status.message,
      messageIsError: status.messageIsError,
      save,
      test,
      duplicate: duplicateCurrentConnection,
      remove: removeCurrentConnection,
      bindWorkspaceConnection,
    },
  };
}

export type ConnectionProfileController = ReturnType<
  typeof useConnectionProfileController
>;
