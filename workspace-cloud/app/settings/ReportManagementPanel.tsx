"use client";

// Reports contain only versioned narrative and immutable query provenance. Result
// rows, local artifacts, credentials, and Agent transcripts have no client shape.
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  ControlButton,
  ControlField,
  ControlInput,
  ControlSelect,
  ControlTextarea,
} from "../components/Controls";
import { useWorkspaceLocale } from "../components/WorkspaceLocale";
import { workspaceMessages } from "../../lib/workspace-messages";
import {
  isReportSource,
  isReportState,
  parseReportVersionPayload,
  parseSharedReportDefinition,
  type ReportSource,
  type ReportState,
  type ReportVersionPayload,
  type SharedReportClaim,
  type SharedReportDefinition,
} from "../../lib/workspace-reports";

type SharedReportSummary = SharedReportDefinition & {
  id: string;
  connectionId: string;
  state: ReportState;
  source: ReportSource;
  ownerMemberId: string;
  updatedByMemberId: string;
  revision: number;
  evidenceCount: number;
  createdAt: string;
  updatedAt: string;
};

type SharedReportEvidence = {
  id: string;
  queryRunId: string;
  sql: string;
  executedAt: string;
  addedAtRevision: number;
  createdByMemberId: string;
  createdAt: string;
};

type SharedReportDetail = SharedReportSummary & {
  evidence: SharedReportEvidence[];
};

type ReportRevision = {
  revision: number;
  baseRevision: number;
  operation: string;
  payload: ReportVersionPayload;
  createdByMemberId: string;
  createdAt: string;
};

type WorkspaceMember = {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: string;
};

type ReportAuthority = {
  memberId: string;
  canEdit: boolean;
  canManageAll: boolean;
};

const summaryFields = [
  "id",
  "connectionId",
  "title",
  "question",
  "conclusion",
  "preflightWarnings",
  "claims",
  "state",
  "source",
  "ownerMemberId",
  "updatedByMemberId",
  "revision",
  "evidenceCount",
  "createdAt",
  "updatedAt",
] as const;
const evidenceFields = [
  "id",
  "queryRunId",
  "sql",
  "executedAt",
  "addedAtRevision",
  "createdByMemberId",
  "createdAt",
] as const;
const reportOperations = [
  "propose",
  "create",
  "update",
  "submit_review",
  "return_draft",
  "publish",
  "archive",
  "restore",
  "transfer",
  "append_evidence",
  "delete",
] as const;
const workspaceRoles = ["viewer", "analyst", "editor", "admin", "owner"] as const;

function exactRecord(value: unknown, fields: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(record, field))
    ? record
    : null;
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(new Date(value).valueOf());
}

function reportDefinition(row: Record<string, unknown>) {
  try {
    return parseSharedReportDefinition({
      title: row.title,
      question: row.question,
      conclusion: row.conclusion,
      preflightWarnings: row.preflightWarnings,
      claims: row.claims,
    });
  } catch {
    return null;
  }
}

function validSummaryRecord(row: Record<string, unknown>): row is Record<string, unknown> & SharedReportSummary {
  return typeof row.id === "string"
    && typeof row.connectionId === "string"
    && reportDefinition(row) !== null
    && isReportState(row.state)
    && isReportSource(row.source)
    && typeof row.ownerMemberId === "string"
    && typeof row.updatedByMemberId === "string"
    && Number.isSafeInteger(row.revision)
    && (row.revision as number) >= 1
    && Number.isSafeInteger(row.evidenceCount)
    && (row.evidenceCount as number) >= 1
    && (row.evidenceCount as number) <= 256
    && validDate(row.createdAt)
    && validDate(row.updatedAt);
}

function validReportSummary(value: unknown): value is SharedReportSummary {
  const row = exactRecord(value, summaryFields);
  return Boolean(row && validSummaryRecord(row));
}

function validEvidence(value: unknown): value is SharedReportEvidence {
  const row = exactRecord(value, evidenceFields);
  return Boolean(
    row
    && typeof row.id === "string"
    && typeof row.queryRunId === "string"
    && typeof row.sql === "string"
    && row.sql.trim().length > 0
    && validDate(row.executedAt)
    && Number.isSafeInteger(row.addedAtRevision)
    && (row.addedAtRevision as number) >= 1
    && typeof row.createdByMemberId === "string"
    && validDate(row.createdAt),
  );
}

