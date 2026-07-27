"use client";

// Managed provider discovery consumes short-lived opaque receipts to create a
// read-only workspace template; raw provider selectors never become imports.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type ResourceLevel = { key: string; kind: string; label: string };
type Provider = {
  id: string;
  name: string;
  availability: "available" | "planned";
  configured: boolean;
  note: string;
  leaseSeconds: number | null;
  setupKind: "oauth" | "apiKey" | "cloudTrust" | "connector";
  supportedEngines: string[];
  resourceLevels: [ResourceLevel, ResourceLevel, ResourceLevel];
};

type Integration = {
  id: string;
  provider: string;
  status: "active" | "reconnect_required";
  generation: string;
  reconnectRequired?: boolean;
  displayName: string;
  grantedScope: string | null;
  updatedAt: string;
  credentialMode: "managed";
};

type SharedConnection = {
  id: string;
  name: string;
  engine: string;
  credentialMode: "managed" | "member_local";
  allowWrites: boolean;
};

type Resource = {
  id: string;
  name: string;
  value: string;
  kind?: "postgres" | "mysql";
  // Server classification is tri-state; unknown must never look non-production.
  production?: boolean | "unknown";
  ready?: boolean;
  selectionProof?: string;
  receipt?: string;
  receiptExpiresAt?: string;
};

export function selectableProviderResources(
  items: Resource[],
  isFinalLeaf: boolean,
  supportedEngines: string[],
) {
  return items.filter((item) => (
    (!item.kind || supportedEngines.includes(item.kind))
    && (!isFinalLeaf || (item.ready === true && item.production === false))
  ));
}

export function providerImportDisplayName(providerName: string, resourceName: string) {
  return `${providerName} · ${resourceName}`
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .trim();
}

/** UI-only eligibility; the route rechecks canonical import authority atomically. */
export function canUseLocalProviderCredential(
  connection: Pick<SharedConnection, "credentialMode"> | null,
  managed: Pick<ManagedConnection, "integrationId" | "resource"> | null,
) {
  return Boolean(
    connection?.credentialMode === "managed"
      && managed?.integrationId
      && Object.keys(managed.resource).length > 0,
  );
}

type PendingProviderImport = {
  integrationId: string;
  receipt: string;
  name: string;
  body: string;
};

type ManagedConnection = {
  connectionId: string;
  integrationId: string;
  provider: string;
  resource: Record<string, string>;
};

type NeonConfiguration = {
  apiKey: string;
  organizationId: string;
};

type GcpConfiguration = {
  projectId: string;
  projectNumber: string;
  workloadIdentityPoolId: string;
  workloadIdentityProviderId: string;
  instanceId: string;
  readServiceAccountEmail: string;
  writeServiceAccountEmail: string;
  dedicatedServiceAccountsConfirmed: boolean;
  instanceScopedIamConfirmed: boolean;
};

const emptyNeon: NeonConfiguration = { apiKey: "", organizationId: "" };
const emptyGcp: GcpConfiguration = {
  projectId: "",
  projectNumber: "",
  workloadIdentityPoolId: "",
  workloadIdentityProviderId: "",
  instanceId: "",
  readServiceAccountEmail: "",
  writeServiceAccountEmail: "",
  dedicatedServiceAccountsConfirmed: false,
  instanceScopedIamConfirmed: false,
};

async function responseError(response: Response | null, fallback: string) {
  const body = await response?.json().catch(() => null);
  return typeof body?.error === "string" ? body.error : fallback;
}

