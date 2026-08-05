"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  ControlButton,
  ControlField,
  ControlInput,
  ControlSelect,
} from "../../app/components/Controls";
import type { Integration, ManagedConnection } from "./domain";
import {
  parseNeonBranchInventory,
  parseNeonBranchOperations,
  parseNeonBranchPlanResponse,
  type NeonBranchInventory,
  type NeonBranchInventoryItem,
  type NeonBranchOperation,
  type NeonBranchOperationState,
} from "./neonBranches";

type ProjectTarget = Readonly<{
  integration: Integration;
  projectId: string;
}>;

type SourcePointKind = "head" | "timestamp" | "lsn";

function projectTargets(
  integrations: readonly Integration[],
  managedConnections: readonly ManagedConnection[],
) {
  const byId = new Map(integrations.map((integration) => [integration.id, integration]));
  const seen = new Set<string>();
  const targets: ProjectTarget[] = [];
  for (const connection of managedConnections) {
    if (connection.provider !== "neon") continue;
    const integration = byId.get(connection.integrationId);
    const projectId = connection.resource.project;
    const key = `${connection.integrationId}:${projectId}`;
    if (
      !integration
      || integration.provider !== "neon"
      || integration.status !== "active"
      || !/^[a-z0-9][a-z0-9-]{0,59}$/.test(projectId ?? "")
      || seen.has(key)
    ) {
      continue;
    }
    seen.add(key);
    targets.push({ integration, projectId });
  }
  return targets.sort((left, right) => (
    left.integration.displayName.localeCompare(right.integration.displayName, "ko")
    || left.projectId.localeCompare(right.projectId)
  ));
}

async function responseError(response: Response | null, fallback: string) {
  const body = await response?.json().catch(() => null);
  return typeof body?.error === "string" ? body.error : fallback;
}

function operationLabel(operation: NeonBranchOperation) {
  const state = operation.state;
  if (state === "awaiting_approval") return "승인 대기";
  if (state === "approved") return "실행 준비";
  if (state === "claimed" || state === "remote_started") {
    return operation.plan.kind === "neon.branch.delete" ? "폐기 시작" : "생성 시작";
  }
  if (state === "reconciling") return "Provider 확인 중";
  if (state === "succeeded") {
    return operation.plan.kind === "neon.branch.delete" ? "폐기 확인됨" : "생성 완료";
  }
  if (state === "needs_repair") return "복구 필요";
  if (state === "failed") return "실패";
  return "취소됨";
}

function operationTone(state: NeonBranchOperationState) {
  if (state === "succeeded") return "success";
  if (state === "failed" || state === "needs_repair") return "danger";
  if (state === "cancelled") return "neutral";
  return "warning";
}

function warningLabel(code: string) {
  if (code === "NEON_PRODUCTION_DATA_COPY") return "운영 데이터가 복제됩니다";
  if (code === "NEON_PROTECTED_PARENT_CREDENTIALS_ROTATE") {
    return "보호 브랜치의 자격증명이 회전될 수 있습니다";
  }
  if (code === "NEON_SCHEMA_ONLY_HAS_NO_DATA") return "스키마만 복제되며 데이터는 없습니다";
  if (code === "NEON_ENDPOINT_CREATES_COMPUTE") return "읽기·쓰기 compute가 생성됩니다";
  if (code === "NEON_INHERITED_DOPEDB_CREDENTIALS_RETIRED") {
    return "상속된 DopeDB 임시 역할을 폐기합니다";
  }
  if (code === "NEON_HEAD_RESOLVED_AT_EXECUTION") return "실행 시점의 최신 head를 사용합니다";
  if (code === "NEON_BRANCH_CONNECTIONS_TERMINATE") {
    return "Provider 삭제가 시작되면 branch endpoint 연결이 종료됩니다";
  }
  if (code === "NEON_SOFT_DELETE_RECOVERY_NOT_GUARANTEED") {
    return "복구 가능 기간은 Neon 계정 capability에 따라 달라지며 DopeDB가 보장하지 않습니다";
  }
  return code;
}