function validReportDetail(value: unknown): value is SharedReportDetail {
  const row = exactRecord(value, [...summaryFields, "evidence"]);
  return Boolean(
    row
    && validSummaryRecord(row)
    && Array.isArray(row.evidence)
    && row.evidence.length >= 1
    && row.evidence.every(validEvidence),
  );
}

function validRevision(value: unknown): value is ReportRevision {
  const row = exactRecord(value, [
    "revision",
    "baseRevision",
    "operation",
    "payload",
    "createdByMemberId",
    "createdAt",
  ]);
  if (
    !row
    || !Number.isSafeInteger(row.revision)
    || (row.revision as number) < 1
    || !Number.isSafeInteger(row.baseRevision)
    || (row.baseRevision as number) < 0
    || typeof row.operation !== "string"
    || !reportOperations.includes(row.operation as (typeof reportOperations)[number])
    || typeof row.createdByMemberId !== "string"
    || !validDate(row.createdAt)
  ) return false;
  try {
    parseReportVersionPayload(row.payload);
    return true;
  } catch {
    return false;
  }
}

function validMember(value: unknown): value is WorkspaceMember {
  const row = exactRecord(value, ["id", "userId", "name", "email", "role"]);
  return Boolean(
    row
    && typeof row.id === "string"
    && typeof row.userId === "string"
    && typeof row.name === "string"
    && typeof row.email === "string"
    && typeof row.role === "string"
    && workspaceRoles.includes(row.role as (typeof workspaceRoles)[number]),
  );
}

function validAuthority(value: unknown): value is ReportAuthority {
  const row = exactRecord(value, ["memberId", "canEdit", "canManageAll"]);
  return Boolean(
    row
    && typeof row.memberId === "string"
    && typeof row.canEdit === "boolean"
    && typeof row.canManageAll === "boolean",
  );
}

function editableDefinition(report: SharedReportSummary): SharedReportDefinition {
  return {
    title: report.title,
    question: report.question,
    conclusion: report.conclusion,
    preflightWarnings: [...report.preflightWarnings],
    claims: report.claims.map((claim) => ({
      id: claim.id,
      statement: claim.statement,
      evidenceIds: [...claim.evidenceIds],
    })),
  };
}

