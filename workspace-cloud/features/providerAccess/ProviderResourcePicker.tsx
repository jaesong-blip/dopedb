"use client";

import { selectableProviderResources } from "./domain";
import type { ProviderAccessController } from "./useProviderAccess";

export function ProviderResourcePicker({
  controller,
}: {
  controller: ProviderAccessController;
}) {
  const {
    integrations,
    connections,
    selectedConnectionId,
    selectedIntegrationId,
    selection,
    resourceOptions,
    resourcePending,
    mutation,
    selectedConnection,
    selectedIntegration,
    selectedProvider,
    resourceComplete,
    currentResourceLabel,
    mayUseLocalProviderCredential,
    importDiscoveredResource,
    resetResources,
    selectResource,
    setSelectedConnectionId,
    setSelectedIntegrationId,
    switchToMemberLocal,
  } = controller;

  return (
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
          {connections.length === 0 ? (
            <option value="">공유된 DB가 없습니다</option>
          ) : null}
          {connections.map((connection) => (
            <option value={connection.id} key={connection.id}>
              {connection.name} · {connection.engine} ·{" "}
              {connection.credentialMode === "managed"
                ? "자동 발급"
                : "개별 입력"}
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
          {integrations.length === 0 ? (
            <option value="">먼저 공급자를 연결하세요</option>
          ) : null}
          {integrations.map((integration) => (
            <option
              value={integration.id}
              key={integration.id}
              disabled={integration.status !== "active"}
            >
              {integration.displayName}
              {integration.status === "reconnect_required"
                ? " · reconnect required"
                : ""}
            </option>
          ))}
        </select>
      </label>
      <div
        className={`managed-resource-row${
          selectedProvider?.id === "gcpCloudSql" ? " gcp" : ""
        }`}
      >
        {selectedProvider?.resourceLevels.map((level, index) => {
          const isFinalLeaf =
            index === selectedProvider.resourceLevels.length - 1;
          const options = selectableProviderResources(
            resourceOptions[level.key] ?? [],
            isFinalLeaf,
            selectedProvider.supportedEngines,
          );
          const previous =
            index === 0 ||
            Boolean(
              selection[selectedProvider.resourceLevels[index - 1].key],
            );
          return (
            <label key={level.key}>
              <span>
                {index === 0 ? "3 · " : ""}
                {level.label}
              </span>
              <select
                value={selection[level.key] ?? ""}
                onChange={(event) =>
                  void selectResource(index, event.target.value)
                }
                disabled={
                  !selectedIntegration || !previous || resourcePending
                }
              >
                <option value="">선택</option>
                {options.map((item) => (
                  <option value={item.value} key={item.id}>
                    {item.name}
                    {item.production === true
                      ? " · production"
                      : item.production === "unknown"
                        ? " · classification pending"
                        : item.ready === false
                          ? " · not ready"
                          : ""}
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
                이 가져온 공급자 대상만 구성원 로컬 자격증명으로 전환할 수
                있습니다. 대상·읽기 전용 정책은 유지되며 자격증명은 이
                기기에만 저장됩니다.
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
              !selectedIntegration ||
              !resourceComplete ||
              resourcePending ||
              mutation !== ""
            }
            onClick={() => void importDiscoveredResource()}
          >
            {mutation.startsWith("import:")
              ? "가져오는 중"
              : "읽기 전용 연결 가져오기"}
          </button>
        </div>
      </div>
    </div>
  );
}
