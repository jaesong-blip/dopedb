"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";

import {
  canUseLocalProviderCredential,
  emptyNeon,
  parseGcpSetupPermissionCheck,
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
    gcpSetupInventory,
    gcpSetupInstances,
    selectedGcpProjectId,
    selectedGcpInstanceId,
    gcpEnvironmentClassification,
    gcpProductionApproved,
    gcpRestartApproved,
    gcpPermissionCheck,
    gcpIamRoleGrantApproved,
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
  const setGcpSetupInventory = setField("gcpSetupInventory");
  const setGcpSetupInstances = setField("gcpSetupInstances");
  const setSelectedGcpProjectId = setField("selectedGcpProjectId");
  const setSelectedGcpInstanceId = setField("selectedGcpInstanceId");
  const setGcpEnvironmentClassification = setField("gcpEnvironmentClassification");
  const setGcpProductionApproved = setField("gcpProductionApproved");
  const setGcpRestartApproved = setField("gcpRestartApproved");
  const setGcpPermissionCheck = setField("gcpPermissionCheck");
  const setGcpIamRoleGrantApproved = setField("gcpIamRoleGrantApproved");
  const setLoading = setField("loading");
  const setResourcePending = setField("resourcePending");
  const setMutation = setField("mutation");
  const setError = setField("error");
  const pendingImportRef = useRef<PendingProviderImport | null>(null);
  const pendingGcpTargetRef = useRef<{
    integrationId: string;
    projectId: string;
    instanceId: string;
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
    const finalLevel = selectedProvider?.resourceLevels.at(-1);
    if (!finalLevel) return null;
    return resourceOptions[finalLevel.key]?.find(
      (item) => item.value === selection[finalLevel.key],
    )?.receipt ?? null;
  }, [resourceOptions, selectedProvider?.resourceLevels, selection]);

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

  const resetResources = useCallback(() => {
    pendingImportRef.current = null;
    setSelection({});
    setResourceOptions({});
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
        : nextIntegrations[0]?.id ?? ""
    ));
    setError("");
    setLoading(false);
  }, [workspaceId]);

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
      return;
    }
    const controller = new AbortController();
    setMutation("gcp:projects");
    setError("");
    void fetch(
      `/api/v1/workspaces/${workspaceId}/provider-integrations/gcp-setup/${
        gcpSetupId
      }?kind=projects`,
      { cache: "no-store", signal: controller.signal },
    ).then(async (response) => {
      if (!response.ok) {
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
    }).catch((cause) => {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : "Google Cloud 연결을 시작하지 못했습니다.");
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
    setError("");
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
        setError(await responseError(
          response?.ok ? permissionResponse : response,
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
        setError("Google Cloud 설정 응답 형식을 확인하지 못했습니다.");
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
      setError("Cloud SQL 대상과 필요한 승인을 확인하세요.");
      return;
    }
    setMutation("gcp:bootstrap");
    setError("");
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
        const permissionCheck = parseGcpSetupPermissionCheck(
          failure?.permissions,
        );
        if (permissionCheck) {
          setGcpPermissionCheck(permissionCheck);
          setGcpIamRoleGrantApproved(false);
        }
        setError(
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
        setError("Google Cloud 자동 설정 결과를 확인하지 못했습니다.");
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
        setError(await responseError(
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
        setError("저장된 Google Cloud 연결을 확인하지 못했습니다.");
        return;
      }
      pendingGcpTargetRef.current = {
        integrationId,
        projectId: project.id,
        instanceId: instance.id,
      };
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
    void discover(first, selectedIntegrationId, {}, controller.signal).then(async (rows) => {
      if (!rows || controller.signal.aborted) return;
      setResourceOptions({ [first.key]: rows });
      const pending = pendingGcpTargetRef.current;
      if (
        selectedProvider.id !== "gcpCloudSql"
        || pending?.integrationId !== selectedIntegrationId
      ) {
        return;
      }
      const project = rows.find((item) => item.value === pending.projectId);
      const instanceLevel = selectedProvider.resourceLevels[1];
      const databaseLevel = selectedProvider.resourceLevels[2];
      if (!project) {
        pendingGcpTargetRef.current = null;
        return;
      }
      const projectSelection = { [first.key]: pending.projectId };
      setSelection(projectSelection);
      const instances = await discover(
        instanceLevel,
        selectedIntegrationId,
        projectSelection,
        controller.signal,
      );
      if (!instances || controller.signal.aborted) return;
      setResourceOptions((current) => ({
        ...current,
        [instanceLevel.key]: instances,
      }));
      const instance = instances.find(
        (item) => item.value === pending.instanceId,
      );
      if (!instance) {
        pendingGcpTargetRef.current = null;
        return;
      }
      const instanceSelection = {
        ...projectSelection,
        [instanceLevel.key]: pending.instanceId,
      };
      setSelection(instanceSelection);
      const databases = await discover(
        databaseLevel,
        selectedIntegrationId,
        instanceSelection,
        controller.signal,
      );
      if (!databases || controller.signal.aborted) return;
      setResourceOptions((current) => ({
        ...current,
        [databaseLevel.key]: databases,
      }));
      pendingGcpTargetRef.current = null;
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

  async function selectResource(levelIndex: number, value: string) {
    if (!selectedProvider || !selectedIntegrationId) return;
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
    if (
      !finalResource?.selectionProof
      || (
        finalResource.production !== false
        && finalResource.production !== true
      )
      || finalResource.ready !== true
    ) return;
    const productionApproved = finalResource.production === true;
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
        + "관리형 읽기 전용 연결로 전환하고 이 승인을 감사 기록에 남길까요?"
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
        !receipt
        || !finalResource.receiptExpiresAt
        || Date.parse(finalResource.receiptExpiresAt) <= Date.now()
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
        setError(await responseError(response, "읽기 전용 연결을 가져오지 못했습니다."));
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
          && typeof item.selectionProof === "string"
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
    selectedConnectionId,
    selectedIntegrationId,
    selection,
    resourceOptions,
    setupProvider,
    neonConfiguration,
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
    beginConnect,
    completeGcpSetup,
    connect,
    disconnect,
    importDiscoveredResource,
    resetResources,
    selectResource,
    selectGcpInstance,
    selectGcpProject,
    setGcpEnvironmentClassification,
    setGcpIamRoleGrantApproved,
    setGcpProductionApproved,
    setGcpRestartApproved,
    setNeonConfiguration,
    setSelectedConnectionId,
    setSelectedIntegrationId,
    switchToMemberLocal,
  };
}

export type ProviderAccessController = ReturnType<typeof useProviderAccess>;
