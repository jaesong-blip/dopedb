// Connection-scoped import/export control surface for immutable job plans, native
// file capabilities, exact import approval, durable progress, and retained artifacts.
import { useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  cancelJob,
  createJob,
  getJob,
  inspectJobInput,
  pauseJob,
  pickJobInput,
  pickJobOutput,
  revealJobArtifact,
  startJob,
} from "../features/jobs/tauriAdapter";
import { approveOperation } from "../ipc/commands";
import {
  jobConnectionId,
  jobRelationRef,
  type Job,
  type JobDetail,
  type JobErrorPolicy,
  type JobFieldMapping,
  type JobFileCapability,
  type JobFormat,
  type JobId,
  type JobInputInspection,
  type JobKind,
} from "../features/jobs/domain";
import {
  errMessage,
  type CatalogObjectRef,
  type CatalogRelationV2,
} from "../ipc/types";
import { Icon } from "./Icon";
import { Field } from "../design-system/components/FormControls";
import { StatusDot, type StatusTone } from "../design-system/components/Status";
import { InspectorHeader } from "../design-system/components/Workbench";
import { jobsQuery, qk } from "../lib/queries";
import { useI18n, type I18nKey } from "../lib/i18n";

const FORMATS: JobFormat[] = [
  "csv",
  "tsv",
  "json",
  "ndjson",
  "sql",
  "xlsx",
  "csv_gzip",
  "json_gzip",
  "ndjson_gzip",
  "sql_gzip",
];

const DEFAULT_BATCH_SIZE = 1_000;
const JOB_STATE_KEYS: Record<Job["state"], I18nKey> = {
  cancel_requested: "jobs.stateCancelRequested",
  cancelled: "jobs.stateCancelled",
  failed: "jobs.stateFailed",
  pause_requested: "jobs.statePauseRequested",
  paused: "jobs.statePaused",
  queued: "jobs.stateQueued",
  running: "jobs.stateRunning",
  succeeded: "jobs.stateSucceeded",
};

function extension(format: JobFormat): string {
  return format.endsWith("_gzip")
    ? `${format.replace("_gzip", "")}.gz`
    : format;
}

