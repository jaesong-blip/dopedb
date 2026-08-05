"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";

import {
  canUseLocalProviderCredential,
  emptyNeon,
  emptyNeonBootstrap,
  parseGcpSetupPermissionCheck,
  parseNeonBootstrapApply,
  parseNeonBootstrapPreflight,
  providerImportDisplayName,
  type GcpSetupInstance,
  type GcpSetupInventory,
  type Integration,
  type NeonConfiguration,
  type PendingProviderImport,
  type Provider,
  type Resource,
  type ResourceLevel,
  type SharedConnection,
} from "./domain";
import { useProviderAccessState } from "./state";

async function responseError(response: Response | null, fallback: string) {
  const body = await response?.json().catch(() => null);
  return typeof body?.error === "string" ? body.error : fallback;
}

export function useProviderAccess(
  workspaceId: string,
  gcpSetupId: string | null = null,
  initialIntegrationId: string | null = null,
) {
  const [state, setField] = useProviderAccessState();
  const {
    providers,
    integrations,
    connections,
    managedConnections,
    selectedConnectionId,
    selectedIntegrationId,
    selection,
    resourceOptions,
    setupProviderId,
    neonConfiguration,
    neonEnvironmentClassification,
    neonBootstrap,
    neonPublicAclApproved,
    neonProductionApproved,
    gcpSetupInventory,
    gcpSetupInstances,
    selectedGcpProjectId,
    selectedGcpInstanceId,
    gcpEnvironmentClassification,
    gcpProductionApproved,
    gcpRestartApproved,
    gcpPermissionCheck,
    gcpIamRoleGrantApproved,
    gcpSetupError,
    gcpSetupReconnectRequired,
    loading,
    resourcePending,
    mutation,
    error,
  } = state;
  const setProviders = setField("providers");
  const setIntegrations = setField("integrations");
  const setConnections = setField("connections");
  const setManagedConnections = setField("managedConnections");
  const setSelectedConnectionId = setField("selectedConnectionId");
  const setSelectedIntegrationId = setField("selectedIntegrationId");
  const setSelection = setField("selection");
  const setResourceOptions = setField("resourceOptions");
  const setSetupProviderId = setField("setupProviderId");
  const setNeonConfiguration = setField("neonConfiguration");
  const setNeonEnvironmentClassification = setField("neonEnvironmentClassification");
  const setNeonBootstrap = setField("neonBootstrap");
  const setNeonPublicAclApproved = setField("neonPublicAclApproved");
  const setNeonProductionApproved = setField("neonProductionApproved");
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
  const setLoading = setField("loading");
  const setResourcePending = setField("resourcePending");
  const setMutation = setField("mutation");
  const setError = setField("error");
  const pendingImportRef = useRef<PendingProviderImport | null>(null);
  const pendingNeonApplyRef = useRef<{
    integrationId: string;
    planHash: string;
    body: string;
  } | null>(null);

  const selectedConnection = useMemo(
    () => connections.find((item) => item.id === selectedConnectionId) ?? null,
    [connections, selectedConnectionId],
  );
  const selectedIntegration = integrations.find(
    (item) => item.id === selectedIntegrationId,
  ) ?? null;
  const selectedProvider = providers.find(
    (item) => item.id === selectedIntegration?.provider,
  ) ?? null;
  const setupProvider = providers.find((item) => item.id === setupProviderId) ?? null;
  const currentManagedConnection = managedConnections.find(
    (item) => item.connectionId === selectedConnectionId,
  ) ?? null;
  const importReceipt = useMemo(() => {
    if (selectedProvider?.id === "neon") {
      return neonBootstrap.receipt || null;
    }
    const finalLevel = selectedProvider?.resourceLevels.at(-1);
    if (!finalLevel) return null;
    return resourceOptions[finalLevel.key]?.find(
      (item) => item.value === selection[finalLevel.key],
    )?.receipt ?? null;
  }, [
    neonBootstrap.receipt,
    resourceOptions,
    selectedProvider?.id,
    selectedProvider?.resourceLevels,
    selection,
  ]);

  useEffect(() => {
    const pending = pendingImportRef.current;
    if (
      pending
      && (
        pending.integrationId !== selectedIntegrationId
        || pending.connectionId !== (
          selectedConnection?.credentialMode === "member_local"
            ? selectedConnection.id
            : null
        )
        || pending.receipt !== importReceipt
      )
    ) {
      pendingImportRef.current = null;
    }
  }, [importReceipt, selectedConnection, selectedIntegrationId]);

  const resetNeonBootstrap = useCallback(() => {
    pendingNeonApplyRef.current = null;
    setNeonEnvironmentClassification("");
    setNeonBootstrap(emptyNeonBootstrap);
    setNeonPublicAclApproved(false);
    setNeonProductionApproved(false);
  }, []);

  const resetResources = useCallback(() => {
    pendingImportRef.current = null;
    setSelection({});
    setResourceOptions({});
    resetNeonBootstrap();
  }, []);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    const [providerResponse, connectionResponse] = await Promise.all([
      fetch(`/api/v1/workspaces/${workspaceId}/provider-integrations`, {
        cache: "no-store",
        signal,
      }).catch(() => null),
      fetch(`/api/v1/workspaces/${workspaceId}/connections`, {
        cache: "no-store",
        signal,
      }).catch(() => null),
    ]);
    if (signal?.aborted) return;
    if (!providerResponse?.ok || !connectionResponse?.ok) {
      setError(await responseError(
        providerResponse?.ok ? connectionResponse : providerResponse,
        "관리형 접근 설정을 불러오지 못했습니다.",
      ));
      setLoading(false);
      return;
    }
    const providerBody = await providerResponse.json().catch(() => null);
    const connectionBody = await connectionResponse.json().catch(() => null);
    if (
      !Array.isArray(providerBody?.providers)
      || !Array.isArray(providerBody?.integrations)
      || !Array.isArray(providerBody?.managedConnections)
      || !Array.isArray(connectionBody?.connections)
    ) {
      setError("관리형 접근 응답 형식을 확인하지 못했습니다.");
      setLoading(false);
      return;
    }
    const nextConnections = connectionBody.connections as SharedConnection[];
    const nextIntegrations = providerBody.integrations as Integration[];
    setProviders(providerBody.providers);
    setIntegrations(nextIntegrations);
    setManagedConnections(providerBody.managedConnections);
    setConnections(nextConnections);
    setSelectedConnectionId((current) => (
      nextConnections.some((item) => item.id === current)
        ? current
        : nextConnections[0]?.id ?? ""
    ));
    setSelectedIntegrationId((current) => (
      nextIntegrations.some((item) => item.id === current)
        ? current
        : nextIntegrations.find((item) => item.id === initialIntegrationId)?.id
          ?? nextIntegrations[0]?.id
          ?? ""
    ));
    setError("");
    setLoading(false);
  }, [initialIntegrationId, workspaceId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

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
      `/api/v1/workspaces/${workspaceId}/provider-integrations/gcp-setup/${
        gcpSetupId
      }?kind=projects`,
      { cache: "no-store", signal: controller.signal },
    ).then(async (response) => {
      if (!response.ok) {
        if (response.status === 401 || response.status === 410) {
          setGcpSetupReconnectRequired(true);
          throw new Error(
            "Google Cloud 승인 세션이 만료되었습니다. 계정을 다시 연결해 계속하세요.",
          );
        }
        throw new Error(await responseError(
          response,
          "Google Cloud 프로젝트를 불러오지 못했습니다.",
        ));
      }
      const body = await response.json().catch(() => null);
      if (
        typeof body?.account !== "string"
        || typeof body?.expiresAt !== "string"
        || !Array.isArray(body?.projects)
      ) {
        throw new Error("Google Cloud 프로젝트 응답 형식을 확인하지 못했습니다.");
      }
      setGcpSetupInventory(body as GcpSetupInventory);
      setGcpSetupReconnectRequired(false);
    }).catch((cause) => {
      if (!controller.signal.aborted) {
        setGcpSetupError(
          cause instanceof Error
            ? cause.message
            : "Google Cloud 연결을 시작하지 못했습니다.",
        );
      }
    }).finally(() => {
      if (!controller.signal.aborted) setMutation("");
    });
    return () => controller.abort();
  }, [gcpSetupId, workspaceId]);

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
      const permissionQuery = new URLSearchParams({
        kind: "permissions",
        project: projectId,
      });
      const [response, permissionResponse] = await Promise.all([
        fetch(
          `/api/v1/workspaces/${workspaceId}/provider-integrations/gcp-setup/${
            gcpSetupId
          }?${query}`,
          { cache: "no-store" },
        ).catch(() => null),
        fetch(
          `/api/v1/workspaces/${workspaceId}/provider-integrations/gcp-setup/${
            gcpSetupId
          }?${permissionQuery}`,
          { cache: "no-store" },
        ).catch(() => null),
      ]);
      if (!response?.ok || !permissionResponse?.ok) {
        const failedResponse = response?.ok ? permissionResponse : response;
        if (failedResponse?.status === 401 || failedResponse?.status === 410) {
          setGcpSetupReconnectRequired(true);
          setGcpSetupError(
            "Google Cloud 승인 세션이 만료되었습니다. 계정을 다시 연결해 계속하세요.",
          );
          return;
        }
        setGcpSetupError(await responseError(
          failedResponse,
          response?.ok
            ? "Google Cloud 설정 권한을 확인하지 못했습니다."
            : "Cloud SQL 인스턴스를 불러오지 못했습니다.",
        ));
        return;
      }
      const body = await response.json().catch(() => null);
      const permissionBody = await permissionResponse.json().catch(() => null);
      const permissionCheck = parseGcpSetupPermissionCheck(
        permissionBody?.permissions,
      );
      if (!Array.isArray(body?.instances) || !permissionCheck) {
        setGcpSetupError("Google Cloud 설정 응답 형식을 확인하지 못했습니다.");
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
    const project = gcpSetupInventory.projects.find(
      (item) => item.id === selectedGcpProjectId,
    );
    const instance = gcpSetupInstances.find(
      (item) => item.id === selectedGcpInstanceId,
    );
    if (
      !project
      || !instance
      || !instance.ready
      || (
        instance.production === "unknown"
        && gcpEnvironmentClassification === ""
      )
      || (
        (
          instance.production === true
          || (
            instance.production === "unknown"
            && gcpEnvironmentClassification === "production"
          )
        )
        && !gcpProductionApproved
      )
      || (!instance.iamAuthenticationEnabled && !gcpRestartApproved)
      || !gcpPermissionCheck
      || (
        gcpPermissionCheck.missing.length > 0
        && (
          !gcpPermissionCheck.canAutoGrant
          || !gcpIamRoleGrantApproved
        )
      )
    ) {
      setGcpSetupError("Cloud SQL 대상과 필요한 승인을 확인하세요.");
      return;
    }
    setMutation("gcp:bootstrap");
    setGcpSetupError("");
    try {
      const bootstrapResponse = await fetch(
        `/api/v1/workspaces/${workspaceId}/provider-integrations/gcp-setup/${
          gcpSetupId
        }`,
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
        if (
          bootstrapResponse?.status === 401
          || bootstrapResponse?.status === 410
        ) {
          setGcpSetupReconnectRequired(true);
          setGcpSetupError(
            "Google Cloud 승인 세션이 만료되었습니다. 계정을 다시 연결해 계속하세요.",
          );
          return;
        }
        const permissionCheck = parseGcpSetupPermissionCheck(
          failure?.permissions,
        );
        if (permissionCheck) {
          setGcpPermissionCheck(permissionCheck);
          setGcpIamRoleGrantApproved(false);
        }
        setGcpSetupError(
          typeof failure?.error === "string"
            ? failure.error
            : "Google Cloud 자동 설정을 완료하지 못했습니다.",
        );
        return;
      }
      const bootstrap = await bootstrapResponse.json().catch(() => null);
      if (
        typeof bootstrap?.bootstrapTicket !== "string"
        || bootstrap.bootstrapTicket.length < 80
      ) {
        setGcpSetupError("Google Cloud 자동 설정 결과를 확인하지 못했습니다.");
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
        setGcpSetupError(await responseError(
          integrationResponse,
          "Google Cloud 연결을 저장하지 못했습니다.",
        ));
        return;
      }
      const integrationBody = await integrationResponse.json().catch(() => null);
      const integrationId = typeof integrationBody?.integration?.id === "string"
        ? integrationBody.integration.id
        : "";
      if (!integrationId) {
        setGcpSetupError("저장된 Google Cloud 연결을 확인하지 못했습니다.");
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

  const discover = useCallback(async (
    level: ResourceLevel,
    integrationId: string,
    values: Record<string, string>,
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams({ kind: level.kind, ...values });
    setResourcePending(true);
    const response = await fetch(
      `/api/v1/workspaces/${workspaceId}/provider-integrations/${
        integrationId
      }/resources?${query}`,
      { cache: "no-store", signal },
    ).catch(() => null);
    if (signal?.aborted) return null;
    setResourcePending(false);
    if (!response?.ok) {
      setError(await responseError(response, "공급자 리소스를 불러오지 못했습니다."));
      return null;
    }
    const body = await response.json().catch(() => null);
    if (!Array.isArray(body?.resources)) {
      setError("공급자 리소스 응답 형식을 확인하지 못했습니다.");
      return null;
    }
    setError("");
    return body.resources as Resource[];
  }, [workspaceId]);

  useEffect(() => {
    const first = selectedProvider?.resourceLevels[0];
    if (!selectedIntegrationId || !first) {
      resetResources();
      return;
    }
    const controller = new AbortController();
    resetResources();
    void discover(first, selectedIntegrationId, {}, controller.signal).then((rows) => {
      if (!rows || controller.signal.aborted) return;
      setResourceOptions({ [first.key]: rows });
    });
    return () => controller.abort();
  }, [
    discover,
    resetResources,
    selectedIntegrationId,
    selectedProvider?.id,
  ]);

  async function connect(provider: Provider, configuration?: object) {
    if (mutation) return;
    setMutation(`connect:${provider.id}`);
    setError("");
    try {
      const response = await fetch(
        `/api/v1/workspaces/${workspaceId}/provider-integrations`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider: provider.id, configuration }),
        },
      ).catch(() => null);
      if (!response?.ok) {
        setError(await responseError(response, "공급자 연결을 시작하지 못했습니다."));
        return;
      }
      const body = await response.json().catch(() => null);
      if (provider.setupKind === "oauth") {
        if (typeof body?.authorizationUrl !== "string") {
          setError("공급자 인증 주소를 확인하지 못했습니다.");
          return;
        }
        window.location.assign(body.authorizationUrl);
        return;
      }
      setNeonConfiguration(emptyNeon);
      setSetupProviderId("");
      resetResources();
      await load();
    } finally {
      setMutation("");
    }
  }

  function beginConnect(provider: Provider) {
    if (provider.setupKind === "oauth") {
      void connect(provider);
      return;
    }
    const next = setupProviderId === provider.id ? "" : provider.id;
    if (next !== "neon") setNeonConfiguration(emptyNeon);
    setSetupProviderId(next);
    setError("");
  }

  function reconnectGcpSetup() {
    const provider = providers.find((item) => item.id === "gcpCloudSql");
    if (!provider?.configured) {
      setGcpSetupError(
        "Google Cloud 연결을 다시 시작할 수 없습니다. 페이지를 새로고침해 주세요.",
      );
      return;
    }
    setGcpSetupError("");
    void connect(provider);
  }

  async function disconnect(integration: Integration) {
    if (mutation || !window.confirm(
      "연결된 DB는 구성원별 자격증명 모드로 돌아갑니다. 공급자 연결을 해제할까요?",
    )) return;
    setMutation(`disconnect:${integration.id}`);
    setError("");
    try {
      const response = await fetch(
        `/api/v1/workspaces/${workspaceId}/provider-integrations/${integration.id}`,
        { method: "DELETE" },
      ).catch(() => null);
      if (!response?.ok) {
        setError(await responseError(response, "공급자 연결을 해제하지 못했습니다."));
        return;
      }
      resetResources();
      await load();
    } finally {
      setMutation("");
    }
  }

  async function deleteSharedConnection(connection: SharedConnection) {
    if (
      mutation
      || connection.accessMode !== "manage"
      || !Number.isInteger(connection.revision)
      || connection.revision < 1
      || !window.confirm(
        `공유 DB '${connection.name}'을 제거할까요? 활성 자격증명과 실행 세션이 종료됩니다.`,
      )
    ) {
      return;
    }
    setMutation(`delete-connection:${connection.id}`);
    setError("");
    try {
      const response = await fetch(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}`
        + `/connections/${encodeURIComponent(connection.id)}`,
        {
          method: "DELETE",
          headers: { "if-match": `"${connection.revision}"` },
        },
      ).catch(() => null);
      if (!response?.ok) {
        setError(await responseError(response, "공유 DB를 제거하지 못했습니다."));
        return;
      }
      resetResources();
      await load();
    } finally {
      setMutation("");
    }
  }

  async function selectResource(levelIndex: number, value: string) {
    if (!selectedProvider || !selectedIntegrationId) return;
    resetNeonBootstrap();
    const levels = selectedProvider.resourceLevels;
    const level = levels[levelIndex];
    const nextSelection = Object.fromEntries(
      levels.slice(0, levelIndex).map((item) => [item.key, selection[item.key] ?? ""]),
    );
    nextSelection[level.key] = value;
    setSelection(nextSelection);
    setResourceOptions((current) => Object.fromEntries(
      Object.entries(current).filter(([key]) => (
        levels.findIndex((item) => item.key === key) <= levelIndex
      )),
    ));
    const nextLevel = levels[levelIndex + 1];
    if (!value) return;
    if (!nextLevel) return;
    const rows = await discover(nextLevel, selectedIntegrationId, nextSelection);
    if (rows) {
      setResourceOptions((current) => ({ ...current, [nextLevel.key]: rows }));
    }
  }

  function selectedNeonEnvironment() {
    if (selectedProvider?.id !== "neon") return null;
    const branchLevel = selectedProvider.resourceLevels.find(
      (level) => level.kind === "branches",
    );
    const branch = branchLevel
      ? resourceOptions[branchLevel.key]?.find(
          (item) => item.value === selection[branchLevel.key],
        )
      : null;
    if (branch?.production === true) return "production" as const;
    if (branch?.production === false) return "development" as const;
    return neonEnvironmentClassification || null;
  }

  function classifyNeonEnvironment(
    value: "" | "development" | "production",
  ) {
    pendingImportRef.current = null;
    pendingNeonApplyRef.current = null;
    setNeonEnvironmentClassification(value);
    setNeonBootstrap(emptyNeonBootstrap);
    setNeonPublicAclApproved(false);
    setNeonProductionApproved(false);
    setError("");
  }

  async function preflightNeonBootstrap() {
    if (
      selectedProvider?.id !== "neon"
      || !selectedIntegration
      || mutation
    ) return;
    const finalLevel = selectedProvider.resourceLevels.at(-1)!;
    const finalResource = resourceOptions[finalLevel.key]?.find(
      (item) => item.value === selection[finalLevel.key],
    );
    const environment = selectedNeonEnvironment();
    if (!finalResource?.selectionProof || finalResource.ready !== true) {
      setError("Neon 데이터베이스를 다시 선택해 주세요.");
      return;
    }
    if (!environment) {
      setError("Neon 브랜치가 개발용인지 운영용인지 먼저 선택해 주세요.");
      return;
    }
    setMutation("neon:preflight");
    setError("");
    pendingNeonApplyRef.current = null;
    setNeonBootstrap(emptyNeonBootstrap);
    setNeonPublicAclApproved(false);
    setNeonProductionApproved(false);
    try {
      const response = await fetch(
        `/api/v1/workspaces/${workspaceId}/provider-integrations/${
          selectedIntegration.id
        }/neon-bootstrap`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "preflight",
            selectionProof: finalResource.selectionProof,
            environment,
          }),
        },
      ).catch(() => null);
      if (!response?.ok) {
        setError(await responseError(
          response,
          "Neon 최소권한 사전 점검을 완료하지 못했습니다.",
        ));
        return;
      }
      const parsed = parseNeonBootstrapPreflight(
        await response.json().catch(() => null),
      );
      const projectLevel = selectedProvider.resourceLevels.find(
        (level) => level.kind === "projects",
      );
      const branchLevel = selectedProvider.resourceLevels.find(
        (level) => level.kind === "branches",
      );
      if (
        !parsed
        || !projectLevel
        || !branchLevel
        || parsed.report.target.project !== selection[projectLevel.key]
        || parsed.report.target.branch !== selection[branchLevel.key]
        || parsed.report.target.databaseId !== finalResource.id
      ) {
        setError("Neon 사전 점검 응답 형식을 확인하지 못했습니다.");
        return;
      }
      setNeonBootstrap({
        ...parsed,
        receipt: "",
        receiptExpiresAt: "",
      });
    } finally {
      setMutation("");
    }
  }

  async function applyNeonBootstrap() {
    if (
      selectedProvider?.id !== "neon"
      || !selectedIntegration
      || !neonBootstrap.report
      || !neonBootstrap.plan
      || mutation
    ) return;
    if (Date.parse(neonBootstrap.planExpiresAt) <= Date.now()) {
      setNeonBootstrap(emptyNeonBootstrap);
      setNeonPublicAclApproved(false);
      setNeonProductionApproved(false);
      setError("Neon 사전 점검이 만료되었습니다. 다시 점검해 주세요.");
      return;
    }
    if (neonBootstrap.report.status === "blocked") {
      setError("차단 항목을 해결한 뒤 사전 점검을 다시 실행해 주세요.");
      return;
    }
    if (
      neonBootstrap.report.requiresPublicAclApproval
      && !neonPublicAclApproved
    ) {
      setError("표시된 PUBLIC 권한 변경을 먼저 승인해 주세요.");
      return;
    }
    if (
      neonBootstrap.report.requiresProductionApproval
      && !neonProductionApproved
    ) {
      setError("운영 데이터베이스 변경을 먼저 승인해 주세요.");
      return;
    }
    setMutation("neon:apply");
    setError("");
    try {
      let pending = pendingNeonApplyRef.current;
      if (
        !pending
        || pending.integrationId !== selectedIntegration.id
        || pending.planHash !== neonBootstrap.report.planHash
      ) {
        pending = {
          integrationId: selectedIntegration.id,
          planHash: neonBootstrap.report.planHash,
          body: JSON.stringify({
            action: "apply",
            plan: neonBootstrap.plan,
            idempotencyKey: crypto.randomUUID(),
            publicAclApproved: neonPublicAclApproved,
            productionApproved: neonProductionApproved,
          }),
        };
        pendingNeonApplyRef.current = pending;
      }
      const response = await fetch(
        `/api/v1/workspaces/${workspaceId}/provider-integrations/${
          selectedIntegration.id
        }/neon-bootstrap`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: pending.body,
        },
      ).catch(() => null);
      if (!response?.ok) {
        setError(await responseError(
          response,
          "Neon 최소권한 설정과 검증을 완료하지 못했습니다.",
        ));
        return;
      }
      const parsed = parseNeonBootstrapApply(
        await response.json().catch(() => null),
      );
      if (
        !parsed
        || parsed.report.planHash !== neonBootstrap.report.planHash
        || parsed.report.target.project !== neonBootstrap.report.target.project
        || parsed.report.target.branch !== neonBootstrap.report.target.branch
        || parsed.report.target.databaseId !== neonBootstrap.report.target.databaseId
      ) {
        setError("Neon 설정·검증 응답 형식을 확인하지 못했습니다.");
        return;
      }
      setNeonBootstrap((current) => ({
        ...current,
        report: parsed.report,
        receipt: parsed.receipt,
        receiptExpiresAt: parsed.receiptExpiresAt,
      }));
      pendingNeonApplyRef.current = null;
    } finally {
      setMutation("");
    }
  }

  async function switchToMemberLocal() {
    if (!selectedConnection || mutation) return;
    setMutation(`mode:${selectedConnection.id}`);
    setError("");
    try {
      const response = await fetch(
        `/api/v1/workspaces/${workspaceId}/connections/${
          selectedConnection.id
        }/managed-access`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "member_local" }),
        },
      ).catch(() => null);
      if (!response?.ok) {
        setError(await responseError(response, "DB 접근 방식을 변경하지 못했습니다."));
        return;
      }
      await load();
    } finally {
      setMutation("");
    }
  }

  async function importDiscoveredResource() {
    if (
      !selectedIntegration
      || !selectedProvider
      || mutation
    ) return;
    const finalLevel = selectedProvider.resourceLevels.at(-1)!;
    const finalResource = resourceOptions[finalLevel.key]?.find(
      (item) => item.value === selection[finalLevel.key],
    );
    const isNeon = selectedProvider.id === "neon";
    if (
      !finalResource?.selectionProof
      || (!isNeon && (
        finalResource.production !== false
        && finalResource.production !== true
      ))
      || finalResource.ready !== true
    ) return;
    if (
      isNeon
      && (
        !neonBootstrap.report
        || !neonBootstrap.receipt
        || !neonBootstrap.receiptExpiresAt
        || Date.parse(neonBootstrap.receiptExpiresAt) <= Date.now()
      )
    ) {
      setError("Neon 설정 검증이 만료되었습니다. 사전 점검부터 다시 실행해 주세요.");
      return;
    }
    const productionApproved = isNeon
      ? neonBootstrap.report?.production === true
      : finalResource.production === true;
    const replacementConnection =
      selectedConnection?.credentialMode === "member_local"
        ? selectedConnection
        : null;
    const connectionId = replacementConnection?.id ?? null;
    const name = replacementConnection
      ? replacementConnection.name
      : providerImportDisplayName(selectedProvider.name, finalResource.name);
    if (!name) return;
    const confirmation = productionApproved
      ? `경고: ${finalResource.name}은 운영 데이터베이스로 분류되었습니다. `
        + "실행 중인 쿼리는 실제 운영 데이터에 영향을 줄 수 있습니다. "
        + "기본 쓰기 꺼짐인 관리형 연결로 전환하고 이 승인을 감사 기록에 남길까요? "
        + "쓰기 허용 여부는 이후 DB별 접근 권한에서 별도로 정합니다."
      : replacementConnection
        ? `${replacementConnection.name} 연결을 ${finalResource.name} 관리형 대상으로 전환할까요? `
          + "연결 ID와 대시보드 참조는 유지되고, 기존 구성원별 비밀번호는 더 이상 사용하지 않습니다."
        : null;
    if (confirmation && !window.confirm(confirmation)) return;
    setMutation(`import:${selectedIntegration.id}`);
    setError("");
    try {
      let receipt = importReceipt;
      if (
        !isNeon
        && (
          !receipt
          || !finalResource.receiptExpiresAt
          || Date.parse(finalResource.receiptExpiresAt) <= Date.now()
        )
      ) {
        const proof = finalResource.selectionProof;
        const receiptResponse = await fetch(
          `/api/v1/workspaces/${workspaceId}/provider-integrations/${
            selectedIntegration.id
          }/resources`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ selectionProof: proof }),
          },
        ).catch(() => null);
        if (!receiptResponse?.ok) {
          setError(await responseError(
            receiptResponse,
            "선택한 공급자 리소스를 확인하지 못했습니다.",
          ));
          return;
        }
        const receiptBody = await receiptResponse.json().catch(() => null);
        if (
          typeof receiptBody?.receipt !== "string"
          || typeof receiptBody?.receiptExpiresAt !== "string"
        ) {
          setError("공급자 리소스 확인 응답 형식을 확인하지 못했습니다.");
          return;
        }
        receipt = receiptBody.receipt;
        setResourceOptions((current) => ({
          ...current,
          [finalLevel.key]: (current[finalLevel.key] ?? []).map((item) => (
            item.selectionProof === proof
              ? {
                ...item,
                receipt: receiptBody.receipt,
                receiptExpiresAt: receiptBody.receiptExpiresAt,
              }
              : item
          )),
        }));
      }
      if (!receipt) return;
      let pending = pendingImportRef.current;
      if (
        !pending
        || pending.integrationId !== selectedIntegration.id
        || pending.connectionId !== connectionId
        || pending.receipt !== receipt
        || pending.name !== name
      ) {
        const idempotencyKey = crypto.randomUUID();
        pending = {
          integrationId: selectedIntegration.id,
          connectionId,
          receipt,
          name,
          body: JSON.stringify({
            connectionId,
            receipt,
            idempotencyKey,
            name,
            productionApproved,
          }),
        };
        pendingImportRef.current = pending;
      }
      const response = await fetch(
        `/api/v1/workspaces/${workspaceId}/provider-integrations/${selectedIntegration.id}/imports`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: pending.body,
        },
      ).catch(() => null);
      if (!response?.ok) {
        setError(await responseError(response, "관리형 연결을 가져오지 못했습니다."));
        return;
      }
      pendingImportRef.current = null;
      resetResources();
      await load();
    } finally {
      setMutation("");
    }
  }

  const finalResourceLevel = selectedProvider?.resourceLevels.at(-1);
  const resourceComplete = Boolean(
    selectedProvider?.resourceLevels.every((level) => selection[level.key])
      && finalResourceLevel
      && resourceOptions[finalResourceLevel.key]?.some(
        (item) => (
          item.value === selection[finalResourceLevel.key]
          && item.ready === true
          && typeof item.selectionProof === "string"
          && (
            selectedProvider.id === "neon"
            || item.production === false
            || item.production === true
          )
        ),
      ),
  );
  const currentProvider = providers.find(
    (item) => item.id === currentManagedConnection?.provider,
  ) ?? null;
  const currentResourceLabel = currentManagedConnection && currentProvider
    ? currentProvider.resourceLevels
      .map((level) => currentManagedConnection.resource[level.key])
      .filter(Boolean)
      .join(" / ")
    : "";
  // Only the managed projection returned for a canonical provider import may
  // offer a member-local handoff. The server repeats this proof atomically;
  // this predicate merely keeps generic managed templates out of the UI.
  const mayUseLocalProviderCredential = canUseLocalProviderCredential(
    selectedConnection,
    currentManagedConnection,
  );
  const willReplaceConnection =
    selectedConnection?.credentialMode === "member_local";

  return {
    providers,
    integrations,
    connections,
    managedConnections,
    selectedConnectionId,
    selectedIntegrationId,
    selection,
    resourceOptions,
    setupProvider,
    neonConfiguration,
    neonEnvironmentClassification,
    neonBootstrap,
    neonPublicAclApproved,
    neonProductionApproved,
    gcpSetupId,
    gcpSetupInventory,
    gcpSetupInstances,
    selectedGcpProjectId,
    selectedGcpInstanceId,
    gcpEnvironmentClassification,
    gcpProductionApproved,
    gcpRestartApproved,
    gcpPermissionCheck,
    gcpIamRoleGrantApproved,
    gcpSetupError,
    gcpSetupReconnectRequired,
    loading,
    resourcePending,
    mutation,
    error,
    selectedConnection,
    selectedIntegration,
    selectedProvider,
    resourceComplete,
    currentResourceLabel,
    mayUseLocalProviderCredential,
    willReplaceConnection,
    applyNeonBootstrap,
    beginConnect,
    classifyNeonEnvironment,
    completeGcpSetup,
    connect,
    disconnect,
    deleteSharedConnection,
    importDiscoveredResource,
    preflightNeonBootstrap,
    resetResources,
    reconnectGcpSetup,
    selectResource,
    selectGcpInstance,
    selectGcpProject,
    setGcpEnvironmentClassification,
    setGcpIamRoleGrantApproved,
    setGcpProductionApproved,
    setGcpRestartApproved,
    setNeonEnvironmentClassification,
    setNeonPublicAclApproved,
    setNeonProductionApproved,
    setNeonConfiguration,
    setSelectedConnectionId,
    setSelectedIntegrationId,
    switchToMemberLocal,
  };
}

export type ProviderAccessController = ReturnType<typeof useProviderAccess>;
