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
    gcpProductionApproved,
    gcpRestartApproved,
    mutation,
    completeGcpSetup,
    selectGcpInstance,
    selectGcpProject,
    setGcpProductionApproved,
    setGcpRestartApproved,
  } = controller;
  if (!gcpSetupId) return null;

  const selectedInstance = gcpSetupInstances.find(
    (item) => item.id === selectedGcpInstanceId,
  ) ?? null;
  const productionBlocked = selectedInstance?.production === "unknown";
  const approvalsComplete = Boolean(
    selectedInstance
    && selectedInstance.ready
    && !productionBlocked
    && (!selectedInstance.production || gcpProductionApproved)
    && (selectedInstance.iamAuthenticationEnabled || gcpRestartApproved),
  );
  const busy = mutation.startsWith("gcp:");

  return (
    <section className="tw:grid tw:gap-4 tw:border-y tw:border-border tw:bg-surface-inset tw:p-4">
      <header className="tw:flex tw:items-start tw:justify-between tw:gap-3">
        <div className="tw:grid tw:gap-1">
          <strong className="tw:text-sm tw:text-foreground">
            Google Cloud 연결
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
                  : "환경 분류 필요"}
            </span>
          </div>

          {productionBlocked ? (
            <p className="tw:m-0 tw:border tw:border-danger/40 tw:bg-danger/10 tw:p-3 tw:text-2xs tw:leading-body tw:text-danger">
              이 인스턴스에는 환경 분류가 없습니다. Google Cloud에서
              <code className="tw:mx-1">environment=production</code>
              또는
              <code className="tw:mx-1">environment=development</code>
              라벨을 추가한 후 다시 연결하세요.
            </p>
          ) : null}

          <p className="tw:m-0 tw:text-2xs tw:leading-body tw:text-muted-foreground">
            공유 연결에는 읽기 전용 15분 IAM 자격증명만 발급합니다. 장기 키와
            Google 로그인 토큰은 저장하지 않습니다.
          </p>

          {selectedInstance.production === true ? (
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

      <div className="tw:flex tw:items-center tw:justify-between tw:gap-3 tw:border-t tw:border-border tw:pt-3">
        <small className="tw:text-2xs tw:leading-body tw:text-muted-foreground">
          장기 키 없이 전용 서비스 계정과 인스턴스 범위 IAM을 자동 구성합니다.
        </small>
        <button
          className="tw:h-control-field tw:shrink-0 tw:border-0 tw:bg-primary-emphasis tw:px-4 tw:text-2xs tw:font-extrabold tw:text-primary-foreground tw:disabled:cursor-not-allowed tw:disabled:opacity-50"
          type="button"
          disabled={!approvalsComplete || busy}
          onClick={() => void completeGcpSetup()}
        >
          {mutation === "gcp:bootstrap"
            ? "Google Cloud 설정 중"
            : "자동 설정하고 연결"}
        </button>
      </div>
    </section>
  );
}