function bytes(value: number | null): string {
  if (value == null) return "—";
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`;
  if (value < 1_073_741_824) return `${(value / 1_048_576).toFixed(1)} MiB`;
  return `${(value / 1_073_741_824).toFixed(1)} GiB`;
}

function progress(job: Job): number | null {
  if (job.state === "succeeded") return 100;
  if (job.rowsTotal && job.rowsTotal > 0) {
    return Math.min(100, (job.rowsProcessed / job.rowsTotal) * 100);
  }
  if (job.bytesTotal && job.bytesTotal > 0) {
    return Math.min(100, (job.bytesProcessed / job.bytesTotal) * 100);
  }
  return null;
}

function relationLabel(relation: CatalogObjectRef): string {
  return relation.namespace
    ? `${relation.namespace}.${relation.name}`
    : relation.name;
}

function previewCell(row: unknown, field: string): string {
  if (!row || typeof row !== "object" || Array.isArray(row)) return "";
  const value = (row as Record<string, unknown>)[field];
  if (value == null) return "NULL";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function jobStateTone(state: Job["state"]): StatusTone {
  if (state === "running") return "neutral";
  if (state === "succeeded") return "success";
  if (state === "failed" || state === "cancelled") return "danger";
  if (
    state === "paused" ||
    state === "pause_requested" ||
    state === "cancel_requested"
  ) {
    return "warning";
  }
  return "neutral";
}

type Approval = {
  job: Job;
  payloadHash: string;
  confirmationPhrase: string | null;
};

function JobFacts({ children }: { children: ReactNode }) {
  return (
    <dl className="tw:m-0 tw:grid tw:gap-0 tw:[&>div]:grid tw:[&>div]:grid-cols-[minmax(72px,0.4fr)_minmax(0,1fr)] tw:[&>div]:gap-2 tw:[&>div]:border-b tw:[&>div]:border-border-subtle tw:[&>div]:py-1 tw:[&_dd]:m-0 tw:[&_dd]:min-w-0 tw:[&_dd]:break-words tw:[&_dd]:text-right tw:[&_dt]:text-xs tw:[&_dt]:text-muted-foreground">
      {children}
    </dl>
  );
}

export default function JobPanel({
  connectionId,
  relation,
  onClose,
}: {
  connectionId: string;
  relation: CatalogRelationV2;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const jobs = useQuery(jobsQuery(connectionId));
  const scopedConnectionId = jobConnectionId(connectionId);
  const [kind, setKind] = useState<JobKind>("export");
  const [format, setFormat] = useState<JobFormat>("csv");
  const [capability, setCapability] = useState<JobFileCapability | null>(null);
  const [inspection, setInspection] = useState<JobInputInspection | null>(null);
  const [customMapping, setCustomMapping] = useState(false);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [required, setRequired] = useState<Record<string, boolean>>({});
  const [errorPolicy, setErrorPolicy] = useState<JobErrorPolicy>("stop");
  const [maxErrors, setMaxErrors] = useState(1_000);
  const [nullValues, setNullValues] = useState(",NULL,null");
  const [batchSize, setBatchSize] = useState(DEFAULT_BATCH_SIZE);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyJobId, setBusyJobId] = useState<JobId | null>(null);
  const [error, setError] = useState<string | null>(null);

  const relationName = relationLabel(relation.object);
  const targetColumns = useMemo(
    () => new Set(relation.columns.map((column) => column.name)),
    [relation.columns],
  );

  function resetPlan(nextKind = kind, nextFormat = format) {
    setKind(nextKind);
    setFormat(nextFormat);
    setCapability(null);
    setInspection(null);
    setCustomMapping(false);
    setTargets({});
    setRequired({});
    setApproval(null);
    setConfirmation("");
    setError(null);
  }

  async function chooseFile() {
    setBusy(true);
    setError(null);
    try {
      if (kind === "export") {
        const selected = await pickJobOutput(
          scopedConnectionId,
          `${relation.object.name}.${extension(format)}`,
        );
        setCapability(selected);
        setInspection(null);
      } else {
        const selected = await pickJobInput(scopedConnectionId);
        setCapability(selected);
        if (!selected) {
          setInspection(null);
          return;
        }
        const nextInspection = await inspectJobInput(
          scopedConnectionId,
          selected.id,
          format,
        );
        setInspection(nextInspection);
        setTargets(
          Object.fromEntries(
            nextInspection.fields.map((field) => [
              field,
              targetColumns.has(field) ? field : "",
            ]),
          ),
        );
      }
    } catch (cause) {
      setCapability(null);
      setInspection(null);
      setError(errMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  function mappings(): JobFieldMapping[] {
    if (!customMapping || !inspection) return [];
    return inspection.fields.flatMap((source) => {
      const target = targets[source]?.trim();
      return target
        ? [{ source, target, required: required[source] ?? false }]
        : [];
    });
  }

  async function submit() {
    if (!capability) return;
    setBusy(true);
    setError(null);
    try {
      const plan =
        kind === "export"
          ? {
              kind: "export" as const,
              capabilityId: capability.id,
              relation: jobRelationRef(relation.object),
              consistency: "per_batch_current" as const,
              columns: [],
              fieldNames: [],
              batchSize,
            }
          : {
              kind: "import" as const,
              capabilityId: capability.id,
              targetRelation:
                format === "sql" || format === "sql_gzip"
                  ? null
                  : jobRelationRef(relation.object),
              mapping: mappings(),
              validation: {
                onError: errorPolicy,
                maxErrors,
                nullValues: nullValues.split(",").map((value) => value.trim()),
              },
              batchSize,
            };
      const proposed = await createJob({
        connectionId: scopedConnectionId,
        format,
        plan,
      });
      await queryClient.invalidateQueries({ queryKey: qk.jobs(connectionId) });
      if (proposed.approvalRequired) {
        setApproval({
          job: proposed.job,
          payloadHash: proposed.payloadHash,
          confirmationPhrase: proposed.confirmationPhrase,
        });
      } else {
        await startJob(scopedConnectionId, proposed.job.id);
        setCapability(null);
        await queryClient.invalidateQueries({ queryKey: qk.jobs(connectionId) });
      }
    } catch (cause) {
      setError(errMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function approveAndStart() {
    if (!approval) return;
    setBusy(true);
    setError(null);
    try {
      await approveOperation(
        approval.job.operationId,
        approval.payloadHash,
        approval.confirmationPhrase ? confirmation : undefined,
      );
      await startJob(scopedConnectionId, approval.job.id);
      setApproval(null);
      setConfirmation("");
      setCapability(null);
      setDetail(null);
      await queryClient.invalidateQueries({ queryKey: qk.jobs(connectionId) });
    } catch (cause) {
      setError(errMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function cancelApproval() {
    if (!approval) return;
    setBusy(true);
    setError(null);
    try {
      await cancelJob(scopedConnectionId, approval.job.id);
      setApproval(null);
      setConfirmation("");
      setDetail(null);
      await queryClient.invalidateQueries({ queryKey: qk.jobs(connectionId) });
    } catch (cause) {
      setError(errMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function mutateJob(job: Job, action: "start" | "pause" | "cancel") {
    setBusyJobId(job.id);
    setError(null);
    try {
      if (action === "start") await startJob(scopedConnectionId, job.id);
      if (action === "pause") await pauseJob(scopedConnectionId, job.id);
      if (action === "cancel") await cancelJob(scopedConnectionId, job.id);
      await queryClient.invalidateQueries({ queryKey: qk.jobs(connectionId) });
    } catch (cause) {
      setError(errMessage(cause));
    } finally {
      setBusyJobId(null);
    }
  }

  async function openJob(job: Job) {
    setBusyJobId(job.id);
    setError(null);
    try {
      const next = await getJob(scopedConnectionId, job.id);
      setDetail(next);
      if (next.approvalRequired) {
        setApproval({
          job: next.job,
          payloadHash: next.payloadHash,
          confirmationPhrase: next.confirmationPhrase,
        });
        setConfirmation("");
      }
    } catch (cause) {
      setError(errMessage(cause));
    } finally {
      setBusyJobId(null);
    }
  }

  const canSubmit =
    capability !== null &&
    !busy &&
    (kind === "export" ||
      format === "sql" ||
      format === "sql_gzip" ||
      inspection !== null);

  return (
    <aside
      className="grid-panel tw:flex tw:w-[clamp(320px,32vw,480px)] tw:max-w-[44%] tw:shrink-0 tw:flex-col tw:gap-3 tw:overflow-auto tw:rounded-none tw:border-0 tw:border-l tw:border-border-subtle tw:bg-card tw:p-3 tw:shadow-none tw:@max-[920px]:max-h-[42vh] tw:@max-[920px]:w-auto tw:@max-[920px]:max-w-none tw:@max-[760px]:max-h-[min(360px,44dvh)]"
      aria-label={t("jobs.title")}
    >
      <InspectorHeader
        title={t("jobs.title")}
        metadata={
          <span className="tw:overflow-hidden tw:text-xs tw:text-muted-foreground tw:text-ellipsis tw:whitespace-nowrap">
            {relationName}
          </span>
        }
        actions={
          <button
          className="btn small icon-only icon-xs"
          onClick={onClose}
          aria-label={t("common.close")}
        >
          <Icon name="close" />
          </button>
        }
      />

      <div className="tw:grid tw:grid-cols-2 tw:gap-1" role="group" aria-label={t("jobs.kind")}>
        <button
          className="btn small tw:justify-center"
          aria-pressed={kind === "export"}
          onClick={() => resetPlan("export", format)}
        >
          <Icon name="download" />
          {t("jobs.export")}
        </button>
        <button
          className="btn small tw:justify-center"
          aria-pressed={kind === "import"}
          onClick={() => resetPlan("import", format)}
        >
          <Icon name="upload" />
          {t("jobs.import")}
        </button>
      </div>

      <div className="tw:grid tw:grid-cols-[minmax(0,1fr)_minmax(112px,0.45fr)] tw:gap-3 tw:border-t tw:border-border-subtle tw:pt-3 tw:@max-[760px]:grid-cols-1">
        <Field label={t("jobs.format")}>
          <select
            value={format}
            onChange={(event) =>
              resetPlan(kind, event.target.value as JobFormat)
            }
          >
            {FORMATS.map((value) => (
              <option key={value} value={value}>
                {value.replace("_", " + ").toUpperCase()}
              </option>
            ))}
          </select>
        </Field>

        <Field label={t("jobs.batchSize")}>
          <input
            type="number"
            min={100}
            max={10_000}
            step={100}
            value={batchSize}
            onChange={(event) =>
              setBatchSize(
                Math.max(100, Math.min(10_000, Number(event.target.value))),
              )
            }
          />
        </Field>

        <div className="tw:col-span-full tw:flex tw:items-center tw:justify-between tw:gap-2 tw:@max-[760px]:col-span-1">
          <div className="tw:grid tw:min-w-0 tw:gap-1">
            <span className="tw:overflow-hidden tw:text-xs tw:text-muted-foreground tw:text-ellipsis tw:whitespace-nowrap">
              {kind === "export" ? t("jobs.destination") : t("jobs.source")}
            </span>
            <strong className="tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap">
              {capability?.displayName ?? t("jobs.noFile")}
            </strong>
            {capability?.sizeBytes != null && (
              <small className="tw:overflow-hidden tw:text-xs tw:text-muted-foreground tw:text-ellipsis tw:whitespace-nowrap">
                {bytes(capability.sizeBytes)}
              </small>
            )}
          </div>
          <button className="btn small" disabled={busy} onClick={() => void chooseFile()}>
            <Icon name="folder" />
            {t("jobs.chooseFile")}
          </button>
        </div>

        {kind === "import" &&
          inspection &&
          format !== "sql" &&
          format !== "sql_gzip" && (
            <>
              {inspection.sampleRows.length > 0 && (
                <div className="tw:col-span-full tw:grid tw:min-w-0 tw:gap-2 tw:@max-[760px]:col-span-1">
                  <strong className="tw:text-sm">
                    {t("jobs.preview", {
                      count: inspection.sampleRows.length,
                    })}
                  </strong>
                  <div className="tw:overflow-auto tw:border-y tw:border-border-subtle">
                    <table className="tw:w-full tw:border-collapse tw:text-xs tw:[&_td]:max-w-[140px] tw:[&_td]:overflow-hidden tw:[&_td]:border-r tw:[&_td]:border-border-subtle tw:[&_td]:px-2 tw:[&_td]:py-1 tw:[&_td]:text-left tw:[&_td]:text-ellipsis tw:[&_td]:whitespace-nowrap tw:[&_th]:max-w-[140px] tw:[&_th]:overflow-hidden tw:[&_th]:border-r tw:[&_th]:border-border-subtle tw:[&_th]:px-2 tw:[&_th]:py-1 tw:[&_th]:text-left tw:[&_th]:font-semibold tw:[&_th]:text-ellipsis tw:[&_th]:whitespace-nowrap tw:[&_th]:text-muted-foreground">
                      <thead>
                        <tr>
                          {inspection.fields.slice(0, 8).map((field) => (
                            <th key={field}>{field}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {inspection.sampleRows.map((row, index) => (
                          <tr key={index}>
                            {inspection.fields.slice(0, 8).map((field) => (
                              <td key={field} title={previewCell(row, field)}>
                                {previewCell(row, field)}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
              <div className="tw:col-span-full tw:grid tw:gap-2 tw:@max-[760px]:col-span-1">
                <label className="tw:inline-flex tw:items-center tw:gap-1">
                  <input
                    className="tw:w-auto"
                    type="checkbox"
                    checked={customMapping}
                    onChange={(event) => setCustomMapping(event.target.checked)}
                  />
                  <span>{t("jobs.customMapping")}</span>
                </label>
                <p className="tw:m-0 tw:text-xs tw:text-muted-foreground">
                  {customMapping
                    ? t("jobs.customMappingHelp")
                    : t("jobs.autoMappingHelp", {
                        count: inspection.fields.length,
                      })}
                </p>
                {customMapping && (
                  <div className="tw:max-h-[240px] tw:overflow-auto tw:border-y tw:border-border-subtle">
                    {inspection.fields.map((source) => (
                      <div
                        className="tw:grid tw:grid-cols-[minmax(72px,0.8fr)_auto_minmax(100px,1fr)_auto] tw:items-center tw:gap-2 tw:border-b tw:border-border-subtle tw:py-1 tw:last:border-b-0 tw:@max-[760px]:grid-cols-[minmax(72px,0.8fr)_auto_minmax(96px,1fr)]"
                        key={source}
                      >
                        <code
                          className="tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap"
                          title={source}
                        >
                          {source}
                        </code>
                        <Icon name="arrowRight" />
                        <select
                          value={targets[source] ?? ""}
                          onChange={(event) =>
                            setTargets((current) => ({
                              ...current,
                              [source]: event.target.value,
                            }))
                          }
                          aria-label={t("jobs.targetFor", { source })}
                        >
                          <option value="">{t("jobs.skipField")}</option>
                          {relation.columns.map((column) => (
                            <option key={column.name} value={column.name}>
                              {column.name}
                            </option>
                          ))}
                        </select>
                        <label className="tw:inline-flex tw:items-center tw:gap-1 tw:text-xs tw:text-muted-foreground tw:@max-[760px]:col-start-3">
                          <input
                            className="tw:w-auto"
                            type="checkbox"
                            checked={required[source] ?? false}
                            disabled={!targets[source]}
                            onChange={(event) =>
                              setRequired((current) => ({
                                ...current,
                                [source]: event.target.checked,
                              }))
                            }
                          />
                          {t("jobs.required")}
                        </label>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

        {kind === "import" && format !== "sql" && format !== "sql_gzip" && (
          <div className="tw:col-span-full tw:grid tw:grid-cols-[minmax(0,1fr)_minmax(112px,0.55fr)] tw:gap-2 tw:@max-[760px]:col-span-1 tw:@max-[760px]:grid-cols-1">
            <Field label={t("jobs.onError")}>
              <select
                value={errorPolicy}
                onChange={(event) =>
                  setErrorPolicy(event.target.value as JobErrorPolicy)
                }
              >
                <option value="stop">{t("jobs.stop")}</option>
                <option value="continue">{t("jobs.continue")}</option>
              </select>
            </Field>
            <Field label={t("jobs.maxErrors")}>
              <input
                type="number"
                min={1}
                max={1_000_000}
                value={maxErrors}
                onChange={(event) =>
                  setMaxErrors(
                    Math.max(1, Math.min(1_000_000, Number(event.target.value))),
                  )
                }
              />
            </Field>
            <div className="tw:col-span-full tw:@max-[760px]:col-span-1">
              <Field label={t("jobs.nullValues")}>
                <input
                  value={nullValues}
                  onChange={(event) => setNullValues(event.target.value)}
                  spellCheck={false}
                />
              </Field>
            </div>
          </div>
        )}

        {inspection && !inspection.resumable && (
          <p className="tw:col-span-full tw:m-0 tw:flex tw:items-start tw:gap-2 tw:text-xs tw:leading-[1.45] tw:text-warning tw:[&_.icon]:mt-0.5 tw:[&_.icon]:shrink-0 tw:@max-[760px]:col-span-1">
            <Icon name="alert" />
            {t("jobs.warningNotResumable")}
          </p>
        )}
        {inspection &&
          (format === "sql" || format === "sql_gzip") && (
            <p className="tw:col-span-full tw:m-0 tw:flex tw:items-start tw:gap-2 tw:text-xs tw:leading-[1.45] tw:text-warning tw:[&_.icon]:mt-0.5 tw:[&_.icon]:shrink-0 tw:@max-[760px]:col-span-1">
              <Icon name="alert" />
              {t("jobs.warningSqlCritical")}
            </p>
          )}

        <button
          className="btn primary tw:col-span-full tw:justify-center tw:@max-[760px]:col-span-1"
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          {busy ? t("common.loading") : t("jobs.create")}
        </button>
      </div>

      {approval && (
        <section
          className="tw:grid tw:gap-3 tw:border-t tw:border-border-subtle tw:pt-3"
          aria-label={t("jobs.approval")}
        >
          <InspectorHeader
            title={t("jobs.reviewImport")}
            metadata={
              <span className="tw:font-mono tw:text-xs tw:text-muted-foreground">
                {approval.job.format.toUpperCase()}
              </span>
            }
          />
          <JobFacts>
            <div>
              <dt>{t("jobs.source")}</dt>
              <dd>{approval.job.sourceSummary}</dd>
            </div>
            <div>
              <dt>{t("jobs.destination")}</dt>
              <dd>{approval.job.targetSummary}</dd>
            </div>
            <div>
              <dt>SHA-256</dt>
              <dd title={approval.payloadHash}>
                <code>{approval.payloadHash.slice(0, 16)}…</code>
              </dd>
            </div>
          </JobFacts>
          {approval.confirmationPhrase && (
            <Field
              label={
                <span>
                {t("approval.confirmationPrompt")}{" "}
                <code>{approval.confirmationPhrase}</code>
                </span>
              }
            >
              <input
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
          )}
          <div className="ds-action-row ds-control-row">
            <button
              className="btn primary"
              disabled={
                busy ||
                (!!approval.confirmationPhrase &&
                  confirmation !== approval.confirmationPhrase)
              }
              onClick={() => void approveAndStart()}
            >
              {t("jobs.approveAndStart")}
            </button>
            <button
              className="btn"
              disabled={busy}
              onClick={() => void cancelApproval()}
            >
              {t("common.cancel")}
            </button>
          </div>
        </section>
      )}

      {error && <div className="tw:text-ui tw:text-danger">{error}</div>}

      <section
        className="tw:grid tw:gap-3 tw:border-t tw:border-border-subtle tw:pt-3"
        aria-label={t("jobs.history")}
      >
        <InspectorHeader
          title={t("jobs.history")}
          actions={
          <button
            className="btn small icon-only"
            disabled={jobs.isFetching}
            onClick={() => void jobs.refetch()}
            aria-label={t("common.refresh")}
          >
            <Icon name="refresh" />
          </button>
          }
        />
        {jobs.isPending ? (
          <div className="tw:py-4 tw:text-center tw:text-sm tw:text-muted-foreground">
            {t("common.loading")}
          </div>
        ) : jobs.error ? (
          <div className="tw:text-ui tw:text-danger">
            {errMessage(jobs.error)}
          </div>
        ) : jobs.data?.length ? (
          <div className="tw:grid">
            {jobs.data.map((job) => {
              const percent = progress(job);
              const jobBusy = busyJobId === job.id;
              return (
                <div className="tw:grid tw:min-w-0 tw:gap-1 tw:border-t tw:border-border-subtle tw:py-2" key={job.id}>
                  <button
                    className="tw:flex tw:w-full tw:min-w-0 tw:cursor-pointer tw:items-center tw:gap-2 tw:border-0 tw:bg-transparent tw:p-0 tw:text-left tw:text-inherit tw:active:translate-y-px tw:disabled:cursor-default tw:disabled:opacity-50"
                    disabled={jobBusy}
                    onClick={() => void openJob(job)}
                  >
                    <StatusDot tone={jobStateTone(job.state)} />
                    <span className="tw:grid tw:min-w-0 tw:flex-1 tw:gap-0.5">
                      <strong className="tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap">
                        {job.kind === "export"
                          ? job.targetSummary
                          : job.sourceSummary}
                      </strong>
                      <small className="tw:overflow-hidden tw:font-mono tw:text-xs tw:text-muted-foreground tw:text-ellipsis tw:whitespace-nowrap">
                        {job.kind === "export"
                          ? t("jobs.export")
                          : t("jobs.import")}{" "}
                        · {job.format.toUpperCase()} · {t(JOB_STATE_KEYS[job.state])}
                      </small>
                    </span>
                    <span className="tw:font-mono tw:text-xs tw:text-muted-foreground">
                      {job.rowsProcessed.toLocaleString()}
                    </span>
                  </button>
                  {percent != null && (
                    <div
                      className="tw:h-0.5 tw:overflow-hidden tw:bg-border-subtle"
                      aria-label={`${percent.toFixed(0)}%`}
                    >
                      <span
                        className="tw:block tw:h-full tw:w-full tw:origin-left tw:bg-primary tw:transition-transform tw:duration-150 tw:motion-reduce:transition-none"
                        style={{ transform: `scaleX(${percent / 100})` }}
                      />
                    </div>
                  )}
                  <div className="ds-control-row tw:flex tw:justify-end tw:gap-1">
                    {(job.state === "queued" || job.state === "paused") && (
                      <button
                        className="btn small"
                        disabled={jobBusy}
                        onClick={() =>
                          job.kind === "import" && job.state === "queued"
                            ? void openJob(job)
                            : void mutateJob(job, "start")
                        }
                      >
                        <Icon name="play" />
                        {job.kind === "import" && job.state === "queued"
                          ? t("jobs.review")
                          : job.state === "paused"
                            ? t("jobs.resume")
                            : t("jobs.start")}
                      </button>
                    )}
                    {job.state === "running" && job.resumable && (
                      <button
                        className="btn small"
                        disabled={jobBusy}
                        onClick={() => void mutateJob(job, "pause")}
                      >
                        <Icon name="pause" />
                        {t("jobs.pause")}
                      </button>
                    )}
                    {![
                      "cancel_requested",
                      "cancelled",
                      "succeeded",
                      "failed",
                    ].includes(job.state) && (
                      <button
                        className="btn small"
                        disabled={jobBusy}
                        onClick={() => void mutateJob(job, "cancel")}
                      >
                        <Icon name="close" />
                        {t("common.cancel")}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="tw:py-4 tw:text-center tw:text-sm tw:text-muted-foreground">
            {t("jobs.empty")}
          </div>
        )}
      </section>

      {detail && (
        <section className="tw:grid tw:gap-3 tw:border-t tw:border-border-subtle tw:pt-3">
          <InspectorHeader
            title={t("jobs.details")}
            actions={
            <button
              className="btn small icon-only icon-xs"
              onClick={() => setDetail(null)}
              aria-label={t("common.close")}
            >
              <Icon name="close" />
            </button>
            }
          />
          <JobFacts>
            <div>
              <dt>{t("jobs.status")}</dt>
              <dd>{t(JOB_STATE_KEYS[detail.job.state])}</dd>
            </div>
            <div>
              <dt>{t("jobs.rows")}</dt>
              <dd>{detail.job.rowsProcessed.toLocaleString()}</dd>
            </div>
            <div>
              <dt>{t("jobs.bytes")}</dt>
              <dd>{bytes(detail.job.bytesProcessed)}</dd>
            </div>
          </JobFacts>
          {detail.job.redactedError && (
            <p className="tw:m-0 tw:flex tw:items-start tw:gap-2 tw:text-xs tw:leading-[1.45] tw:text-warning tw:[&_.icon]:mt-0.5 tw:[&_.icon]:shrink-0">
              <Icon name="alert" />
              {detail.job.redactedError}
            </p>
          )}
          {detail.artifacts.map((artifact) => (
            <button
              className="btn small tw:w-full tw:justify-start tw:[&>small]:text-muted-foreground tw:[&>span]:min-w-0 tw:[&>span]:flex-1 tw:[&>span]:overflow-hidden tw:[&>span]:text-ellipsis tw:[&>span]:whitespace-nowrap"
              key={artifact.id}
              onClick={() =>
                void revealJobArtifact(scopedConnectionId, artifact.id).catch((cause) =>
                  setError(errMessage(cause)),
                )
              }
            >
              <Icon name="folder" />
              <span>{artifact.displayName}</span>
              <small>{bytes(artifact.sizeBytes)}</small>
            </button>
          ))}
        </section>
      )}
    </aside>
  );
}
