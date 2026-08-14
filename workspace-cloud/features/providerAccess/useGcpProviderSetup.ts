"use client";

// GCP setup owns its OAuth-session inventory, permission checks, and bootstrap use case.
import { useEffect } from "react";

import {
  parseGcpSetupPermissionCheck,
  type GcpSetupInstance,
  type GcpSetupInventory,
} from "./domain";
import type { ProviderAccessFieldSetter, ProviderAccessState } from "./state";
import { providerResponseError } from "./transport";
import type { WorkspaceLocale } from "../../lib/workspace-locale";
import { localizedProviderMessage } from "../../lib/workspace-provider-copy";
import { workspaceMessages } from "../../lib/workspace-messages";

type ProviderAccessCopy = (typeof workspaceMessages)[WorkspaceLocale]["providerAccess"];

export function useGcpProviderSetup({
  workspaceId,
  gcpSetupId,
  locale,
  copy,
  state,
  setField,
}: {
  workspaceId: string;
  gcpSetupId: string | null;
  locale: WorkspaceLocale;
  copy: ProviderAccessCopy;
  state: ProviderAccessState;
  setField: ProviderAccessFieldSetter;
}) {
  const {
    providers,
    gcpSetupInventory,
    gcpSetupInstances,
    selectedGcpProjectId,
    selectedGcpInstanceId,
    gcpEnvironmentClassification,
    gcpProductionApproved,
    gcpRestartApproved,
    gcpPermissionCheck,
    gcpIamRoleGrantApproved,
    mutation,
  } = state;
  const setGcpSetupInventory = setField("gcpSetupInventory");
  const setGcpSetupInstances = setField("gcpSetupInstances");
  const setSelectedGcpProjectId = setField("selectedGcpProjectId");
  const setSelectedGcpInstanceId = setField("selectedGcpInstanceId");
  const setGcpEnvironmentClassification = setField("gcpEnvironmentClassification");
  const setGcpProductionApproved = setField("gcpProductionApproved");
  const setGcpRestartApproved = setField("gcpRestartApproved");
  const setGcpPermissionCheck = setField("gcpPermissionCheck");
  const setGcpIamRoleGrantApproved = setField("gcpIamRoleGrantApproved");
  const setGcpSetupError = setField("gcpSetupError");
  const setGcpSetupReconnectRequired = setField("gcpSetupReconnectRequired");
  const setMutation = setField("mutation");

  useEffect(() => {
    if (!gcpSetupId) {
      setGcpSetupInventory(null);
      setGcpSetupInstances([]);
      setGcpEnvironmentClassification("");
      setGcpPermissionCheck(null);
      setGcpIamRoleGrantApproved(false);
      setGcpSetupError("");
      setGcpSetupReconnectRequired(false);
      return;
    }
    const controller = new AbortController();
    setMutation("gcp:projects");
    setGcpSetupError("");
    setGcpSetupReconnectRequired(false);
    void fetch(
      `/api/v1/workspaces/${workspaceId}/provider-integrations/gcp-setup/${gcpSetupId}?kind=projects`,
      { cache: "no-store", signal: controller.signal },
    ).then(async (response) => {
      if (!response.ok) {
        if (response.status === 401 || response.status === 410) {
          setGcpSetupReconnectRequired(true);
          throw new Error(copy.gcpSessionExpired);
        }
        throw new Error(await providerResponseError(response, copy.gcpProjectsError, locale));
      }
      const body = await response.json().catch(() => null);
      if (
        typeof body?.account !== "string"
        || typeof body?.expiresAt !== "string"
        || !Array.isArray(body?.projects)
      ) {
        throw new Error(copy.gcpProjectsShapeError);
      }
      setGcpSetupInventory(body as GcpSetupInventory);
      setGcpSetupReconnectRequired(false);
    }).catch((cause) => {
      if (!controller.signal.aborted) {
        setGcpSetupError(cause instanceof Error
          ? localizedProviderMessage(cause.message, locale, copy.gcpStartError)
          : copy.gcpStartError);
      }
    }).finally(() => {
      if (!controller.signal.aborted) setMutation("");
    });
    return () => controller.abort();
  }, [
    copy,
    gcpSetupId,
    locale,
    setGcpEnvironmentClassification,
    setGcpIamRoleGrantApproved,
    setGcpPermissionCheck,
    setGcpSetupError,
    setGcpSetupInstances,
    setGcpSetupInventory,
    setGcpSetupReconnectRequired,
    setMutation,
    workspaceId,
  ]);

  async function selectGcpProject(projectId: string) {
    if (!gcpSetupId || mutation) return;
    setSelectedGcpProjectId(projectId);
    setSelectedGcpInstanceId("");
    setGcpSetupInstances([]);
    setGcpEnvironmentClassification("");
    setGcpProductionApproved(false);
    setGcpRestartApproved(false);
    setGcpPermissionCheck(null);
    setGcpIamRoleGrantApproved(false);
    if (!projectId) return;
    setMutation("gcp:instances");
    setGcpSetupError("");
    try {
      const query = new URLSearchParams({ kind: "instances", project: projectId });
      const permissionQuery = new URLSearchParams({ kind: "permissions", project: projectId });
      const [response, permissionResponse] = await Promise.all([
        fetch(
          `/api/v1/workspaces/${workspaceId}/provider-integrations/gcp-setup/${gcpSetupId}?${query}`,
          { cache: "no-store" },
        ).catch(() => null),
        fetch(
          `/api/v1/workspaces/${workspaceId}/provider-integrations/gcp-setup/${gcpSetupId}?${permissionQuery}`,
          { cache: "no-store" },
        ).catch(() => null),
      ]);
      if (!response?.ok || !permissionResponse?.ok) {
        const failedResponse = response?.ok ? permissionResponse : response;
        if (failedResponse?.status === 401 || failedResponse?.status === 410) {
          setGcpSetupReconnectRequired(true);
          setGcpSetupError(copy.gcpSessionExpired);
          return;
        }
        setGcpSetupError(await providerResponseError(
          failedResponse,
          response?.ok ? copy.gcpPermissionsError : copy.gcpInstancesError,
          locale,
        ));
        return;
      }
      const body = await response.json().catch(() => null);
      const permissionBody = await permissionResponse.json().catch(() => null);
      const permissionCheck = parseGcpSetupPermissionCheck(permissionBody?.permissions);
      if (!Array.isArray(body?.instances) || !permissionCheck) {
        setGcpSetupError(copy.gcpSetupShapeError);
        return;
      }
      setGcpSetupInstances(body.instances as GcpSetupInstance[]);
      setGcpPermissionCheck(permissionCheck);
    } finally {
      setMutation("");
    }
  }

  function selectGcpInstance(instanceId: string) {
    setSelectedGcpInstanceId(instanceId);
    setGcpEnvironmentClassification("");
    setGcpProductionApproved(false);
    setGcpRestartApproved(false);
    setGcpIamRoleGrantApproved(false);
  }

  async function completeGcpSetup() {
    if (!gcpSetupId || mutation || !gcpSetupInventory) return;
    const project = gcpSetupInventory.projects.find((item) => item.id === selectedGcpProjectId);
    const instance = gcpSetupInstances.find((item) => item.id === selectedGcpInstanceId);
    if (
      !project
      || !instance
      || !instance.ready
      || (instance.production === "unknown" && gcpEnvironmentClassification === "")
      || ((
        instance.production === true
        || (instance.production === "unknown" && gcpEnvironmentClassification === "production")
      ) && !gcpProductionApproved)
      || (!instance.iamAuthenticationEnabled && !gcpRestartApproved)
      || !gcpPermissionCheck
      || (gcpPermissionCheck.missing.length > 0 && (
        !gcpPermissionCheck.canAutoGrant || !gcpIamRoleGrantApproved
      ))
    ) {
      setGcpSetupError(copy.gcpApprovalsRequired);
      return;
    }
    setMutation("gcp:bootstrap");
    setGcpSetupError("");
    try {
      const bootstrapResponse = await fetch(
        `/api/v1/workspaces/${workspaceId}/provider-integrations/gcp-setup/${gcpSetupId}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectId: project.id,
            projectNumber: project.number,
            instanceId: instance.id,
            environmentClassification: instance.production === "unknown"
              ? gcpEnvironmentClassification
              : null,
            approveProduction: gcpProductionApproved,
            approveInstanceRestart: gcpRestartApproved,
            approveIamRoleGrant: gcpIamRoleGrantApproved,
          }),
        },
      ).catch(() => null);
      if (!bootstrapResponse?.ok) {
        const failure = await bootstrapResponse?.json().catch(() => null);
        if (bootstrapResponse?.status === 401 || bootstrapResponse?.status === 410) {
          setGcpSetupReconnectRequired(true);
          setGcpSetupError(copy.gcpSessionExpired);
          return;
        }
        const permissionCheck = parseGcpSetupPermissionCheck(failure?.permissions);
        if (permissionCheck) {
          setGcpPermissionCheck(permissionCheck);
          setGcpIamRoleGrantApproved(false);
        }
        setGcpSetupError(typeof failure?.error === "string"
          ? localizedProviderMessage(failure.error, locale, copy.gcpBootstrapError)
          : copy.gcpBootstrapError);
        return;
      }
      const bootstrap = await bootstrapResponse.json().catch(() => null);
      if (typeof bootstrap?.bootstrapTicket !== "string" || bootstrap.bootstrapTicket.length < 80) {
        setGcpSetupError(copy.gcpBootstrapShapeError);
        return;
      }
      const integrationResponse = await fetch(
        `/api/v1/workspaces/${workspaceId}/provider-integrations`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            provider: "gcpCloudSql",
            setupId: gcpSetupId,
            bootstrapTicket: bootstrap.bootstrapTicket,
          }),
        },
      ).catch(() => null);
      if (!integrationResponse?.ok) {
        setGcpSetupError(await providerResponseError(integrationResponse, copy.gcpSaveError, locale));
        return;
      }
      const integrationBody = await integrationResponse.json().catch(() => null);
      const integrationId = typeof integrationBody?.integration?.id === "string"
        ? integrationBody.integration.id
        : "";
      if (!integrationId) {
        setGcpSetupError(copy.gcpSavedShapeError);
        return;
      }
      setGcpSetupInventory(null);
      setGcpSetupInstances([]);
      setSelectedGcpProjectId("");
      setSelectedGcpInstanceId("");
      setGcpEnvironmentClassification("");
      setGcpPermissionCheck(null);
      setGcpIamRoleGrantApproved(false);
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.delete("provider");
      nextUrl.searchParams.delete("status");
      nextUrl.searchParams.delete("gcpSetup");
      nextUrl.searchParams.set("section", "databases");
      nextUrl.searchParams.set("integration", integrationId);
      window.location.replace(nextUrl);
    } finally {
      setMutation("");
    }
  }

  function reconnectGcpSetup(connect: (provider: ProviderAccessState["providers"][number]) => Promise<void>) {
    const provider = providers.find((item) => item.id === "gcpCloudSql");
    if (!provider?.configured) {
      setGcpSetupError(copy.reconnectStartError);
      return;
    }
    setGcpSetupError("");
    void connect(provider);
  }

  return {
    completeGcpSetup,
    reconnectGcpSetup,
    selectGcpInstance,
    selectGcpProject,
  };
}
