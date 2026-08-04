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
    neonEnvironmentClassification,
    neonBootstrap,
    neonPublicAclApproved,
    neonProductionApproved,
    applyNeonBootstrap,
    classifyNeonEnvironment,
    importDiscoveredResource,
    preflightNeonBootstrap,
    resetResources,
    selectResource,
    setSelectedConnectionId,
    setSelectedIntegrationId,
    setNeonPublicAclApproved,
    setNeonProductionApproved,
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
  const isNeon = selectedProvider?.id === "neon";
  const branchLevel = isNeon
    ? selectedProvider.resourceLevels.find((level) => level.kind === "branches")
    : null;
  const selectedBranch = branchLevel
    ? resourceOptions[branchLevel.key]?.find(
        (item) => item.value === selection[branchLevel.key],
      )
    : null;
  const neonEnvironmentReady = !isNeon
    || selectedBranch?.production === true
    || selectedBranch?.production === false
    || neonEnvironmentClassification !== "";
  const neonBootstrapReady = Boolean(
    !isNeon
    || (
      neonBootstrap.report
      && neonBootstrap.receipt
      && neonBootstrap.receiptExpiresAt
      && Date.parse(neonBootstrap.receiptExpiresAt) > Date.now()
    ),
  );
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

      {resourcePending
      || mutation.startsWith("import:")
      || mutation.startsWith("neon:") ? (
        <div
          className="tw:h-1 tw:overflow-hidden tw:bg-surface-inset"
          role="progressbar"
          aria-label={
            mutation.startsWith("import:")
              ? "공유 DB를 등록하는 중"
              : mutation === "neon:preflight"
                ? "Neon 최소권한 사전 점검 중"
                : mutation === "neon:apply"
                  ? "Neon 최소권한 설정과 검증 중"
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
                  selectedProvider.id === "neon",
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
                            : item.production === "unknown" && isFinalLeaf
                              ? " · 환경 확인 필요"
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
            {(isNeon
              ? neonBootstrap.report?.production === true
                || selectedBranch?.production === true
              : finalResource?.production === true) ? (
              <p className="tw:m-0 tw:border tw:border-danger/40 tw:bg-danger/5 tw:px-3 tw:py-2 tw:text-2xs tw:leading-body tw:text-danger">
                운영 DB입니다. 완료 시 관리자 승인이 감사 기록에 남습니다.
              </p>
            ) : null}
            {isNeon ? (
              <div className="tw:grid tw:gap-3 tw:border-t tw:border-border tw:pt-4">
                <div className="tw:grid tw:gap-1">
                  <strong className="tw:text-xs tw:text-foreground">
                    Neon 최소권한 준비
                  </strong>
                  <p className="tw:m-0 tw:text-2xs tw:leading-body tw:text-muted-foreground">
                    DB를 등록하기 전에 공개 권한과 소유권 경계를 점검합니다.
                    필요한 변경만 보여주고, 승인 후 적용·읽기 검증·쓰기 차단
                    검증을 한 번에 실행합니다.
                  </p>
                </div>

                {selectedBranch?.production === "unknown"
                || selectedBranch?.production === undefined ? (
                  <ControlField label="브랜치 환경">
                    <ControlSelect
                      value={neonEnvironmentClassification}
                      onChange={(event) => {
                        classifyNeonEnvironment(
                          event.target.value as "" | "development" | "production",
                        );
                      }}
                      disabled={mutation !== ""}
                    >
                      <option value="">환경 선택</option>
                      <option value="development">개발</option>
                      <option value="production">운영</option>
                    </ControlSelect>
                  </ControlField>
                ) : (
                  <p
                    className="tw:m-0 tw:border tw:border-border tw:bg-surface-inset tw:px-3 tw:py-2 tw:text-2xs tw:leading-body tw:text-muted-foreground tw:data-[production=true]:border-danger/40 tw:data-[production=true]:bg-danger/5 tw:data-[production=true]:text-danger"
                    data-production={selectedBranch.production === true}
                  >
                    {selectedBranch.production === true
                      ? "Neon에서 보호된 운영 브랜치로 확인했습니다. 개발 환경으로 낮출 수 없습니다."
                      : "Neon에서 비보호 개발 브랜치로 확인했습니다."}
                  </p>
                )}

                {!neonBootstrap.report ? (
                  <div className="tw:flex tw:items-center tw:justify-between tw:gap-3 tw:border tw:border-border tw:bg-surface-inset tw:p-3 tw:max-[520px]:grid">
                    <p className="tw:m-0 tw:text-2xs tw:leading-body tw:text-muted-foreground">
                      아직 DB 권한을 변경하지 않습니다. 먼저 읽기 전용 점검 결과를
                      확인하세요.
                    </p>
                    <ControlButton
                      tone="primary"
                      onClick={() => void preflightNeonBootstrap()}
                      disabled={!neonEnvironmentReady || mutation !== ""}
                    >
                      {mutation === "neon:preflight" ? "점검 중" : "사전 점검"}
                    </ControlButton>
                  </div>
                ) : (
                  <>
                    <div
                      className="tw:grid tw:gap-1 tw:border tw:border-border tw:bg-surface-inset tw:p-3 tw:data-[status=blocked]:border-danger/40 tw:data-[status=blocked]:bg-danger/5 tw:data-[status=approvalRequired]:border-warning/40 tw:data-[status=approvalRequired]:bg-warning/10 tw:data-[status=readyToApply]:border-success/40 tw:data-[status=readyToApply]:bg-success/10"
                      data-status={neonBootstrap.report.status}
                    >
                      <strong className="tw:text-xs tw:text-foreground">
                        {neonBootstrap.report.status === "blocked"
                          ? "자동 설정할 수 없는 항목이 있습니다"
                          : neonBootstrap.report.status === "approvalRequired"
                            ? "승인할 변경이 있습니다"
                            : "최소권한 경계를 적용할 수 있습니다"}
                      </strong>
                      <small className="tw:text-2xs tw:leading-body tw:text-muted-foreground">
                        {neonBootstrap.report.canRollback
                          ? "표시된 자동 변경은 검증 실패 시 원래 상태로 되돌립니다."
                          : "자동 복구할 수 없는 변경이 있어 적용하지 않습니다."}
                      </small>
                    </div>

                    <ul className="tw:m-0 tw:grid tw:list-none tw:gap-2 tw:p-0">
                      {neonBootstrap.report.findings.map((item, index) => (
                        <li
                          className="tw:grid tw:gap-2 tw:border tw:border-border tw:bg-surface tw:p-3 tw:data-[level=blocker]:border-danger/40 tw:data-[level=change]:border-warning/40 tw:data-[level=verified]:border-success/40"
                          data-level={item.level}
                          key={`${item.code}:${item.target}:${index}`}
                        >
                          <div className="tw:flex tw:items-start tw:justify-between tw:gap-3 tw:max-[520px]:grid">
                            <span className="tw:grid tw:gap-1">
                              <strong className="tw:text-xs tw:text-foreground">
                                {item.description}
                              </strong>
                              <small className="tw:text-2xs tw:text-muted-foreground">
                                {item.target}
                              </small>
                            </span>
                            <code className="tw:text-2xs tw:text-muted-foreground">
                              {item.code}
                            </code>
                          </div>
                          <span className="tw:grid tw:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] tw:items-center tw:gap-2 tw:text-2xs tw:max-[520px]:grid-cols-1">
                            <span className="tw:min-w-0 tw:break-words tw:text-muted-foreground">
                              {item.before}
                            </span>
                            <span className="tw:text-primary tw:max-[520px]:hidden" aria-hidden="true">
                              →
                            </span>
                            <span className="tw:min-w-0 tw:break-words tw:text-foreground">
                              {item.after}
                            </span>
                          </span>
                        </li>
                      ))}
                    </ul>

                    {neonBootstrap.report.requiresPublicAclApproval ? (
                      <label className="tw:grid tw:grid-cols-[16px_minmax(0,1fr)] tw:items-start tw:gap-2 tw:border tw:border-warning/40 tw:bg-warning/10 tw:p-3">
                        <input
                          className="tw:mt-0.5 tw:size-4 tw:accent-warning"
                          type="checkbox"
                          checked={neonPublicAclApproved}
                          disabled={mutation !== "" || neonBootstrapReady}
                          onChange={(event) => setNeonPublicAclApproved(event.target.checked)}
                        />
                        <span className="tw:grid tw:gap-1 tw:text-xs tw:text-foreground">
                          <strong>표시된 PUBLIC 권한 회수를 승인합니다</strong>
                          <small className="tw:text-2xs tw:leading-body tw:text-muted-foreground">
                            같은 브랜치의 다른 사용자 접근에 영향을 줄 수 있으며,
                            검증 실패 시 표시된 역연산으로 복구합니다.
                          </small>
                        </span>
                      </label>
                    ) : null}

                    {neonBootstrap.report.requiresProductionApproval ? (
                      <label className="tw:grid tw:grid-cols-[16px_minmax(0,1fr)] tw:items-start tw:gap-2 tw:border tw:border-danger/40 tw:bg-danger/10 tw:p-3">
                        <input
                          className="tw:mt-0.5 tw:size-4 tw:accent-danger"
                          type="checkbox"
                          checked={neonProductionApproved}
                          disabled={mutation !== "" || neonBootstrapReady}
                          onChange={(event) => setNeonProductionApproved(event.target.checked)}
                        />
                        <span className="tw:grid tw:gap-1 tw:text-xs tw:text-danger">
                          <strong>운영 DB의 권한 변경과 검증 실행을 승인합니다</strong>
                          <small className="tw:text-2xs tw:leading-body">
                            관리자 승인이 계획 해시와 함께 감사 기록에 남습니다.
                          </small>
                        </span>
                      </label>
                    ) : null}

                    {neonBootstrapReady ? (
                      <p
                        className="tw:m-0 tw:border tw:border-success/40 tw:bg-success/10 tw:px-3 tw:py-2 tw:text-2xs tw:leading-body tw:text-success"
                        role="status"
                      >
                        설정과 검증을 완료했습니다. 읽기 연결은 성공했고 쓰기
                        차단도 확인했습니다. 이제 공유 DB를 만들 수 있습니다.
                      </p>
                    ) : (
                      <div className="tw:flex tw:flex-wrap tw:justify-end tw:gap-2">
                        <ControlButton
                          onClick={() => void preflightNeonBootstrap()}
                          disabled={mutation !== ""}
                        >
                          다시 점검
                        </ControlButton>
                        <ControlButton
                          tone="primary"
                          onClick={() => void applyNeonBootstrap()}
                          disabled={
                            mutation !== ""
                            || neonBootstrap.report.status === "blocked"
                            || (
                              neonBootstrap.report.requiresPublicAclApproval
                              && !neonPublicAclApproved
                            )
                            || (
                              neonBootstrap.report.requiresProductionApproval
                              && !neonProductionApproved
                            )
                          }
                        >
                          {mutation === "neon:apply" ? "설정·검증 중" : "승인 후 설정·검증"}
                        </ControlButton>
                      </div>
                    )}
                  </>
                )}
              </div>
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
            disabled={
              !resourceComplete
              || !neonBootstrapReady
              || mutation !== ""
            }
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
