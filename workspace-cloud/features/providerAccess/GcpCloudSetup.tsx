"use client";

// OAuth-return setup surface. It exposes only target selection and approvals;
// WIF coordinates, IAM policies, service accounts, and database IAM users are
// generated and verified server-side instead of becoming browser form fields.
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
    mutation,
    error,
    completeGcpSetup,
    selectGcpInstance,
    selectGcpProject,
    setGcpEnvironmentClassification,
    setGcpProductionApproved,
    setGcpRestartApproved,
  } = controller;
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
    && (selectedInstance.iamAuthenticationEnabled || gcpRestartApproved),
  );
  const busy = mutation.startsWith("gcp:");

  return (
    <section className="tw:grid tw:gap-4 tw:border-y tw:border-border tw:bg-surface-inset tw:p-4">
      <header className="tw:flex tw:items-start tw:justify-between tw:gap-3">
        <div className="tw:grid tw:gap-1">
          <strong className="tw:text-sm tw:text-foreground">
            Google Cloud 연결 설정
          </strong>
          <small className="tw:text-2xs tw:leading-body tw:text-muted-foreground">
            {gcpSetupInventory
              ? `${gcpSetupInventory.account} 계정에서 연결할 Cloud SQL을 선택하세요.`
              : "Google Cloud 프로젝트를 확인하고 있습니다."}
          </small>
        </div>
        <span className="tw:whitespace-nowrap tw:text-2xs tw:font-semibold tw:text-success">
          OAuth 승인됨
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

      <div className="tw:grid tw:gap-1">
        <strong className="tw:text-xs tw:font-semibold tw:text-foreground">
          연결 대상
        </strong>
        <small className="tw:text-2xs tw:leading-body tw:text-muted-foreground">
          프로젝트와 인스턴스를 고르면 필요한 변경과 승인 항목만 표시합니다.
        </small>
      </div>

      <div className="tw:grid tw:grid-cols-1 tw:gap-3 lg:tw:grid-cols-2">
        <label className="tw:grid tw:gap-2">
          <span className="tw:text-2xs tw:font-semibold tw:uppercase tw:text-muted-foreground">
            프로젝트
          </span>
          <select
            className="tw:h-control-field tw:w-full tw:border tw:border-border tw:bg-surface tw:px-3 tw:text-xs tw:text-foreground tw:outline-none tw:focus:border-primary tw:disabled:opacity-50"
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
          </select>
        </label>

        <label className="tw:grid tw:gap-2">
          <span className="tw:text-2xs tw:font-semibold tw:uppercase tw:text-muted-foreground">
            Cloud SQL 인스턴스
          </span>
          <select
            className="tw:h-control-field tw:w-full tw:border tw:border-border tw:bg-surface tw:px-3 tw:text-xs tw:text-foreground tw:outline-none tw:focus:border-primary tw:disabled:opacity-50"
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
          </select>
        </label>
      </div>

      {selectedInstance ? (
        <div className="tw:grid tw:gap-3 tw:border-t tw:border-border tw:pt-3">
          <div className="tw:flex tw:flex-wrap tw:items-center tw:gap-2 tw:text-2xs tw:text-muted-foreground">
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
              <select
                className="tw:h-control-field tw:w-full tw:border tw:border-border tw:bg-surface tw:px-3 tw:text-xs tw:text-foreground tw:outline-none tw:focus:border-primary tw:disabled:opacity-50"
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
                <option value="production">운영 · environment=production</option>
                <option value="development">비운영 · environment=development</option>
              </select>
            </label>
          ) : null}

          <p className="tw:m-0 tw:text-2xs tw:leading-body tw:text-muted-foreground">
            공유 연결에는 읽기 전용 15분 IAM 자격증명만 발급합니다. 장기 키와
            Google 로그인 토큰은 저장하지 않습니다.
          </p>

          <div className="tw:grid tw:gap-2 tw:border-t tw:border-border tw:pt-3">
            <strong className="tw:text-xs tw:font-semibold tw:text-foreground">
              연결 시 자동으로 적용
            </strong>
            <ul className="tw:m-0 tw:grid tw:list-none tw:gap-1.5 tw:p-0 tw:text-2xs tw:leading-body tw:text-muted-foreground">
              <li>· 기존 라벨을 보존하고 환경 분류를 추가합니다.</li>
              <li>· 전용 서비스 계정과 인스턴스 범위 IAM을 구성합니다.</li>
              <li>· 구성원에게 읽기 전용 15분 자격증명만 발급합니다.</li>
            </ul>
          </div>

          {effectiveProduction ? (
            <label className="tw:grid tw:grid-cols-[16px_minmax(0,1fr)] tw:items-start tw:gap-2 tw:border tw:border-danger/40 tw:bg-danger/10 tw:p-3">
              <input
                className="tw:mt-0.5 tw:size-4 tw:accent-danger"
                type="checkbox"
                checked={gcpProductionApproved}
                disabled={busy}
                onChange={(event) => setGcpProductionApproved(event.target.checked)}
              />
              <span className="tw:grid tw:gap-1 tw:text-xs tw:text-danger">
                운영 Cloud SQL 연결 승인
                <small className="tw:text-2xs tw:leading-body">
                  이 선택과 관리자의 승인은 워크스페이스 감사 기록에 남습니다.
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
                onChange={(event) => setGcpRestartApproved(event.target.checked)}
              />
              <span className="tw:grid tw:gap-1 tw:text-xs tw:text-foreground">
                IAM DB 인증 활성화 승인
                <small className="tw:text-2xs tw:leading-body tw:text-muted-foreground">
                  기존 database flag를 보존해 IAM 인증 flag를 추가하며, 적용 중 인스턴스가 재시작될 수 있습니다.
                </small>
              </span>
            </label>
          ) : null}
        </div>
      ) : null}

      <div className="tw:grid tw:gap-3 tw:border-t tw:border-border tw:pt-3">
        {error ? (
          <p
            className="tw:m-0 tw:border tw:border-danger/40 tw:bg-danger/10 tw:p-3 tw:text-2xs tw:leading-body tw:text-danger"
            role="alert"
          >
            <strong className="tw:mb-1 tw:block tw:text-xs">
              연결 설정을 완료하지 못했습니다
            </strong>
            {error}
          </p>
        ) : null}
        <div className="tw:flex tw:items-center tw:justify-between tw:gap-3">
          <small className="tw:max-w-[62ch] tw:text-2xs tw:leading-body tw:text-muted-foreground">
            선택한 대상과 승인 항목을 다시 확인하세요. 실행 후에는 Google Cloud
            작업이 완료될 때까지 이 화면을 유지합니다.
          </small>
          <button
            className="tw:h-control-field tw:shrink-0 tw:border-0 tw:bg-primary-emphasis tw:px-4 tw:text-2xs tw:font-extrabold tw:text-primary-foreground tw:transition-colors tw:hover:bg-primary tw:focus-visible:outline-2 tw:focus-visible:outline-offset-2 tw:focus-visible:outline-ring tw:active:translate-y-px tw:disabled:cursor-not-allowed tw:disabled:opacity-50"
            type="button"
            disabled={!approvalsComplete || busy}
            onClick={() => void completeGcpSetup()}
          >
            {mutation === "gcp:bootstrap"
              ? "Google Cloud 구성 중"
              : selectedInstance?.production === "unknown"
                ? "환경 분류 추가 후 연결"
                : "승인한 변경 적용 후 연결"}
          </button>
        </div>
      </div>
    </section>
  );
}