export function ReportManagementPanel({
  workspaceId,
  canEditWorkspace,
}: {
  workspaceId: string;
  canEditWorkspace: boolean;
}) {
  const locale = useWorkspaceLocale();
  const copy = workspaceMessages[locale].sharedReports;
  const [reports, setReports] = useState<SharedReportSummary[]>([]);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [authority, setAuthority] = useState<ReportAuthority | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<SharedReportDetail | null>(null);
  const [definition, setDefinition] = useState<SharedReportDefinition | null>(null);
  const [ownerCandidate, setOwnerCandidate] = useState("");
  const [revisions, setRevisions] = useState<ReportRevision[]>([]);
  const [historyEvidence, setHistoryEvidence] = useState<SharedReportEvidence[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState("");

  const selected = useMemo(
    () => reports.find((report) => report.id === selectedId) ?? null,
    [reports, selectedId],
  );
  const validatedDefinition = useMemo(() => {
    if (!definition) return null;
    try {
      return parseSharedReportDefinition(definition);
    } catch {
      return null;
    }
  }, [definition]);
  const dirty = useMemo(() => Boolean(
    detail
    && definition
    && JSON.stringify(definition) !== JSON.stringify(editableDefinition(detail)),
  ), [definition, detail]);
  const canMutate = Boolean(
    detail
    && authority
    && authority.canEdit
    && (authority.canManageAll || authority.memberId === detail.ownerMemberId),
  );
  const evidenceById = useMemo(() => new Map(
    [...(detail?.evidence ?? []), ...historyEvidence].map((evidence) => [evidence.id, evidence]),
  ), [detail?.evidence, historyEvidence]);

  const responseError = useCallback(async (
    response: Response | null,
    fallback: string,
  ) => {
    const body = await response?.json().catch(() => null);
    return typeof body?.error === "string" ? body.error : fallback;
  }, []);

  const stateLabel = useCallback((state: ReportState) => ({
    draft: copy.stateDraft,
    review: copy.stateReview,
    published: copy.statePublished,
    archived: copy.stateArchived,
  })[state], [copy]);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    const [reportResponse, memberResponse] = await Promise.all([
      fetch(`/api/v1/workspaces/${workspaceId}/reports`, { cache: "no-store", signal })
        .catch(() => null),
      canEditWorkspace
        ? fetch(`/api/v1/workspaces/${workspaceId}/reports/owners`, { cache: "no-store", signal })
          .catch(() => null)
        : Promise.resolve(null),
    ]);
    if (signal?.aborted) return;
    if (!reportResponse?.ok || (canEditWorkspace && !memberResponse?.ok)) {
      setError(await responseError(
        !reportResponse?.ok ? reportResponse : memberResponse,
        copy.loadError,
      ));
      setLoading(false);
      return;
    }
    const [reportBody, memberBody] = await Promise.all([
      reportResponse.json().catch(() => null),
      memberResponse?.json().catch(() => null) ?? Promise.resolve({ owners: [] }),
    ]);
    if (
      !Array.isArray(reportBody?.reports)
      || !reportBody.reports.every(validReportSummary)
      || !validAuthority(reportBody?.authority)
      || (canEditWorkspace && (
        !Array.isArray(memberBody?.owners)
        || !memberBody.owners.every(validMember)
      ))
    ) {
      setError(copy.shapeError);
      setLoading(false);
      return;
    }
    const nextReports = reportBody.reports as SharedReportSummary[];
    setReports(nextReports);
    setAuthority(reportBody.authority as ReportAuthority);
    setMembers(canEditWorkspace ? memberBody.owners as WorkspaceMember[] : []);
    setSelectedId((current) => (
      nextReports.some((report) => report.id === current)
        ? current
        : nextReports[0]?.id ?? ""
    ));
    setError("");
    setLoading(false);
  }, [canEditWorkspace, copy.loadError, copy.shapeError, responseError, workspaceId]);

  const loadDetail = useCallback(async (reportId: string, signal?: AbortSignal) => {
    if (!reportId) {
      setDetail(null);
      setDefinition(null);
      setRevisions([]);
      setHistoryEvidence([]);
      return;
    }
    setDetailLoading(true);
    const [detailResponse, historyResponse] = await Promise.all([
      fetch(`/api/v1/workspaces/${workspaceId}/reports/${reportId}`, {
        cache: "no-store",
        signal,
      }).catch(() => null),
      canEditWorkspace
        ? fetch(`/api/v1/workspaces/${workspaceId}/reports/${reportId}/revisions`, {
          cache: "no-store",
          signal,
        }).catch(() => null)
        : Promise.resolve(null),
    ]);
    if (signal?.aborted) return;
    if (!detailResponse?.ok || (canEditWorkspace && !historyResponse?.ok)) {
      setError(await responseError(
        !detailResponse?.ok ? detailResponse : historyResponse,
        copy.historyError,
      ));
      setDetailLoading(false);
      return;
    }
    const [detailBody, historyBody] = await Promise.all([
      detailResponse.json().catch(() => null),
      historyResponse?.json().catch(() => null)
        ?? Promise.resolve({ revisions: [], evidence: [] }),
    ]);
    if (
      !validReportDetail(detailBody?.report)
      || (canEditWorkspace && (
        !Array.isArray(historyBody?.revisions)
        || !historyBody.revisions.every(validRevision)
        || !Array.isArray(historyBody?.evidence)
        || !historyBody.evidence.every(validEvidence)
      ))
    ) {
      setError(copy.shapeError);
      setDetailLoading(false);
      return;
    }
    const nextDetail = detailBody.report as SharedReportDetail;
    setDetail(nextDetail);
    setDefinition(editableDefinition(nextDetail));
    setOwnerCandidate(nextDetail.ownerMemberId);
    setRevisions(canEditWorkspace ? historyBody.revisions as ReportRevision[] : []);
    setHistoryEvidence(canEditWorkspace ? historyBody.evidence as SharedReportEvidence[] : []);
    setError("");
    setDetailLoading(false);
  }, [canEditWorkspace, copy.historyError, copy.shapeError, responseError, workspaceId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    const controller = new AbortController();
    void loadDetail(selectedId, controller.signal);
    return () => controller.abort();
  }, [loadDetail, selectedId]);

  async function mutate(body: Record<string, unknown>) {
    if (!detail || !canMutate || mutating) return;
    setMutating(true);
    setError("");
    try {
      const response = await fetch(
        `/api/v1/workspaces/${workspaceId}/reports/${detail.id}`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            "if-match": `"${detail.revision}"`,
          },
          body: JSON.stringify(body),
        },
      ).catch(() => null);
      if (!response?.ok) {
        setError(await responseError(response, copy.mutationError));
        return;
      }
      const responseBody = await response.json().catch(() => null);
      if (!validReportDetail(responseBody?.report)) {
        setError(copy.shapeError);
        return;
      }
      setDetail(responseBody.report);
      setDefinition(editableDefinition(responseBody.report));
      await load();
      await loadDetail(responseBody.report.id);
    } finally {
      setMutating(false);
    }
  }

  function updateClaim(claimId: string, statement: string) {
    setDefinition((current) => current ? {
      ...current,
      claims: current.claims.map((claim) => (
        claim.id === claimId ? { ...claim, statement } : claim
      )),
    } : current);
  }

  function updateWarning(index: number, warning: string) {
    setDefinition((current) => current ? {
      ...current,
      preflightWarnings: current.preflightWarnings.map((item, itemIndex) => (
        itemIndex === index ? warning : item
      )),
    } : current);
  }

  function removeWarning(index: number) {
    setDefinition((current) => current ? {
      ...current,
      preflightWarnings: current.preflightWarnings.filter((_, itemIndex) => itemIndex !== index),
    } : current);
  }

  function publish() {
    if (window.confirm(copy.publishConfirm)) {
      void mutate({ action: "publish", confirmation: "publish" });
    }
  }

  return (
    <section className="tw:grid tw:gap-4 tw:px-5 tw:py-5">
      <header className="tw:flex tw:items-start tw:justify-between tw:gap-3 tw:max-[620px]:flex-col">
        <div className="tw:grid tw:gap-1">
          <strong className="tw:text-ui tw:text-foreground">{copy.title}</strong>
          <small className="tw:max-w-[76ch] tw:text-xs tw:leading-body tw:text-muted-foreground">
            {copy.description}
          </small>
        </div>
        <span className="tw:shrink-0 tw:rounded-full tw:border tw:border-success/35 tw:px-2 tw:py-1 tw:font-mono tw:text-2xs tw:text-success">
          {copy.proof}
        </span>
      </header>

      {loading ? (
        <p className="tw:m-0 tw:py-8 tw:text-center tw:text-xs tw:text-muted-foreground">
          {copy.loading}
        </p>
      ) : reports.length === 0 ? (
        <div className="tw:grid tw:place-items-center tw:gap-2 tw:border-y tw:border-border tw:py-12 tw:text-center">
          <strong className="tw:text-sm tw:text-foreground">{copy.emptyTitle}</strong>
          <small className="tw:max-w-[58ch] tw:text-xs tw:leading-body tw:text-muted-foreground">
            {copy.emptyDescription}
          </small>
        </div>
      ) : (
        <div className="tw:grid tw:grid-cols-[minmax(230px,0.34fr)_minmax(0,1fr)] tw:items-start tw:gap-4 tw:max-[900px]:grid-cols-1">
          <nav className="tw:grid tw:overflow-hidden tw:rounded-surface tw:border tw:border-border" aria-label={copy.title}>
            {reports.map((report) => (
              <button
                className="tw:grid tw:min-w-0 tw:cursor-pointer tw:grid-cols-[minmax(0,1fr)_auto] tw:items-center tw:gap-2 tw:border-0 tw:border-b tw:border-border tw:bg-surface tw:px-3 tw:py-3 tw:text-left tw:last:border-b-0 tw:hover:bg-surface-raised tw:data-[active=true]:bg-selection tw:focus-visible:outline-2 tw:focus-visible:outline-offset-[-3px] tw:focus-visible:outline-ring"
                data-active={report.id === selectedId}
                key={report.id}
                onClick={() => setSelectedId(report.id)}
                type="button"
              >
                <span className="tw:grid tw:min-w-0 tw:gap-1">
                  <strong className="tw:truncate tw:text-xs tw:text-foreground">{report.title}</strong>
                  <small className="tw:truncate tw:font-mono tw:text-2xs tw:text-muted-foreground">
                    r{report.revision} · {report.source === "agent_proposal" ? copy.agentSource : copy.humanSource}
                  </small>
                </span>
                <span
                  className="tw:rounded-full tw:border tw:border-warning/50 tw:px-2 tw:py-1 tw:font-mono tw:text-2xs tw:text-warning tw:data-[state=archived]:border-border tw:data-[state=archived]:text-muted-foreground tw:data-[state=published]:border-success/40 tw:data-[state=published]:text-success tw:data-[state=review]:border-primary/45 tw:data-[state=review]:text-primary"
                  data-state={report.state}
                >
                  {stateLabel(report.state)}
                </span>
              </button>
            ))}
          </nav>

          {detailLoading || !detail || !definition || detail.id !== selected?.id ? (
            <p className="tw:m-0 tw:py-12 tw:text-center tw:text-xs tw:text-muted-foreground">
              {copy.loadingDetail}
            </p>
          ) : (
            <article className="tw:grid tw:min-w-0 tw:gap-6 tw:rounded-surface tw:border tw:border-border tw:bg-surface-inset/55 tw:p-4">
              <header className="tw:flex tw:min-w-0 tw:items-start tw:justify-between tw:gap-3 tw:max-[680px]:flex-col">
                <div className="tw:grid tw:min-w-0 tw:gap-1">
                  <span className="tw:font-mono tw:text-2xs tw:tracking-[0.06em] tw:uppercase tw:text-primary">
                    {detail.source === "agent_proposal" ? copy.agentProposal : copy.humanDraft}
                  </span>
                  <h4 className="tw:m-0 tw:text-base tw:font-medium tw:text-foreground">{detail.title}</h4>
                  <small className="tw:text-2xs tw:text-muted-foreground">
                    {copy.revision} {detail.revision} · {detail.evidenceCount} {copy.evidenceCount}
                  </small>
                </div>
                {authority?.canEdit ? (
                  <div className="tw:flex tw:flex-wrap tw:gap-2">
                  {detail.state === "draft" ? (
                    <ControlButton
                      disabled={mutating || dirty || !canMutate}
                      onClick={() => void mutate({ action: "submit_review" })}
                      tone="primary"
                    >
                      {copy.submitReview}
                    </ControlButton>
                  ) : null}
                  {detail.state === "review" ? (
                    <>
                      <ControlButton disabled={mutating || !canMutate} onClick={() => void mutate({ action: "return_draft" })}>
                        {copy.returnDraft}
                      </ControlButton>
                      <ControlButton disabled={mutating || !canMutate} onClick={publish} tone="primary">
                        {copy.publish}
                      </ControlButton>
                    </>
                  ) : null}
                  {detail.state !== "archived" ? (
                    <ControlButton disabled={mutating || !canMutate} onClick={() => void mutate({ action: "archive" })}>
                      {copy.archive}
                    </ControlButton>
                  ) : (
                    <ControlButton
                      disabled={mutating || !canMutate}
                      onClick={() => void mutate({ action: "restore", revision: detail.revision })}
                      tone="primary"
                    >
                      {copy.restore}
                    </ControlButton>
                  )}
                  </div>
                ) : null}
              </header>

              <section className="tw:grid tw:gap-4">
                {authority?.canEdit ? (
                  <div className="tw:grid tw:grid-cols-[minmax(0,1fr)_auto] tw:items-end tw:gap-3 tw:max-[680px]:grid-cols-1">
                  <ControlField label={copy.owner}>
                    <ControlSelect
                      disabled={mutating || !canMutate}
                      onChange={(event) => setOwnerCandidate(event.target.value)}
                      value={ownerCandidate}
                    >
                      {members.map((member) => (
                        <option key={member.id} value={member.id}>
                          {member.name} · {member.email} · {member.role}
                        </option>
                      ))}
                    </ControlSelect>
                  </ControlField>
                  <ControlButton
                    disabled={mutating || !canMutate || !ownerCandidate || ownerCandidate === detail.ownerMemberId}
                    onClick={() => void mutate({ action: "transfer", ownerMemberId: ownerCandidate })}
                  >
                    {copy.transfer}
                  </ControlButton>
                  </div>
                ) : null}

                <ControlField label={copy.reportTitle}>
                  <ControlInput
                    disabled={mutating || !canMutate || detail.state === "archived"}
                    maxLength={120}
                    onChange={(event) => setDefinition({ ...definition, title: event.target.value })}
                    value={definition.title}
                  />
                </ControlField>
                <ControlField label={copy.question}>
                  <ControlTextarea
                    disabled={mutating || !canMutate || detail.state === "archived"}
                    maxLength={8000}
                    onChange={(event) => setDefinition({ ...definition, question: event.target.value })}
                    value={definition.question}
                  />
                </ControlField>
                <ControlField label={copy.conclusion}>
                  <ControlTextarea
                    disabled={mutating || !canMutate || detail.state === "archived"}
                    maxLength={20000}
                    onChange={(event) => setDefinition({ ...definition, conclusion: event.target.value })}
                    value={definition.conclusion}
                  />
                </ControlField>

                <div className="tw:grid tw:gap-2">
                  <div className="tw:flex tw:items-center tw:justify-between tw:gap-3">
                    <strong className="tw:font-mono tw:text-2xs tw:tracking-[0.06em] tw:uppercase tw:text-muted-foreground">
                      {copy.preflightWarnings}
                    </strong>
                    <ControlButton
                      disabled={mutating || !canMutate || detail.state === "archived" || definition.preflightWarnings.length >= 32}
                      onClick={() => setDefinition({
                        ...definition,
                        preflightWarnings: [...definition.preflightWarnings, copy.newWarning],
                      })}
                    >
                      {copy.addWarning}
                    </ControlButton>
                  </div>
                  {definition.preflightWarnings.length === 0 ? (
                    <small className="tw:text-xs tw:text-muted-foreground">{copy.noWarnings}</small>
                  ) : definition.preflightWarnings.map((warning, index) => (
                    <div className="tw:grid tw:grid-cols-[minmax(0,1fr)_auto] tw:items-start tw:gap-2" key={`${index}-${detail.revision}`}>
                      <ControlTextarea
                        disabled={mutating || !canMutate || detail.state === "archived"}
                        maxLength={2000}
                        onChange={(event) => updateWarning(index, event.target.value)}
                        value={warning}
                      />
                      <ControlButton
                        disabled={mutating || !canMutate || detail.state === "archived"}
                        onClick={() => removeWarning(index)}
                      >
                        {copy.removeWarning}
                      </ControlButton>
                    </div>
                  ))}
                </div>

                <div className="tw:flex tw:flex-wrap tw:items-center tw:justify-end tw:gap-2 tw:border-t tw:border-border tw:pt-4">
                  {dirty && !validatedDefinition ? (
                    <small className="tw:mr-auto tw:text-xs tw:text-danger" role="alert">
                      {copy.definitionInvalid}
                    </small>
                  ) : null}
                  {dirty ? (
                    <ControlButton
                      disabled={mutating || !canMutate}
                      onClick={() => setDefinition(editableDefinition(detail))}
                    >
                      {copy.discard}
                    </ControlButton>
                  ) : null}
                  <ControlButton
                    disabled={mutating || !canMutate || detail.state === "archived" || !dirty || !validatedDefinition}
                    onClick={() => void mutate({ action: "update", definition: validatedDefinition })}
                    tone="primary"
                  >
                    {copy.saveDraft}
                  </ControlButton>
                </div>
              </section>

              <section className="tw:grid tw:gap-3">
                <div className="tw:grid tw:gap-1">
                  <strong className="tw:font-mono tw:text-2xs tw:tracking-[0.06em] tw:uppercase tw:text-muted-foreground">
                    {copy.claimsAndEvidence}
                  </strong>
                  <small className="tw:text-xs tw:leading-body tw:text-muted-foreground">
                    {copy.evidenceDescription}
                  </small>
                </div>
                <div className="tw:grid tw:gap-3">
                  {definition.claims.map((claim: SharedReportClaim, claimIndex) => (
                    <article className="tw:grid tw:gap-3 tw:rounded-control tw:border tw:border-border tw:bg-surface tw:p-3" key={claim.id}>
                      <ControlField label={`${copy.claim} ${claimIndex + 1}`}>
                        <ControlTextarea
                          disabled={mutating || !canMutate || detail.state === "archived"}
                          maxLength={4000}
                          onChange={(event) => updateClaim(claim.id, event.target.value)}
                          value={claim.statement}
                        />
                      </ControlField>
                      <div className="tw:grid tw:gap-2">
                        {claim.evidenceIds.map((evidenceId) => {
                          const evidence = evidenceById.get(evidenceId);
                          return evidence ? (
                            <details className="tw:min-w-0 tw:overflow-hidden tw:rounded-control tw:border tw:border-border tw:bg-surface-inset/60" key={evidence.id}>
                              <summary className="tw:grid tw:cursor-pointer tw:grid-cols-[minmax(0,1fr)_auto] tw:items-center tw:gap-3 tw:px-3 tw:py-2 tw:text-xs tw:text-foreground tw:max-[620px]:grid-cols-1">
                                <span className="tw:truncate tw:font-mono tw:text-2xs">
                                  {copy.queryRun} {evidence.queryRunId}
                                </span>
                                <time className="tw:text-2xs tw:text-muted-foreground" dateTime={evidence.executedAt}>
                                  {new Date(evidence.executedAt).toLocaleString(locale)}
                                </time>
                              </summary>
                              <pre className="tw:m-0 tw:max-h-72 tw:overflow-auto tw:border-t tw:border-border tw:p-3 tw:font-mono tw:text-2xs tw:leading-body tw:whitespace-pre-wrap tw:break-words tw:text-muted-foreground">{evidence.sql}</pre>
                            </details>
                          ) : (
                            <small className="tw:text-xs tw:text-danger" key={evidenceId}>{copy.missingEvidence}</small>
                          );
                        })}
                      </div>
                    </article>
                  ))}
                </div>
              </section>

              {revisions.length > 0 ? (
                <section className="tw:grid tw:gap-2">
                  <strong className="tw:font-mono tw:text-2xs tw:tracking-[0.06em] tw:uppercase tw:text-muted-foreground">
                    {copy.history}
                  </strong>
                  <div className="tw:grid tw:divide-y tw:divide-border tw:border-y tw:border-border">
                    {revisions.map((revision) => (
                      <div className="tw:grid tw:grid-cols-[minmax(0,1fr)_auto] tw:items-center tw:gap-3 tw:py-2" key={revision.revision}>
                        <span className="tw:grid tw:min-w-0 tw:gap-0.5">
                          <strong className="tw:text-xs tw:text-foreground">
                            {copy.revision} {revision.revision} · {revision.operation}
                          </strong>
                          <small className="tw:truncate tw:text-2xs tw:text-muted-foreground">
                            {new Date(revision.createdAt).toLocaleString(locale)}
                            {revision.payload.deleted ? ` · ${copy.deletedRevision}` : ""}
                          </small>
                        </span>
                        {revision.revision === detail.revision ? (
                          <span className="tw:font-mono tw:text-2xs tw:text-primary">{copy.current}</span>
                        ) : !revision.payload.deleted ? (
                          <ControlButton
                            disabled={mutating || !canMutate}
                            onClick={() => void mutate({ action: "restore", revision: revision.revision })}
                          >
                            {copy.restore}
                          </ControlButton>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}
              {mutating ? (
                <small className="tw:text-xs tw:text-primary" role="status">{copy.updating}</small>
              ) : null}
              {authority?.canEdit && !canMutate ? (
                <small className="tw:text-xs tw:text-muted-foreground">{copy.ownerReadOnly}</small>
              ) : null}
            </article>
          )}
        </div>
      )}
      {error ? <small className="tw:text-xs tw:text-danger" role="alert">{error}</small> : null}
    </section>
  );
}
