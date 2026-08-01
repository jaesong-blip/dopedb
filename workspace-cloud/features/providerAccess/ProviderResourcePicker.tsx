"use client";

import { useState } from "react";
import {
  ControlButton,
  ControlField,
  ControlSelect,
} from "../../app/components/Controls";
import { selectableProviderResources } from "./domain";
import type { ProviderAccessController } from "./useProviderAccess";

type ImportIntent = "" | "create" | "replace";

const steps = [
  "계정",
  "대상 DB",
  "연결 방식",
  "검토",
] as const;

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
    importDiscoveredResource,
    resetResources,
    selectResource,
    setSelectedConnectionId,
    setSelectedIntegrationId,
  } = controller;
  const [step, setStep] = useState(1);
  const [intent, setIntent] = useState<ImportIntent>("");
  const replaceableConnections = connections.filter(
    (connection) => connection.credentialMode === "member_local",
  );
  const finalLevel = selectedProvider?.resourceLevels.at(-1);
  const finalResource = finalLevel
    ? resourceOptions[finalLevel.key]?.find(
        (item) => item.value === selection[finalLevel.key],
      )
    : null;
  const targetLabel = selectedProvider
    ? selectedProvider.resourceLevels
      .map((level) => selection[level.key])
      .filter(Boolean)
      .join(" / ")
    : "";

  function chooseIntegration(integrationId: string) {
    setSelectedIntegrationId(integrationId);
    setSelectedConnectionId("");
    setIntent("");
    resetResources();
  }

  function chooseIntent(nextIntent: Exclude<ImportIntent, "">) {
    setIntent(nextIntent);
    if (nextIntent === "create") {
      setSelectedConnectionId("");
    } else {
      setSelectedConnectionId(replaceableConnections[0]?.id ?? "");
    }
  }

  return (
    <section className="tw:grid tw:border tw:border-border">
      <header className="tw:grid tw:gap-3 tw:border-b tw:border-border tw:bg-surface-inset tw:px-4 tw:py-3">
        <div className="tw:flex tw:items-center tw:justify-between tw:gap-3">
          <div className="tw:grid tw:gap-1">
            <strong className="tw:text-xs tw:text-foreground">
              공유 DB 추가
            </strong>
            <small className="tw:text-2xs tw:text-muted-foreground">
              인증 계정과 고정 DB 대상을 차례로 선택합니다.
            </small>
          </div>
          <span className="tw:font-mono tw:text-2xs tw:uppercase tw:text-primary">
            {step} / 4
          </span>
        </div>
        <ol
          className="tw:m-0 tw:grid tw:list-none tw:grid-cols-4 tw:gap-px tw:p-0"
          aria-label="DB 추가 진행 단계"
        >
          {steps.map((label, index) => {
            const itemStep = index + 1;
            return (
              <li
                className="tw:grid tw:gap-1 tw:text-2xs tw:text-muted-foreground tw:data-[active=true]:text-foreground tw:data-[complete=true]:text-primary"
                data-active={step === itemStep}
                data-complete={step > itemStep}
                key={label}
              >
                <span className="tw:h-0.5 tw:bg-border tw:data-[active=true]:bg-primary tw:data-[complete=true]:bg-primary" />
                <span className="tw:max-[520px]:sr-only">{label}</span>
              </li>
            );
          })}
        </ol>
      </header>

      {resourcePending || mutation.startsWith("import:") ? (
        <div
          className="tw:h-1 tw:overflow-hidden tw:bg-surface-inset"
          role="progressbar"
          aria-label={
            mutation.startsWith("import:")
              ? "공유 DB를 등록하는 중"
              : "공급자 리소스를 불러오는 중"
          }
        >
          <span className="tw:block tw:h-full tw:w-1/2 tw:animate-pulse tw:bg-primary" />
        </div>
      ) : null}

      <div className="tw:grid tw:min-h-[260px] tw:content-start tw:gap-5 tw:p-5">
        {step === 1 ? (
          <>
            <div className="tw:grid tw:gap-1">
              <strong className="tw:text-sm tw:text-foreground">
                어떤 클라우드 계정에서 찾을까요?
              </strong>
              <p className="tw:m-0 tw:text-2xs tw:leading-body tw:text-muted-foreground">
                이 선택은 인증에만 쓰입니다. 아직 팀 DB가 만들어지지는 않습니다.
              </p>
            </div>
            <ControlField label="클라우드 계정">
              <ControlSelect
                value={selectedIntegrationId}
                onChange={(event) => chooseIntegration(event.target.value)}
              >
                <option value="">계정 선택</option>
                {integrations.map((integration) => (
                  <option
                    value={integration.id}
                    key={integration.id}
                    disabled={integration.status !== "active"}
                  >
                    {integration.displayName}
                    {integration.status === "reconnect_required"
                      ? " · 재연결 필요"
                      : ""}
                  </option>
                ))}
              </ControlSelect>
            </ControlField>
          </>
        ) : null}

        {step === 2 ? (
          <>
            <div className="tw:grid tw:gap-1">
              <strong className="tw:text-sm tw:text-foreground">
                공유할 DB 하나를 선택하세요
              </strong>
              <p className="tw:m-0 tw:text-2xs tw:leading-body tw:text-muted-foreground">
                선택한 프로젝트·인스턴스·DB만 이 워크스페이스 연결에 고정됩니다.
              </p>
            </div>
            <div className="tw:grid tw:grid-cols-1 tw:gap-3 tw:md:grid-cols-3">
              {selectedProvider?.resourceLevels.map((level, index) => {
                const isFinalLeaf =
                  index === selectedProvider.resourceLevels.length - 1;
                const options = selectableProviderResources(
                  resourceOptions[level.key] ?? [],
                  isFinalLeaf,
                  selectedProvider.supportedEngines,
                );
                const previous =
                  index === 0
                  || Boolean(
                    selection[selectedProvider.resourceLevels[index - 1].key],
                  );
                return (
                  <ControlField key={level.key} label={level.label}>
                    <ControlSelect
                      value={selection[level.key] ?? ""}
                      onChange={(event) =>
                        void selectResource(index, event.target.value)
                      }
                      disabled={!previous || resourcePending}
                    >
                      <option value="">선택</option>
                      {options.map((item) => (
                        <option value={item.value} key={item.id}>
                          {item.name}
                          {item.production === true
                            ? " · 운영"
                            : item.ready === false
                              ? " · 준비 안 됨"
                              : ""}
                        </option>
                      ))}
                    </ControlSelect>
                  </ControlField>
                );
              })}
            </div>
          </>
        ) : null}

        {step === 3 ? (
          <>
            <div className="tw:grid tw:gap-1">
              <strong className="tw:text-sm tw:text-foreground">
                새 연결로 추가할까요?
              </strong>
              <p className="tw:m-0 tw:text-2xs tw:leading-body tw:text-muted-foreground">
                기존 로컬 연결을 같은 DB의 관리형 연결로 바꿀 때만 교체를
                선택하세요.
              </p>
            </div>
            <div className="tw:grid tw:border-t tw:border-border">
              <button
                className="tw:grid tw:min-h-[64px] tw:grid-cols-[auto_minmax(0,1fr)] tw:items-start tw:gap-3 tw:border-0 tw:border-b tw:border-border tw:bg-transparent tw:px-2 tw:py-3 tw:text-left tw:text-foreground tw:hover:bg-surface-raised tw:data-[selected=true]:bg-selection"
                type="button"
                data-selected={intent === "create"}
                onClick={() => chooseIntent("create")}
              >
                <span className="tw:mt-0.5 tw:grid tw:size-4 tw:place-items-center tw:rounded-full tw:border tw:border-border tw:data-[selected=true]:border-primary">
                  <i
                    className="tw:size-2 tw:rounded-full tw:bg-transparent tw:data-[selected=true]:bg-primary"
                    data-selected={intent === "create"}
                  />
                </span>
                <span className="tw:grid tw:gap-1">
                  <strong className="tw:text-xs">새 공유 DB 만들기</strong>
                  <small className="tw:text-2xs tw:leading-body tw:text-muted-foreground">
                    공급자 이름과 DB 이름으로 새 팀 연결을 만듭니다.
                  </small>
                </span>
              </button>
              <button
                className="tw:grid tw:min-h-[64px] tw:grid-cols-[auto_minmax(0,1fr)] tw:items-start tw:gap-3 tw:border-0 tw:border-b tw:border-border tw:bg-transparent tw:px-2 tw:py-3 tw:text-left tw:text-foreground tw:hover:bg-surface-raised tw:data-[selected=true]:bg-selection tw:disabled:cursor-not-allowed tw:disabled:opacity-[var(--ds-disabled-opacity)]"
                type="button"
                data-selected={intent === "replace"}
                disabled={replaceableConnections.length === 0}
                onClick={() => chooseIntent("replace")}
              >
                <span className="tw:mt-0.5 tw:grid tw:size-4 tw:place-items-center tw:rounded-full tw:border tw:border-border">
                  <i
                    className="tw:size-2 tw:rounded-full tw:bg-transparent tw:data-[selected=true]:bg-primary"
                    data-selected={intent === "replace"}
                  />
                </span>
                <span className="tw:grid tw:gap-1">
                  <strong className="tw:text-xs">기존 로컬 연결 교체</strong>
                  <small className="tw:text-2xs tw:leading-body tw:text-muted-foreground">
                    연결 ID와 대시보드는 유지하고 자격증명 방식만 바꿉니다.
                  </small>
                </span>
              </button>
            </div>
            {intent === "replace" ? (
              <ControlField label="교체할 로컬 연결">
                <ControlSelect
                  value={selectedConnectionId}
                  onChange={(event) =>
                    setSelectedConnectionId(event.target.value)
                  }
                >
                  {replaceableConnections.map((connection) => (
                    <option value={connection.id} key={connection.id}>
                      {connection.name} · {connection.engine}
                    </option>
                  ))}
                </ControlSelect>
              </ControlField>
            ) : null}
          </>
        ) : null}

        {step === 4 ? (
          <>
            <div className="tw:grid tw:gap-1">
              <strong className="tw:text-sm tw:text-foreground">
                등록 내용을 확인하세요
              </strong>
              <p className="tw:m-0 tw:text-2xs tw:leading-body tw:text-muted-foreground">
                완료 후 DB별 접근 권한에서 사용할 멤버를 지정할 수 있습니다.
              </p>
            </div>
            <dl className="tw:m-0 tw:grid tw:grid-cols-[130px_minmax(0,1fr)] tw:border-t tw:border-border tw:text-xs tw:max-[520px]:grid-cols-1">
              <dt className="tw:border-b tw:border-border tw:py-2 tw:font-mono tw:text-2xs tw:uppercase tw:text-muted-foreground">
                인증 계정
              </dt>
              <dd className="tw:m-0 tw:border-b tw:border-border tw:py-2 tw:text-foreground">
                {selectedIntegration?.displayName}
              </dd>
              <dt className="tw:border-b tw:border-border tw:py-2 tw:font-mono tw:text-2xs tw:uppercase tw:text-muted-foreground">
                대상
              </dt>
              <dd className="tw:m-0 tw:border-b tw:border-border tw:py-2 tw:text-foreground">
                {targetLabel}
              </dd>
              <dt className="tw:border-b tw:border-border tw:py-2 tw:font-mono tw:text-2xs tw:uppercase tw:text-muted-foreground">
                연결 방식
              </dt>
              <dd className="tw:m-0 tw:border-b tw:border-border tw:py-2 tw:text-foreground">
                {intent === "replace"
                  ? `${selectedConnection?.name ?? "선택한 연결"} 교체`
                  : "새 공유 DB"}
              </dd>
              <dt className="tw:border-b tw:border-border tw:py-2 tw:font-mono tw:text-2xs tw:uppercase tw:text-muted-foreground">
                자격증명
              </dt>
              <dd className="tw:m-0 tw:border-b tw:border-border tw:py-2 tw:text-foreground">
                멤버별 자동 회전 · 기본 읽기 · 관리자 쓰기 정책
              </dd>
            </dl>
            {finalResource?.production === true ? (
              <p className="tw:m-0 tw:border tw:border-danger/40 tw:bg-danger/5 tw:px-3 tw:py-2 tw:text-2xs tw:leading-body tw:text-danger">
                운영 DB입니다. 완료 시 관리자 승인이 감사 기록에 남습니다.
              </p>
            ) : null}
          </>
        ) : null}
      </div>

      <footer className="tw:flex tw:items-center tw:justify-between tw:gap-3 tw:border-t tw:border-border tw:px-5 tw:py-3">
        <ControlButton
          onClick={() => setStep((current) => Math.max(1, current - 1))}
          disabled={step === 1 || mutation !== ""}
        >
          이전
        </ControlButton>
        {step < 4 ? (
          <ControlButton
            tone="primary"
            onClick={() => setStep((current) => Math.min(4, current + 1))}
            disabled={
              mutation !== ""
              || (step === 1 && !selectedIntegration)
              || (step === 2 && !resourceComplete)
              || (
                step === 3
                && (
                  !intent
                  || (intent === "replace" && !selectedConnectionId)
                )
              )
            }
          >
            계속
          </ControlButton>
        ) : (
          <ControlButton
            tone="primary"
            disabled={!resourceComplete || mutation !== ""}
            onClick={() => void importDiscoveredResource()}
          >
            {mutation.startsWith("import:")
              ? "등록하는 중"
              : intent === "replace"
                ? "관리형 연결로 교체"
                : "공유 DB 만들기"}
          </ControlButton>
        )}
      </footer>
    </section>
  );
}