function deletionBlockerLabel(code: string) {
  if (code === "CREATE_OPERATION_INCOMPLETE") return "생성 작업이 아직 완료되지 않았습니다";
  if (code === "BRANCH_NOT_READY") return "Provider 작업이 진행 중입니다";
  if (code === "ROOT_BRANCH") return "root 브랜치는 폐기할 수 없습니다";
  if (code === "DEFAULT_BRANCH") return "default 브랜치는 폐기할 수 없습니다";
  if (code === "PROTECTED_BRANCH") return "보호 브랜치는 폐기할 수 없습니다";
  if (code === "CHILD_BRANCHES") return "먼저 child 브랜치를 정리해야 합니다";
  if (code === "WORKSPACE_CONNECTIONS") return "이 브랜치를 참조하는 공유 연결이 있습니다";
  if (code === "ACTIVE_LEASES") return "활성 자격증명 lease가 남아 있습니다";
  if (code === "PROVIDER_RESTRICTED") return "Neon이 현재 이 변경을 제한합니다";
  return code;
}

function branchEnvironment(branch: NeonBranchInventoryItem | null) {
  if (!branch) return "";
  if (
    branch.protected
    || branch.production === true
    || branch.connections.some((connection) => connection.environment === "production")
  ) {
    return "production";
  }
  return branch.production === false ? "development" : "";
}

function operationBusy(operation: NeonBranchOperation) {
  return operation.state === "claimed"
    || operation.state === "remote_started"
    || operation.state === "reconciling";
}

