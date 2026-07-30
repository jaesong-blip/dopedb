"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";

import {
  canUseLocalProviderCredential,
  emptyGcp,
  emptyNeon,
  providerImportDisplayName,
  type GcpConfiguration,
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

export function useProviderAccess(workspaceId: string) {
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
    gcpConfiguration,
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
  const setGcpConfiguration = setField("gcpConfiguration");
  const setLoading = setField("loading");
  const setResourcePending = setField("resourcePending");
  const setMutation = setField("mutation");
  const setError = setField("error");
  const pendingImportRef = useRef<PendingProviderImport | null>(null);

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
      if (rows) setResourceOptions({ [first.key]: rows });
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
      setGcpConfiguration(emptyGcp);
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
    if (next !== "gcpCloudSql") setGcpConfiguration(emptyGcp);
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
      !selectedConnection
      || !selectedIntegration
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
    const connectionId = selectedConnection.credentialMode === "member_local"
      ? selectedConnection.id
      : null;
    const name = connectionId
      ? selectedConnection.name
      : providerImportDisplayName(selectedProvider.name, finalResource.name);
    if (!name) return;
    const confirmation = productionApproved
      ? `경고: ${finalResource.name}은 운영 데이터베이스로 분류되었습니다. `
        + "실행 중인 쿼리는 실제 운영 데이터에 영향을 줄 수 있습니다. "
        + "관리형 읽기 전용 연결로 전환하고 이 승인을 감사 기록에 남길까요?"
      : connectionId
        ? `${selectedConnection.name} 연결을 ${finalResource.name} 관리형 대상으로 전환할까요? `
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
    gcpConfiguration,
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
    connect,
    disconnect,
    importDiscoveredResource,
    resetResources,
    selectResource,
    setGcpConfiguration,
    setNeonConfiguration,
    setSelectedConnectionId,
    setSelectedIntegrationId,
    switchToMemberLocal,
  };
}

export type ProviderAccessController = ReturnType<typeof useProviderAccess>;
