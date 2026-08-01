"use client";

// OAuth-return setup surface. It exposes only target selection and approvals;
// WIF coordinates, IAM policies, service accounts, and database IAM users are
// generated and verified server-side instead of becoming browser form fields.
import { useEffect, useState } from "react";
import {
  ControlButton,
  ControlField,
  ControlLink,
  ControlSelect,
} from "../../app/components/Controls";
import type { ProviderAccessController } from "./useProviderAccess";

export function GcpCloudSetup({
  controller,
}: {
  controller: ProviderAccessController;
}) {
  const {
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
    mutation,
    error,
    completeGcpSetup,
    reconnectGcpSetup,
    selectGcpInstance,
    selectGcpProject,
    setGcpEnvironmentClassification,
    setGcpIamRoleGrantApproved,
    setGcpProductionApproved,
    setGcpRestartApproved,
  } = controller;
  const configuring = mutation === "gcp:bootstrap";
  const [configurationElapsedSeconds, setConfigurationElapsedSeconds] =
    useState(0);
  useEffect(() => {
    if (!configuring) {
      setConfigurationElapsedSeconds(0);
      return;
    }
    const startedAt = Date.now();
    setConfigurationElapsedSeconds(0);
    const timer = window.setInterval(() => {
      setConfigurationElapsedSeconds(
        Math.floor((Date.now() - startedAt) / 1_000),
      );
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [configuring]);
  if (!gcpSetupId) return null;

  const selectedInstance = gcpSetupInstances.find(
    (item) => item.id === selectedGcpInstanceId,
  ) ?? null;
  const environmentClassified = Boolean(
    selectedInstance
    && (
      selectedInstance.production !== "unknown"
      || gcpEnvironmentClassification !== ""
    ),
  );
  const effectiveProduction = Boolean(
    selectedInstance
    && (
      selectedInstance.production === true
      || (
        selectedInstance.production === "unknown"
        && gcpEnvironmentClassification === "production"
      )
    ),
  );
  const approvalsComplete = Boolean(
    selectedInstance
    && selectedInstance.ready
    && environmentClassified
    && (!effectiveProduction || gcpProductionApproved)
    && (selectedInstance.iamAuthenticationEnabled || gcpRestartApproved)
    && gcpPermissionCheck
    && (
      gcpPermissionCheck.missing.length === 0
      || (
        gcpPermissionCheck.canAutoGrant
        && gcpIamRoleGrantApproved
      )
    ),
  );
  const busy = mutation.startsWith("gcp:")
    || mutation === "connect:gcpCloudSql";
  const visibleError = gcpSetupReconnectRequired
    ? ""
    : gcpSetupError || error;

  return (
    <section className="tw:grid tw:gap-4 tw:border-y tw:border-border tw:bg-surface-inset tw:p-4">
      <header className="tw:flex tw:items-start tw:justify-between tw:gap-3">
        <div className="tw:grid tw:gap-1">
          <strong className="tw:text-sm tw:text-foreground">
            Google Cloud 연결 설정
          </strong>
          <small className="tw:text-2xs tw:leading-body tw:text-muted-foreground">
            {gcpSetupReconnectRequired
              ? "Google Cloud 승인 시간이 지나 다시 연결해야 합니다."
              : gcpSetupInventory
              ? `${gcpSetupInventory.account} 계정에서 연결할 Cloud SQL을 선택하세요.`
              : "Google Cloud 프로젝트를 확인하고 있습니다."}
          </small>
        </div>
        <span
          className="tw:whitespace-nowrap tw:text-2xs tw:font-semibold tw:text-success tw:data-[state=expired]:text-danger tw:data-[state=loading]:text-muted-foreground"
          data-state={
            gcpSetupReconnectRequired
              ? "expired"
              : gcpSetupInventory
                ? "ready"
                : "loading"
          }
        >
          {gcpSetupReconnectRequired
            ? "OAuth 만료"
            : gcpSetupInventory
              ? "OAuth 승인됨"
              : "확인 중"}
        </span>
      </header>

      <ol className="tw:m-0 tw:grid tw:list-none tw:grid-cols-3 tw:border-y tw:border-border tw:p-0">
        <li className="tw:grid tw:gap-1 tw:border-r tw:border-border tw:px-3 tw:py-2.5">
          <span className="tw:font-mono tw:text-2xs tw:text-success">01 · 완료</span>
          <strong className="tw:text-xs tw:font-medium tw:text-foreground">
            Google 계정 승인
          </strong>
        </li>
        <li className="tw:grid tw:gap-1 tw:border-r tw:border-border tw:bg-selection tw:px-3 tw:py-2.5">
          <span className="tw:font-mono tw:text-2xs tw:text-selection-foreground">
            02 · 현재 단계
          </span>
          <strong className="tw:text-xs tw:font-medium tw:text-selection-foreground">
            대상과 환경 선택
          </strong>
        </li>
        <li className="tw:grid tw:gap-1 tw:px-3 tw:py-2.5">
          <span className="tw:font-mono tw:text-2xs tw:text-muted-foreground">
            03 · 대기
          </span>
          <strong className="tw:text-xs tw:font-medium tw:text-muted-foreground">
            승인 후 자동 구성
          </strong>
        </li>
      </ol>

      {gcpSetupReconnectRequired ? (
        <div
          className="tw:flex tw:flex-col tw:items-stretch tw:gap-3 tw:border tw:border-danger/40 tw:bg-danger/10 tw:p-3 tw:sm:flex-row tw:sm:items-center tw:sm:justify-between"
          role="alert"
        >
          <div className="tw:grid tw:gap-1">
            <strong className="tw:text-xs tw:font-semibold tw:text-danger">
              Google 승인 세션이 만료되었습니다
            </strong>
            <small className="tw:text-2xs tw:leading-body tw:text-muted-foreground">
              장기 토큰을 저장하지 않기 때문에 설정 시간이 지나면 Google 승인이
              다시 필요합니다. 기존 Google Cloud 변경은 그대로 이어서 확인합니다.
            </small>
          </div>
          <ControlButton
            tone="primary"
            size="field"
            disabled={busy}
            onClick={reconnectGcpSetup}
          >
            Google 계정 다시 연결
          </ControlButton>
        </div>
      ) : null}

      <div className="tw:grid tw:gap-1">
        <strong className="tw:text-xs tw:font-semibold tw:text-foreground">
          연결 대상
        </strong>
        <small className="tw:text-2xs tw:leading-body tw:text-muted-foreground">
          프로젝트와 인스턴스를 고르면 필요한 변경과 승인 항목만 표시합니다.
        </small>
      </div>

      <div className="tw:grid tw:grid-cols-1 tw:gap-3 tw:lg:grid-cols-2">
        <ControlField label="프로젝트">
          <ControlSelect
            disabled={!gcpSetupInventory || busy}
            value={selectedGcpProjectId}
            onChange={(event) => void selectGcpProject(event.target.value)}
          >
            <option value="">프로젝트 선택</option>
            {(gcpSetupInventory?.projects ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {project.name} · {project.id}
              </option>
            ))}
          </ControlSelect>
        </ControlField>

        <ControlField label="Cloud SQL 인스턴스">
          <ControlSelect
            disabled={!selectedGcpProjectId || busy}
            value={selectedGcpInstanceId}
            onChange={(event) => selectGcpInstance(event.target.value)}
          >
            <option value="">
              {mutation === "gcp:instances"
                ? "인스턴스 확인 중"
                : "인스턴스 선택"}
            </option>
            {gcpSetupInstances.map((instance) => (
              <option key={instance.id} value={instance.id}>
                {instance.name} · {instance.engine} · {instance.region}
              </option>
            ))}
          </ControlSelect>
        </ControlField>
      </div>

      {selectedInstance ? (
        <div className="tw:grid tw:gap-3 tw:border-t tw:border-border tw:pt-3 tw:lg:grid-cols-2 tw:lg:items-start">
          <div className="tw:col-span-full tw:flex tw:flex-wrap tw:items-center tw:gap-2 tw:text-2xs tw:text-muted-foreground">
            <span>{selectedInstance.engine.toUpperCase()}</span>
            <span>·</span>
            <span>{selectedInstance.region}</span>
            <span>·</span>
            <span>{selectedInstance.ready ? "실행 중" : "연결할 수 없음"}</span>
            <span>·</span>
            <span>
              {selectedInstance.production === true
                ? "운영"
                : selectedInstance.production === false
                  ? "비운영"
                  : gcpEnvironmentClassification === "production"
                    ? "운영 분류 예정"
                    : gcpEnvironmentClassification === "development"
                      ? "비운영 분류 예정"
                      : "환경 분류 필요"}
            </span>
          </div>

          <div className="tw:grid tw:gap-3">
            {selectedInstance.production === "unknown" ? (
              <label className="tw:grid tw:gap-2 tw:border tw:border-warning/40 tw:bg-warning/10 tw:p-3">
                <span className="tw:text-xs tw:font-semibold tw:text-warning">
                  환경 분류 추가
                </span>
                <small className="tw:text-2xs tw:leading-body tw:text-muted-foreground">
                  기존 인스턴스 라벨은 보존하고 선택한
                  <code className="tw:mx-1">environment</code>
                  라벨만 추가합니다. Google 계정에 Cloud SQL Admin 또는
                  <code className="tw:mx-1">cloudsql.instances.update</code>
                  권한이 필요합니다.
                </small>
                <ControlSelect
                  disabled={busy}
                  value={gcpEnvironmentClassification}
                  onChange={(event) => {
                    setGcpEnvironmentClassification(
                      event.target.value as "" | "production" | "development",
                    );
                    setGcpProductionApproved(false);
                  }}
                >
                  <option value="">환경 선택</option>
                  <option value="production">
                    운영 · environment=production
                  </option>
                  <option value="development">
                    비운영 · environment=development
                  </option>
                </ControlSelect>
              </label>
            ) : null}

            <p className="tw:m-0 tw:text-2xs tw:leading-body tw:text-muted-foreground">
              읽기·쓰기 전용 서비스 계정을 분리해 구성합니다. 관리자가 DB별
              쓰기를 허용한 경우에만 역할에 맞는 계정을 사용하며, 단기 IAM
              자격증명은 앱이 자동 회전합니다. 장기 키와 Google 로그인 토큰은
              저장하지 않습니다.
            </p>
          </div>

          <div className="tw:grid tw:gap-3">
            <div className="tw:grid tw:gap-2 tw:border tw:border-border tw:bg-surface tw:p-3">
              <strong className="tw:text-xs tw:font-semibold tw:text-foreground">
                연결 시 자동으로 적용
              </strong>
              <ul className="tw:m-0 tw:grid tw:list-none tw:gap-1.5 tw:p-0 tw:text-2xs tw:leading-body tw:text-muted-foreground">
                <li>· 기존 라벨을 보존하고 환경 분류를 추가합니다.</li>
                <li>· 읽기·쓰기 전용 서비스 계정과 인스턴스 범위 IAM을 구성합니다.</li>
                <li>· 관리자 DB 정책과 멤버 역할에 맞춰 단기 자격증명을 자동 회전합니다.</li>
              </ul>
            </div>

            <div
              data-state={
                !gcpPermissionCheck
                  ? "checking"
                  : gcpPermissionCheck.missing.length === 0
                    ? "ready"
                    : "required"
              }
              className="tw:grid tw:gap-2 tw:border tw:border-border tw:bg-surface tw:p-3 tw:data-[state=ready]:border-success/40 tw:data-[state=ready]:bg-success/10 tw:data-[state=required]:border-warning/40 tw:data-[state=required]:bg-warning/10"
            >
              <strong className="tw:text-xs tw:font-semibold tw:text-foreground">
                {!gcpPermissionCheck
                  ? "Google Cloud 권한 확인 중"
                  : gcpPermissionCheck.missing.length === 0
                    ? "자동 구성 권한 확인됨"
                    : `${gcpPermissionCheck.missing.length}개 설정 역할 필요`}
              </strong>
              {gcpPermissionCheck?.missing.length ? (
                <>
                  <ul className="tw:m-0 tw:grid tw:list-none tw:gap-1.5 tw:p-0">
                    {gcpPermissionCheck.missing.map((requirement) => (
                      <li
                        className="tw:grid tw:gap-0.5 tw:text-2xs tw:leading-body"
                        key={requirement.role}
                      >
                        <span className="tw:font-semibold tw:text-foreground">
                          {requirement.label}
                        </span>
                        <span className="tw:text-muted-foreground">
                          {requirement.purpose}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {gcpPermissionCheck.canAutoGrant ? (
                    <label className="tw:grid tw:grid-cols-[16px_minmax(0,1fr)] tw:items-start tw:gap-2 tw:border-t tw:border-warning/30 tw:pt-2">
                      <input
                        className="tw:mt-0.5 tw:size-4 tw:accent-primary"
                        type="checkbox"
                        checked={gcpIamRoleGrantApproved}
                        disabled={busy}
                        onChange={(event) =>
                          setGcpIamRoleGrantApproved(event.target.checked)
                        }
                      />
                      <span className="tw:grid tw:gap-1 tw:text-xs tw:text-foreground">
                        필요한 역할을 임시 부여하고 계속
                        <small className="tw:text-2xs tw:leading-body tw:text-muted-foreground">
                          이 계정에만 15분 만료 조건으로 부여하고, 연결 설정이
                          끝나면 즉시 제거합니다.
                        </small>
                      </span>
                    </label>
                  ) : (
                    <div className="tw:grid tw:gap-2 tw:border-t tw:border-warning/30 tw:pt-2">
                      <small className="tw:text-2xs tw:leading-body tw:text-muted-foreground">
                        현재 계정은 프로젝트 IAM 정책을 변경할 수 없습니다.
                        프로젝트 관리자가 위 역할을 부여해야 합니다.
                      </small>
                      <ControlLink
                        href={`https://console.cloud.google.com/iam-admin/iam?project=${encodeURIComponent(selectedGcpProjectId)}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Google Cloud IAM 열기
                      </ControlLink>
                    </div>
                  )}
                </>
              ) : (
                <small className="tw:text-2xs tw:leading-body tw:text-muted-foreground">
                  {gcpPermissionCheck
                    ? "현재 계정 권한으로 별도 역할 부여 없이 자동 구성할 수 있습니다."
                    : "프로젝트의 설정 권한을 안전하게 확인하고 있습니다."}
                </small>
              )}
            </div>

            {effectiveProduction ? (
              <label className="tw:grid tw:grid-cols-[16px_minmax(0,1fr)] tw:items-start tw:gap-2 tw:border tw:border-danger/40 tw:bg-danger/10 tw:p-3">
                <input
                  className="tw:mt-0.5 tw:size-4 tw:accent-danger"
                  type="checkbox"
                  checked={gcpProductionApproved}
                  disabled={busy}
                  onChange={(event) =>
                    setGcpProductionApproved(event.target.checked)
                  }
                />
                <span className="tw:grid tw:gap-1 tw:text-xs tw:text-danger">
                  운영 Cloud SQL 연결 승인
                  <small className="tw:text-2xs tw:leading-body">
                    이 선택과 관리자의 승인은 워크스페이스 감사 기록에 남습니다.
                    쓰기 허용 여부는 연결 후 DB별 접근 권한에서 별도로 정합니다.
                  </small>
                </span>
              </label>
            ) : null}

            {!selectedInstance.iamAuthenticationEnabled ? (
              <label className="tw:grid tw:grid-cols-[16px_minmax(0,1fr)] tw:items-start tw:gap-2 tw:border tw:border-border tw:bg-surface tw:p-3">
                <input
                  className="tw:mt-0.5 tw:size-4 tw:accent-primary"
                  type="checkbox"
                  checked={gcpRestartApproved}
                  disabled={busy}
                  onChange={(event) =>
                    setGcpRestartApproved(event.target.checked)
                  }
                />
                <span className="tw:grid tw:gap-1 tw:text-xs tw:text-foreground">
                  IAM DB 인증 활성화 승인
                  <small className="tw:text-2xs tw:leading-body tw:text-muted-foreground">
                    기존 database flag를 보존해 IAM 인증 flag를 추가하며, 적용 중
                    인스턴스가 재시작될 수 있습니다.
                  </small>
                </span>
              </label>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="tw:grid tw:gap-3 tw:border-t tw:border-border tw:pt-3">
        {configuring ? (
          <div className="tw:grid tw:gap-2.5 tw:border tw:border-primary/40 tw:bg-primary/10 tw:p-3">
            <div className="tw:flex tw:items-center tw:justify-between tw:gap-3">
              <strong className="tw:text-xs tw:font-semibold tw:text-foreground">
                Google Cloud 자동 구성 진행 중
              </strong>
              <span className="tw:shrink-0 tw:font-mono tw:text-2xs tw:text-primary">
                {configurationElapsedSeconds}초 경과
              </span>
            </div>
            <div
              className="tw:h-2 tw:overflow-hidden tw:rounded-pill tw:bg-muted"
              role="progressbar"
              aria-label="Google Cloud 자동 구성 진행 중"
              aria-valuetext={`${configurationElapsedSeconds}초 경과`}
            >
              <span className="tw:block tw:h-full tw:w-full tw:animate-pulse tw:rounded-pill tw:bg-primary/50 tw:motion-reduce:animate-none" />
            </div>
            <small className="tw:text-2xs tw:leading-body tw:text-muted-foreground">
              {configurationElapsedSeconds < 30
                ? "필수 API, 서비스 계정, Cloud SQL IAM 설정을 확인하고 있습니다."
                : "Google IAM 권한이 전파되기를 기다리고 있습니다. 환경에 따라 최대 약 3분 걸릴 수 있습니다."}
            </small>
          </div>
        ) : null}
        {visibleError ? (
          <p
            className="tw:m-0 tw:border tw:border-danger/40 tw:bg-danger/10 tw:p-3 tw:text-2xs tw:leading-body tw:text-danger"
            role="alert"
          >
            <strong className="tw:mb-1 tw:block tw:text-xs">
              연결 설정을 완료하지 못했습니다
            </strong>
            {visibleError}
          </p>
        ) : null}
        <div className="tw:flex tw:flex-col tw:items-stretch tw:gap-3 tw:sm:flex-row tw:sm:items-center tw:sm:justify-between">
          <small className="tw:max-w-[62ch] tw:text-2xs tw:leading-body tw:text-muted-foreground">
            선택한 대상과 승인 항목을 다시 확인하세요. 실행 후에는 Google Cloud
            작업이 완료될 때까지 이 화면을 유지합니다.
          </small>
          <div className="tw:w-full tw:[&>button]:w-full tw:sm:w-auto">
            <ControlButton
              tone="primary"
              size="field"
              disabled={!approvalsComplete || busy}
              onClick={() => void completeGcpSetup()}
            >
               {mutation === "gcp:bootstrap"
                 ? "Google Cloud 구성 중"
                 : gcpPermissionCheck?.missing.length
                   ? "임시 권한 적용 후 자동 설정하고 연결"
                 : selectedInstance?.production === "unknown"
                   ? "환경 분류 추가 후 자동 설정하고 연결"
                   : "자동 설정하고 연결"}
             </ControlButton>
          </div>
        </div>
      </div>
    </section>
  );
}