export function NeonBranchManager({
  workspaceId,
  integrations,
  managedConnections,
}: {
  workspaceId: string;
  integrations: readonly Integration[];
  managedConnections: readonly ManagedConnection[];
}) {
  const targets = useMemo(
    () => projectTargets(integrations, managedConnections),
    [integrations, managedConnections],
  );
  const [targetKey, setTargetKey] = useState("");
  const [inventory, setInventory] = useState<NeonBranchInventory | null>(null);
  const [operations, setOperations] = useState<readonly NeonBranchOperation[]>([]);
  const [search, setSearch] = useState("");
  const [sourceBranchId, setSourceBranchId] = useState("");
  const [targetName, setTargetName] = useState("");
  const [initSource, setInitSource] = useState<"parent-data" | "schema-only">("parent-data");
  const [sourcePointKind, setSourcePointKind] = useState<SourcePointKind>("head");
  const [sourcePointValue, setSourcePointValue] = useState("");
  const [endpoint, setEndpoint] = useState<"none" | "read_write">("read_write");
  const [environment, setEnvironment] = useState<"" | "development" | "production">("");
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(false);
  const [mutation, setMutation] = useState("");
  const [error, setError] = useState("");

  const selectedTarget = targets.find(
    (target) => `${target.integration.id}:${target.projectId}` === targetKey,
  ) ?? targets[0] ?? null;
  const selectedBranch = inventory?.branches.find(
    (branch) => branch.id === sourceBranchId,
  ) ?? null;
  const knownEnvironment = branchEnvironment(selectedBranch);
  const effectiveEnvironment = knownEnvironment || environment;

  useEffect(() => {
    if (!targets.length) {
      setTargetKey("");
      return;
    }
    if (!selectedTarget) {
      setTargetKey(`${targets[0].integration.id}:${targets[0].projectId}`);
    }
  }, [selectedTarget, targets]);

  const load = useCallback(async (signal?: AbortSignal, quiet = false) => {
    if (!selectedTarget) return;
    if (!quiet) setLoading(true);
    setError("");
    const integrationId = encodeURIComponent(selectedTarget.integration.id);
    const projectId = encodeURIComponent(selectedTarget.projectId);
    const base = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}`
      + `/provider-integrations/${integrationId}/neon-branches`;
    const [inventoryResponse, operationResponse] = await Promise.all([
      fetch(`${base}?project=${projectId}`, { cache: "no-store", signal }).catch(() => null),
      fetch(`${base}/operations`, { cache: "no-store", signal }).catch(() => null),
    ]);
    if (signal?.aborted) return;
    if (!inventoryResponse?.ok || !operationResponse?.ok) {
      setError(await responseError(
        inventoryResponse?.ok ? operationResponse : inventoryResponse,
        "Neon 브랜치 상태를 불러오지 못했습니다.",
      ));
      if (!quiet) setLoading(false);
      return;
    }
    const [inventoryBody, operationBody] = await Promise.all([
      inventoryResponse.json().catch(() => null),
      operationResponse.json().catch(() => null),
    ]);
    const nextInventory = parseNeonBranchInventory(inventoryBody);
    const nextOperations = parseNeonBranchOperations(operationBody);
    if (
      !nextInventory
      || !nextOperations
      || nextInventory.projectId !== selectedTarget.projectId
      || nextInventory.integrationGeneration !== selectedTarget.integration.generation
      || nextOperations.integrationGeneration !== selectedTarget.integration.generation
    ) {
      setError("Neon 브랜치 응답이 현재 연결 세대와 일치하지 않습니다.");
      if (!quiet) setLoading(false);
      return;
    }
    setInventory(nextInventory);
    setOperations(nextOperations.operations);
    setSourceBranchId((current) => (
      nextInventory.branches.some((branch) => branch.id === current && branch.ready)
        ? current
        : nextInventory.branches.find((branch) => (
          branch.ready && branch.connections.length > 0
        ))?.id
          ?? nextInventory.branches.find((branch) => branch.ready)?.id
          ?? ""
    ));
    if (!quiet) setLoading(false);
  }, [selectedTarget, workspaceId]);

  useEffect(() => {
    setInventory(null);
    setOperations([]);
    setSourceBranchId("");
    setEnvironment("");
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    setEnvironment(branchEnvironment(selectedBranch));
  }, [selectedBranch]);

  const visibleBranches = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("ko");
    return inventory?.branches.filter((branch) => (
      !query
      || branch.name.toLocaleLowerCase("ko").includes(query)
      || branch.id.toLocaleLowerCase("ko").includes(query)
      || branch.connections.some((connection) => (
        connection.connectionName.toLocaleLowerCase("ko").includes(query)
      ))
    )) ?? [];
  }, [inventory?.branches, search]);

  async function planCreate() {
    if (
      !selectedTarget
      || !selectedBranch
      || !targetName.trim()
      || !effectiveEnvironment
      || mutation
    ) {
      return;
    }
    const timestamp = sourcePointKind === "timestamp"
      ? Date.parse(sourcePointValue)
      : Number.NaN;
    if (sourcePointKind === "timestamp" && !Number.isFinite(timestamp)) {
      setError("복제 시각을 정확히 입력하세요.");
      return;
    }
    const point = sourcePointKind === "head"
      ? { kind: "head" as const }
      : sourcePointKind === "timestamp"
        ? {
          kind: "timestamp" as const,
          value: new Date(timestamp).toISOString(),
        }
        : { kind: "lsn" as const, value: sourcePointValue.trim() };
    setMutation("plan");
    setError("");
    const response = await fetch(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}`
      + `/provider-integrations/${encodeURIComponent(selectedTarget.integration.id)}`
      + "/neon-branches/operations",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "planCreate",
          request: {
            idempotencyKey: crypto.randomUUID(),
            projectId: selectedTarget.projectId,
            sourceBranchId: selectedBranch.id,
            targetName: targetName.trim(),
            initSource,
            sourcePoint: point,
            endpoint,
            sourceEnvironment: effectiveEnvironment,
          },
        }),
      },
    ).catch(() => null);
    if (!response?.ok) {
      setError(await responseError(response, "Neon 브랜치 계획을 만들지 못했습니다."));
      setMutation("");
      return;
    }
    const operation = parseNeonBranchPlanResponse(await response.json().catch(() => null));
    if (!operation || operation.plan.integrationId !== selectedTarget.integration.id) {
      setError("Neon 브랜치 계획 응답이 올바르지 않습니다.");
      setMutation("");
      return;
    }
    setOperations((current) => [
      operation,
      ...current.filter((item) => item.id !== operation.id),
    ]);
    setTargetName("");
    setShowCreate(false);
    setMutation("");
  }

  async function planDelete() {
    if (
      !selectedTarget
      || !selectedBranch?.deletion?.canPlan
      || mutation
    ) {
      return;
    }
    setMutation("delete-plan");
    setError("");
    const response = await fetch(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}`
      + `/provider-integrations/${encodeURIComponent(selectedTarget.integration.id)}`
      + "/neon-branches/operations",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "planDelete",
          request: {
            idempotencyKey: crypto.randomUUID(),
            projectId: selectedTarget.projectId,
            branchId: selectedBranch.id,
          },
        }),
      },
    ).catch(() => null);
    if (!response?.ok) {
      setError(await responseError(response, "Neon 브랜치 폐기 계획을 만들지 못했습니다."));
      setMutation("");
      return;
    }
    const operation = parseNeonBranchPlanResponse(await response.json().catch(() => null));
    if (
      !operation
      || operation.plan.kind !== "neon.branch.delete"
      || operation.plan.integrationId !== selectedTarget.integration.id
    ) {
      setError("Neon 브랜치 폐기 계획 응답이 올바르지 않습니다.");
      setMutation("");
      return;
    }
    setOperations((current) => [
      operation,
      ...current.filter((item) => item.id !== operation.id),
    ]);
    setMutation("");
  }

  const mutateOperation = useCallback(async (
    operation: NeonBranchOperation,
    action: "approve" | "reject" | "execute",
  ) => {
    if (!selectedTarget || mutation) return;
    setMutation(`${action}:${operation.id}`);
    setError("");
    const deleting = operation.plan.kind === "neon.branch.delete";
    const body = action === "execute"
      ? {
        action: deleting ? "executeDelete" : "executeCreate",
        operationId: operation.id,
        planHash: operation.planHash,
      }
      : {
        action: deleting ? "decideDelete" : "decideCreate",
        operationId: operation.id,
        planHash: operation.planHash,
        decision: action === "approve" ? "approved" : "rejected",
      };
    const response = await fetch(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}`
      + `/provider-integrations/${encodeURIComponent(selectedTarget.integration.id)}`
      + "/neon-branches/operations",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ).catch(() => null);
    if (!response?.ok) {
      setError(await responseError(response, "Neon 브랜치 작업을 진행하지 못했습니다."));
      setMutation("");
      return;
    }
    await load(undefined, true);
    setMutation("");
  }, [load, mutation, selectedTarget, workspaceId]);

  useEffect(() => {
    const active = operations.find((operation) => (
      operation.canExecute && operationBusy(operation)
    ));
    if (!active || mutation || error || !selectedTarget) return;
    const providerDelay = active.reconcileAfter
      ? Date.parse(active.reconcileAfter) - Date.now()
      : 1_500;
    const delay = Math.max(500, Math.min(5_000, providerDelay));
    const timer = window.setTimeout(() => {
      void mutateOperation(active, "execute");
    }, delay);
    return () => window.clearTimeout(timer);
  }, [error, mutateOperation, mutation, operations, selectedTarget]);

  if (targets.length === 0) return null;

  return (
    <section className="tw:grid tw:border tw:border-border" aria-labelledby="neon-branch-title">
      <header className="tw:flex tw:items-start tw:justify-between tw:gap-4 tw:border-b tw:border-border tw:bg-surface-inset tw:px-4 tw:py-3 tw:max-[640px]:grid">
        <div className="tw:grid tw:gap-1">
          <strong id="neon-branch-title" className="tw:text-xs tw:text-foreground">
            Neon 안전 브랜치
          </strong>
          <small className="tw:max-w-[44rem] tw:text-2xs tw:leading-body tw:text-muted-foreground">
            Agent 작업 전에 격리된 상태를 만들고, 생성 계획과 실제 Provider 진행 상태를 여기서 승인·관찰합니다.
          </small>
        </div>
        <div className="tw:flex tw:flex-wrap tw:gap-2">
          <ControlButton onClick={() => void load()} disabled={loading || Boolean(mutation)}>
            {loading ? "확인 중" : "새로고침"}
          </ControlButton>
          <ControlButton
            tone={showCreate ? "neutral" : "primary"}
            onClick={() => setShowCreate((current) => !current)}
            disabled={loading || !inventory}
          >
            {showCreate ? "만들기 닫기" : "안전 브랜치 만들기"}
          </ControlButton>
        </div>
      </header>

      {loading || mutation || operations.some(operationBusy) ? (
        <div className="tw:h-1 tw:overflow-hidden tw:bg-surface-inset" role="progressbar" aria-label="Neon 브랜치 작업 진행 중">
          <span className="tw:block tw:h-full tw:w-1/2 tw:animate-pulse tw:bg-primary" />
        </div>
      ) : null}

      <div className="tw:grid tw:grid-cols-[minmax(260px,0.9fr)_minmax(0,1.4fr)] tw:max-[760px]:grid-cols-1">
        <aside className="tw:grid tw:min-w-0 tw:content-start tw:gap-3 tw:border-r tw:border-border tw:p-4 tw:max-[760px]:border-r-0 tw:max-[760px]:border-b">
          {targets.length > 1 ? (
            <ControlField label="Neon 프로젝트">
              <ControlSelect
                value={selectedTarget ? `${selectedTarget.integration.id}:${selectedTarget.projectId}` : ""}
                onChange={(event) => setTargetKey(event.target.value)}
                disabled={loading || Boolean(mutation)}
              >
                {targets.map((target) => (
                  <option
                    key={`${target.integration.id}:${target.projectId}`}
                    value={`${target.integration.id}:${target.projectId}`}
                  >
                    {target.integration.displayName} · {target.projectId}
                  </option>
                ))}
              </ControlSelect>
            </ControlField>
          ) : (
            <div className="tw:grid tw:gap-1">
              <span className="tw:font-mono tw:text-2xs tw:uppercase tw:text-muted-foreground">프로젝트</span>
              <strong className="tw:truncate tw:text-xs tw:text-foreground">{selectedTarget?.projectId}</strong>
            </div>
          )}
          <ControlInput
            type="search"
            placeholder="브랜치 또는 연결 검색"
            aria-label="Neon 브랜치 검색"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <div className="tw:grid tw:border-t tw:border-border" role="listbox" aria-label="Neon 브랜치">
            {visibleBranches.map((branch) => (
              <button
                key={branch.id}
                type="button"
                role="option"
                aria-selected={sourceBranchId === branch.id}
                data-selected={sourceBranchId === branch.id}
                className="tw:grid tw:min-w-0 tw:grid-cols-[minmax(0,1fr)_auto] tw:items-center tw:gap-2 tw:border-0 tw:border-b tw:border-border tw:bg-transparent tw:px-2 tw:py-2 tw:text-left tw:text-foreground tw:hover:bg-surface-raised tw:data-[selected=true]:bg-selection tw:disabled:cursor-not-allowed tw:disabled:opacity-[var(--ds-disabled-opacity)]"
                disabled={!branch.ready || Boolean(branch.pendingState)}
                onClick={() => setSourceBranchId(branch.id)}
              >
                <span className="tw:flex tw:min-w-0 tw:items-center tw:gap-2">
                  <span className="tw:shrink-0 tw:font-mono tw:text-2xs tw:text-muted-foreground" aria-hidden="true">
                    {branch.depth === 0 ? "●" : `${"· ".repeat(branch.depth)}└`}
                  </span>
                  <span className="tw:min-w-0">
                    <strong className="tw:block tw:truncate tw:text-xs">{branch.name}</strong>
                    <small className="tw:block tw:truncate tw:text-2xs tw:text-muted-foreground">
                      {branch.connections.length > 0
                        ? branch.connections.map((connection) => connection.connectionName).join(", ")
                        : branch.id}
                    </small>
                  </span>
                </span>
                <span className="tw:flex tw:flex-wrap tw:justify-end tw:gap-1">
                  {branch.default ? <span className="tw:border tw:border-border tw:px-1 tw:font-mono tw:text-2xs">default</span> : null}
                  {branch.protected ? <span className="tw:border tw:border-danger/40 tw:px-1 tw:font-mono tw:text-2xs tw:text-danger">protected</span> : null}
                  {branch.initSource === "schema-only" ? <span className="tw:border tw:border-border tw:px-1 tw:font-mono tw:text-2xs">schema</span> : null}
                  {branch.expiresAt ? <span className="tw:border tw:border-warning/40 tw:px-1 tw:font-mono tw:text-2xs tw:text-warning">ephemeral</span> : null}
                </span>
              </button>
            ))}
          </div>
        </aside>

        <main className="tw:grid tw:min-w-0 tw:content-start tw:gap-4 tw:p-4">
          {selectedBranch?.deletion ? (
            <section className="tw:grid tw:gap-3 tw:border-b tw:border-border tw:pb-4" aria-labelledby="neon-delete-title">
              <div className="tw:flex tw:items-start tw:justify-between tw:gap-3 tw:max-[560px]:grid">
                <div className="tw:grid tw:min-w-0 tw:gap-1">
                  <strong id="neon-delete-title" className="tw:truncate tw:text-xs tw:text-foreground">
                    DopeDB 소유 브랜치 · {selectedBranch.name}
                  </strong>
                  <small className="tw:text-2xs tw:leading-body tw:text-muted-foreground">
                    폐기는 별도 계획과 승인을 거치며 Neon의 기본 복구 가능 삭제만 사용합니다.
                  </small>
                </div>
                {selectedBranch.deletion.canPlan ? (
                  <ControlButton
                    tone="danger"
                    onClick={() => void planDelete()}
                    disabled={Boolean(mutation)}
                  >
                    {mutation === "delete-plan" ? "계획 만드는 중" : "폐기 계획 만들기"}
                  </ControlButton>
                ) : null}
              </div>
              {selectedBranch.deletion.blockerCodes.length > 0 ? (
                <ul className="tw:m-0 tw:grid tw:list-none tw:gap-1 tw:border tw:border-warning/40 tw:bg-warning/10 tw:px-3 tw:py-2 tw:text-2xs tw:leading-body tw:text-warning">
                  {selectedBranch.deletion.blockerCodes.map((code) => (
                    <li key={code}>· {deletionBlockerLabel(code)}</li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}

          {showCreate ? (
            <section className="tw:grid tw:gap-4 tw:border-b tw:border-border tw:pb-5" aria-labelledby="neon-create-title">
              <div className="tw:grid tw:gap-1">
                <strong id="neon-create-title" className="tw:text-xs tw:text-foreground">생성 계획</strong>
                <small className="tw:text-2xs tw:leading-body tw:text-muted-foreground">
                  이 단계는 Provider를 변경하지 않습니다. 계획을 만든 뒤 별도로 승인하고 실행합니다.
                </small>
              </div>
              <div className="tw:grid tw:grid-cols-2 tw:gap-3 tw:max-[560px]:grid-cols-1">
                <ControlField label="원본 브랜치">
                  <ControlSelect
                    value={sourceBranchId}
                    onChange={(event) => setSourceBranchId(event.target.value)}
                    disabled={Boolean(mutation)}
                  >
                    {inventory?.branches.filter((branch) => branch.ready && !branch.pendingState).map((branch) => (
                      <option key={branch.id} value={branch.id}>{branch.name}</option>
                    ))}
                  </ControlSelect>
                </ControlField>
                <ControlField label="새 브랜치 이름">
                  <ControlInput
                    value={targetName}
                    maxLength={256}
                    placeholder="agent-safe-branch"
                    onChange={(event) => setTargetName(event.target.value)}
                    disabled={Boolean(mutation)}
                  />
                </ControlField>
                <ControlField label="복제 범위">
                  <ControlSelect
                    value={initSource}
                    onChange={(event) => setInitSource(event.target.value as typeof initSource)}
                    disabled={Boolean(mutation)}
                  >
                    <option value="parent-data">데이터 + 스키마</option>
                    <option value="schema-only">스키마만</option>
                  </ControlSelect>
                </ControlField>
                <ControlField label="접속 endpoint">
                  <ControlSelect
                    value={endpoint}
                    onChange={(event) => setEndpoint(event.target.value as typeof endpoint)}
                    disabled={Boolean(mutation)}
                  >
                    <option value="read_write">읽기·쓰기 endpoint 생성</option>
                    <option value="none">checkpoint만 생성</option>
                  </ControlSelect>
                </ControlField>
                <ControlField label="복제 시점">
                  <ControlSelect
                    value={sourcePointKind}
                    onChange={(event) => {
                      setSourcePointKind(event.target.value as SourcePointKind);
                      setSourcePointValue("");
                    }}
                    disabled={Boolean(mutation)}
                  >
                    <option value="head">실행 시점 head</option>
                    <option value="timestamp">정확한 시각</option>
                    <option value="lsn">정확한 LSN</option>
                  </ControlSelect>
                </ControlField>
                {sourcePointKind !== "head" ? (
                  <ControlField label={sourcePointKind === "timestamp" ? "시각" : "LSN"}>
                    <ControlInput
                      type={sourcePointKind === "timestamp" ? "datetime-local" : "text"}
                      placeholder={sourcePointKind === "lsn" ? "0/16B6C50" : undefined}
                      value={sourcePointValue}
                      onChange={(event) => setSourcePointValue(event.target.value)}
                      disabled={Boolean(mutation)}
                    />
                  </ControlField>
                ) : null}
                {!knownEnvironment ? (
                  <ControlField label="원본 환경">
                    <ControlSelect
                      value={environment}
                      onChange={(event) => setEnvironment(event.target.value as typeof environment)}
                      disabled={Boolean(mutation)}
                    >
                      <option value="">환경 선택</option>
                      <option value="development">개발</option>
                      <option value="production">운영</option>
                    </ControlSelect>
                  </ControlField>
                ) : (
                  <div className="tw:grid tw:content-start tw:gap-2">
                    <span className="tw:font-mono tw:text-2xs tw:font-semibold tw:uppercase tw:text-muted-foreground">원본 환경</span>
                    <span className="tw:flex tw:h-control-field tw:items-center tw:border tw:border-border tw:bg-surface-inset tw:px-3 tw:text-xs tw:text-foreground">
                      {knownEnvironment === "production" ? "운영" : "개발"}
                    </span>
                  </div>
                )}
              </div>
              {effectiveEnvironment === "production" && initSource === "parent-data" ? (
                <p className="tw:m-0 tw:border tw:border-danger/40 tw:bg-danger/5 tw:px-3 tw:py-2 tw:text-2xs tw:leading-body tw:text-danger">
                  운영 데이터 복제입니다. 요청자와 다른 워크스페이스 관리자가 이 계획을 승인해야 실행할 수 있습니다.
                </p>
              ) : null}
              <div className="tw:flex tw:justify-end">
                <ControlButton
                  tone="primary"
                  onClick={() => void planCreate()}
                  disabled={
                    Boolean(mutation)
                    || !selectedBranch
                    || !targetName.trim()
                    || !effectiveEnvironment
                    || (sourcePointKind !== "head" && !sourcePointValue)
                  }
                >
                  {mutation === "plan" ? "계획 만드는 중" : "변경 없는 계획 만들기"}
                </ControlButton>
              </div>
            </section>
          ) : null}

          <section className="tw:grid tw:gap-3" aria-labelledby="neon-operation-title">
            <div className="tw:flex tw:items-end tw:justify-between tw:gap-3">
              <div className="tw:grid tw:gap-1">
                <strong id="neon-operation-title" className="tw:text-xs tw:text-foreground">승인·실행 내역</strong>
                <small className="tw:text-2xs tw:text-muted-foreground">최근 계획이 Provider 상태와 함께 보존됩니다.</small>
              </div>
              <span className="tw:font-mono tw:text-2xs tw:text-muted-foreground">{operations.length}</span>
            </div>
            <div className="tw:grid tw:border-t tw:border-border">
              {operations.map((operation) => (
                <article key={operation.id} className="tw:grid tw:gap-3 tw:border-b tw:border-border tw:py-3">
                  <div className="tw:flex tw:items-start tw:justify-between tw:gap-3 tw:max-[560px]:grid">
                    <div className="tw:grid tw:min-w-0 tw:gap-1">
                      <strong className="tw:truncate tw:text-xs tw:text-foreground">
                        {operation.plan.kind === "neon.branch.delete"
                          ? `${operation.plan.target.name} 폐기`
                          : `${operation.plan.source.name} → ${operation.plan.target.name}`}
                      </strong>
                      <small className="tw:text-2xs tw:leading-body tw:text-muted-foreground">
                        {operation.plan.kind === "neon.branch.delete"
                          ? `soft delete · endpoint ${operation.plan.references.endpointIds.length}개 · 연결 0개 · lease 0개`
                          : <>
                            {operation.plan.target.initSource === "schema-only" ? "스키마만" : "데이터 + 스키마"}
                            {operation.plan.target.endpoint === "read_write" ? " · endpoint 포함" : " · checkpoint"}
                          </>}
                      </small>
                    </div>
                    <span
                      className="tw:shrink-0 tw:border tw:border-border tw:px-2 tw:py-1 tw:font-mono tw:text-2xs tw:text-muted-foreground tw:data-[tone=danger]:border-danger/40 tw:data-[tone=danger]:text-danger tw:data-[tone=success]:border-success/40 tw:data-[tone=success]:text-success tw:data-[tone=warning]:border-warning/40 tw:data-[tone=warning]:text-warning"
                      data-tone={operationTone(operation.state)}
                    >
                      {operationLabel(operation)}
                    </span>
                  </div>
                  {operation.plan.warningCodes.length > 0 ? (
                    <ul className="tw:m-0 tw:grid tw:list-none tw:gap-1 tw:p-0 tw:text-2xs tw:text-muted-foreground">
                      {operation.plan.warningCodes.map((code) => <li key={code}>· {warningLabel(code)}</li>)}
                    </ul>
                  ) : null}
                  {operation.approvalPolicy === "separate_admin"
                    && operation.requestedByCurrentActor
                    && operation.state === "awaiting_approval" ? (
                      <p className="tw:m-0 tw:border tw:border-warning/40 tw:bg-warning/10 tw:px-3 tw:py-2 tw:text-2xs tw:leading-body tw:text-warning">
                        운영 데이터 계획은 다른 관리자 계정에서 승인해야 합니다. 이 화면을 다른 관리자에게 열어 달라고 요청하세요.
                      </p>
                    ) : null}
                  {operation.plan.kind === "neon.branch.create"
                    && operation.managedAccessState === "bootstrap_required" ? (
                    <p className="tw:m-0 tw:border tw:border-warning/40 tw:bg-warning/10 tw:px-3 tw:py-2 tw:text-2xs tw:leading-body tw:text-warning">
                      브랜치는 생성됐지만 아직 공유 DB가 아닙니다. 위의 DB 추가에서 새 브랜치를 선택해 최소권한 준비와 DB 검증을 완료하세요.
                    </p>
                  ) : null}
                  {operation.failureCode ? (
                    <code className="tw:text-2xs tw:text-danger">{operation.failureCode}</code>
                  ) : null}
                  {(operation.canApprove || operation.canReject || operation.canExecute) ? (
                    <div className="tw:flex tw:flex-wrap tw:justify-end tw:gap-2">
                      {operation.canReject ? (
                        <ControlButton
                          tone="danger"
                          onClick={() => void mutateOperation(operation, "reject")}
                          disabled={Boolean(mutation)}
                        >
                          거절
                        </ControlButton>
                      ) : null}
                      {operation.canApprove ? (
                        <ControlButton
                          tone={operation.plan.kind === "neon.branch.delete" ? "danger" : "primary"}
                          onClick={() => void mutateOperation(operation, "approve")}
                          disabled={Boolean(mutation)}
                        >
                          계획 승인
                        </ControlButton>
                      ) : null}
                      {operation.canExecute ? (
                        <ControlButton
                          tone={operation.plan.kind === "neon.branch.delete" ? "danger" : "primary"}
                          onClick={() => void mutateOperation(operation, "execute")}
                          disabled={Boolean(mutation)}
                        >
                          {operation.plan.kind === "neon.branch.delete"
                            ? operationBusy(operation)
                              ? "폐기 상태 다시 확인"
                              : "브랜치 폐기 실행"
                            : operation.needsCredentialFenceRecovery
                            ? "자격증명 경계 복구"
                            : operationBusy(operation)
                              ? "상태 다시 확인"
                              : "브랜치 생성 실행"}
                        </ControlButton>
                      ) : null}
                    </div>
                  ) : null}
                </article>
              ))}
              {!loading && operations.length === 0 ? (
                <p className="tw:m-0 tw:border-b tw:border-border tw:py-6 tw:text-center tw:text-2xs tw:text-muted-foreground">
                  아직 브랜치 작업 계획이 없습니다.
                </p>
              ) : null}
            </div>
          </section>
        </main>
      </div>

      {error ? (
        <p className="tw:m-0 tw:border-t tw:border-danger/40 tw:bg-danger/5 tw:px-4 tw:py-3 tw:text-2xs tw:leading-body tw:text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