export function ProviderAccessPanel({ workspaceId }: { workspaceId: string }) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [connections, setConnections] = useState<SharedConnection[]>([]);
  const [managedConnections, setManagedConnections] = useState<ManagedConnection[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState("");
  const [selectedIntegrationId, setSelectedIntegrationId] = useState("");
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [resourceOptions, setResourceOptions] = useState<Record<string, Resource[]>>({});
  const [setupProviderId, setSetupProviderId] = useState("");
  const [neonConfiguration, setNeonConfiguration] = useState<NeonConfiguration>(emptyNeon);
  const [gcpConfiguration, setGcpConfiguration] = useState<GcpConfiguration>(emptyGcp);
  const [loading, setLoading] = useState(true);
  const [resourcePending, setResourcePending] = useState(false);
  const [mutation, setMutation] = useState("");
  const [error, setError] = useState("");
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
        || pending.receipt !== importReceipt
      )
    ) {
      pendingImportRef.current = null;
    }
  }, [importReceipt, selectedIntegrationId]);

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
    if (!selectedIntegration || !selectedProvider || mutation) return;
    const finalLevel = selectedProvider.resourceLevels.at(-1)!;
    const finalResource = resourceOptions[finalLevel.key]?.find(
      (item) => item.value === selection[finalLevel.key],
    );
    if (
      !finalResource?.selectionProof
      || finalResource.production !== false
      || finalResource.ready !== true
    ) return;
    const name = providerImportDisplayName(
      selectedProvider.name,
      finalResource.name,
    );
    if (!name) return;
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
        || pending.receipt !== receipt
        || pending.name !== name
      ) {
        const idempotencyKey = crypto.randomUUID();
        pending = {
          integrationId: selectedIntegration.id,
          receipt,
          name,
          body: JSON.stringify({
            receipt,
            idempotencyKey,
            name,
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

  return (
    <section className="provider-access-panel">
      <header className="provider-access-heading">
        <div>
          <strong>관리형 DB 접근</strong>
          <small>구성원별 최소 권한 자격증명을 15분 동안만 발급합니다.</small>
        </div>
        <span>장기 DB 암호 저장 없음</span>
      </header>

      {loading ? <p className="provider-empty">공급자 설정을 확인하는 중입니다.</p> : (
        <>
          <div className="provider-catalog">
            {providers.map((provider) => {
              const connectedCount = integrations.filter(
                (item) => item.provider === provider.id,
              ).length;
              const available = provider.availability === "available" && provider.configured;
              return (
                <div className="provider-row" key={provider.id}>
                  <div>
                    <strong>{provider.name}</strong>
                    <small>{provider.note}</small>
                  </div>
                  <div className="provider-row-actions ds-control-row">
                    {connectedCount > 0 ? (
                      <span className="provider-state">연결 {connectedCount}</span>
                    ) : null}
                    <button
                      type="button"
                      disabled={!available || mutation !== ""}
                      onClick={() => beginConnect(provider)}
                    >
                      {provider.availability === "planned"
                        ? "준비 중"
                        : provider.configured
                          ? connectedCount > 0 ? "추가" : "연결"
                          : "서버 설정 필요"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {setupProvider?.id === "neon" ? (
            <form
              className="provider-setup-form"
              onSubmit={(event) => {
                event.preventDefault();
                void connect(setupProvider, neonConfiguration);
              }}
            >
              <p className="provider-setup-note">
                가능하면 <a
                  href="https://neon.com/docs/manage/api-keys"
                  target="_blank"
                  rel="noreferrer"
                >프로젝트 범위 조직 API 키</a>를 사용하세요.
              </p>
              <label>
                <span>Neon API 키</span>
                <input
                  type="password"
                  autoComplete="off"
                  value={neonConfiguration.apiKey}
                  onChange={(event) => setNeonConfiguration({
                    ...neonConfiguration,
                    apiKey: event.target.value,
                  })}
                  placeholder="프로젝트 범위 API 키"
                  required
                />
              </label>
              <label>
                <span>조직 ID · 선택</span>
                <input
                  value={neonConfiguration.organizationId}
                  onChange={(event) => setNeonConfiguration({
                    ...neonConfiguration,
                    organizationId: event.target.value,
                  })}
                  placeholder="org-..."
                />
              </label>
              <button type="submit" disabled={mutation !== ""}>검증 후 연결</button>
            </form>
          ) : null}

          {setupProvider?.id === "gcpCloudSql" ? (
            <form
              className="provider-setup-form gcp"
              onSubmit={(event) => {
                event.preventDefault();
                void connect(setupProvider, gcpConfiguration);
              }}
            >
              <p className="provider-setup-note">
                서비스 계정 키 대신 <a
                  href="https://vercel.com/docs/oidc/gcp"
                  target="_blank"
                  rel="noreferrer"
                >Vercel OIDC·GCP WIF</a>를 먼저 설정하세요.
              </p>
              {([
                ["projectId", "프로젝트 ID", "my-project-123"],
                ["projectNumber", "프로젝트 번호", "123456789012"],
                ["workloadIdentityPoolId", "WIF 풀 ID", "vercel-prod"],
                ["workloadIdentityProviderId", "WIF 공급자 ID", "dopedb-app"],
                ["instanceId", "전용 Cloud SQL 인스턴스 ID", "prod-db"],
                ["readServiceAccountEmail", "읽기 서비스 계정", "dopedb-read@..."],
                ["writeServiceAccountEmail", "쓰기 서비스 계정 · 선택", "dopedb-write@..."],
              ] as const).map(([key, label, placeholder]) => (
                <label key={key}>
                  <span>{label}</span>
                  <input
                    type={key.includes("Email") ? "email" : "text"}
                    value={gcpConfiguration[key]}
                    onChange={(event) => setGcpConfiguration({
                      ...gcpConfiguration,
                      [key]: event.target.value,
                    })}
                    placeholder={placeholder}
                    required={key !== "writeServiceAccountEmail"}
                  />
                </label>
              ))}
              <p className="provider-setup-note">
                두 서비스 계정의 <code>roles/cloudsql.instanceUser</code>와 읽기
                계정의 <code>roles/cloudsql.viewer</code> 바인딩은
                <code>resource.name == &apos;projects/{gcpConfiguration.projectId
                  || "PROJECT_ID"}/instances/{gcpConfiguration.instanceId
                  || "INSTANCE_ID"}&apos; &amp;&amp; resource.service ==
                  &apos;sqladmin.googleapis.com&apos;</code> 조건으로 제한하세요.
                DopeDB는 impersonation과 대상 인스턴스는 확인하지만 IAM 정책
                조건식과 DB 내부 GRANT 전체를 대신 감사할 수는 없습니다.
              </p>
              <label className="provider-confirmation">
                <input
                  type="checkbox"
                  checked={gcpConfiguration.dedicatedServiceAccountsConfirmed}
                  onChange={(event) => setGcpConfiguration({
                    ...gcpConfiguration,
                    dedicatedServiceAccountsConfirmed: event.target.checked,
                  })}
                  required
                />
                <span>
                  인스턴스 전용 서비스 계정
                  <small>이 계정들을 다른 Cloud SQL 인스턴스에서 재사용하지 않습니다.</small>
                </span>
              </label>
              <label className="provider-confirmation">
                <input
                  type="checkbox"
                  checked={gcpConfiguration.instanceScopedIamConfirmed}
                  onChange={(event) => setGcpConfiguration({
                    ...gcpConfiguration,
                    instanceScopedIamConfirmed: event.target.checked,
                  })}
                  required
                />
                <span>
                  인스턴스 범위 IAM Condition
                  <small>위 조건을 관련 Instance User·Viewer 바인딩에 적용했습니다.</small>
                </span>
              </label>
              <button type="submit" disabled={mutation !== ""}>설정 확인 후 연결</button>
            </form>
          ) : null}

          {integrations.length > 0 ? (
            <div className="integration-list">
              {integrations.map((integration) => (
                <div className="integration-row" key={integration.id}>
                  <div>
                    <strong>{integration.displayName}</strong>
                    <small>관리형 서버 접근 · 마지막 확인 {new Date(integration.updatedAt).toLocaleString("ko-KR")}</small>
                  </div>
                  <button
                    type="button"
                    disabled={mutation !== ""}
                    onClick={() => void disconnect(integration)}
                  >
                    연결 해제
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          <div className="managed-access-flow">
            <label>
              <span>1 · 공유 연결</span>
              <select
                value={selectedConnectionId}
                onChange={(event) => {
                  setSelectedConnectionId(event.target.value);
                  resetResources();
                }}
                disabled={connections.length === 0}
              >
                {connections.length === 0 ? <option value="">공유된 DB가 없습니다</option> : null}
                {connections.map((connection) => (
                  <option value={connection.id} key={connection.id}>
                    {connection.name} · {connection.engine} · {
                      connection.credentialMode === "managed" ? "자동 발급" : "개별 입력"
                    }
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>2 · 공급자 계정</span>
              <select
                value={selectedIntegrationId}
                onChange={(event) => {
                  setSelectedIntegrationId(event.target.value);
                  resetResources();
                }}
                disabled={integrations.length === 0}
              >
                {integrations.length === 0 ? <option value="">먼저 공급자를 연결하세요</option> : null}
                {integrations.map((integration) => (
                  <option value={integration.id} key={integration.id} disabled={integration.status !== "active"}>
                    {integration.displayName}{integration.status === "reconnect_required" ? " · reconnect required" : ""}
                  </option>
                ))}
              </select>
            </label>
            <div className={`managed-resource-row${
              selectedProvider?.id === "gcpCloudSql" ? " gcp" : ""
            }`}>
              {selectedProvider?.resourceLevels.map((level, index) => {
                const isFinalLeaf = index === selectedProvider.resourceLevels.length - 1;
                // Parent nodes remain selectable with an honest unknown status.
                // Only the final credential target needs a positive safety proof.
                const options = selectableProviderResources(
                  resourceOptions[level.key] ?? [],
                  isFinalLeaf,
                  selectedProvider.supportedEngines,
                );
                const previous = index === 0
                  || Boolean(selection[selectedProvider.resourceLevels[index - 1].key]);
                return (
                  <label key={level.key}>
                    <span>{index === 0 ? "3 · " : ""}{level.label}</span>
                    <select
                      value={selection[level.key] ?? ""}
                      onChange={(event) => void selectResource(index, event.target.value)}
                      disabled={!selectedIntegration || !previous || resourcePending}
                    >
                      <option value="">선택</option>
                      {options.map((item) => (
                        <option value={item.value} key={item.id}>
                          {item.name}{item.production === true ? " · production" : item.production === "unknown" ? " · classification pending" : item.ready === false ? " · not ready" : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                );
              })}
            </div>
            <div className="managed-access-actions ds-control-row">
              <p>
                {currentResourceLabel
                    ? `현재 ${currentResourceLabel}에 자동 연결됩니다.`
                    : selectedConnection?.allowWrites
                      ? "멤버 RBAC에 따라 읽기 또는 읽기·쓰기 권한을 발급합니다."
                      : "이 연결은 모든 구성원에게 읽기 전용 자격증명만 발급합니다."}
              </p>
              <div className="ds-control-row">
                {mayUseLocalProviderCredential ? (
                  <div className="provider-local-handoff">
                    <small>
                      이 가져온 공급자 대상만 구성원 로컬 자격증명으로 전환할 수 있습니다.
                      대상·읽기 전용 정책은 유지되며 자격증명은 이 기기에만 저장됩니다.
                    </small>
                    <button
                      className="muted-button"
                      type="button"
                      disabled={mutation !== ""}
                      onClick={() => void switchToMemberLocal()}
                    >
                      로컬 Provider 자격증명 사용
                    </button>
                  </div>
                ) : null}
                <button
                  className="accent-button"
                  type="button"
                  disabled={
                    !selectedIntegration
                    || !resourceComplete
                    || resourcePending
                    || mutation !== ""
                  }
                  onClick={() => void importDiscoveredResource()}
                >
                  {mutation.startsWith("import:") ? "가져오는 중" : "읽기 전용 연결 가져오기"}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
      {error ? <small className="form-error" role="alert">{error}</small> : null}
    </section>
  );
}
