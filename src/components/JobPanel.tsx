// Connection-scoped import/export control surface for immutable job plans, native
// file capabilities, exact import approval, durable progress, and retained artifacts.
import { useMemo, useState } from "react";
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
import { jobsQuery, qk } from "../lib/queries";
import { useI18n, type I18nKey } from "../lib/i18n";
import "./JobPanel.css";

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

type Approval = {
  job: Job;
  payloadHash: string;
  confirmationPhrase: string | null;
};

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
    <aside className="grid-panel job-panel" aria-label={t("jobs.title")}>
      <header className="job-panel-head">
        <div>
          <strong>{t("jobs.title")}</strong>
          <span>{relationName}</span>
        </div>
        <button
          className="btn small icon-only icon-xs"
          onClick={onClose}
          aria-label={t("common.close")}
        >
          <Icon name="close" />
        </button>
      </header>

      <div className="job-kind-switch" role="group" aria-label={t("jobs.kind")}>
        <button
          className={`btn small${kind === "export" ? " active" : ""}`}
          onClick={() => resetPlan("export", format)}
        >
          <Icon name="download" />
          {t("jobs.export")}
        </button>
        <button
          className={`btn small${kind === "import" ? " active" : ""}`}
          onClick={() => resetPlan("import", format)}
        >
          <Icon name="upload" />
          {t("jobs.import")}
        </button>
      </div>

      <div className="job-plan-form">
        <label className="job-field">
          <span>{t("jobs.format")}</span>
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
        </label>

        <label className="job-field">
          <span>{t("jobs.batchSize")}</span>
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
        </label>

        <div className="job-file-row">
          <div>
            <span>{kind === "export" ? t("jobs.destination") : t("jobs.source")}</span>
            <strong>{capability?.displayName ?? t("jobs.noFile")}</strong>
            {capability?.sizeBytes != null && (
              <small>{bytes(capability.sizeBytes)}</small>
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
                <div className="job-preview">
                  <strong>
                    {t("jobs.preview", {
                      count: inspection.sampleRows.length,
                    })}
                  </strong>
                  <div>
                    <table>
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
              <div className="job-mapping">
                <label className="job-check">
                  <input
                    type="checkbox"
                    checked={customMapping}
                    onChange={(event) => setCustomMapping(event.target.checked)}
                  />
                  <span>{t("jobs.customMapping")}</span>
                </label>
                <p className="muted">
                  {customMapping
                    ? t("jobs.customMappingHelp")
                    : t("jobs.autoMappingHelp", {
                        count: inspection.fields.length,
                      })}
                </p>
                {customMapping && (
                  <div className="job-mapping-rows">
                    {inspection.fields.map((source) => (
                      <div className="job-mapping-row" key={source}>
                        <code title={source}>{source}</code>
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
                        <label className="job-required">
                          <input
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
          <div className="job-validation">
            <label className="job-field">
              <span>{t("jobs.onError")}</span>
              <select
                value={errorPolicy}
                onChange={(event) =>
                  setErrorPolicy(event.target.value as JobErrorPolicy)
                }
              >
                <option value="stop">{t("jobs.stop")}</option>
                <option value="continue">{t("jobs.continue")}</option>
              </select>
            </label>
            <label className="job-field">
              <span>{t("jobs.maxErrors")}</span>
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
            </label>
            <label className="job-field job-field-wide">
              <span>{t("jobs.nullValues")}</span>
              <input
                value={nullValues}
                onChange={(event) => setNullValues(event.target.value)}
                spellCheck={false}
              />
            </label>
          </div>
        )}

        {inspection && !inspection.resumable && (
          <p className="job-warning">
            <Icon name="alert" />
            {t("jobs.warningNotResumable")}
          </p>
        )}
        {inspection &&
          (format === "sql" || format === "sql_gzip") && (
            <p className="job-warning">
              <Icon name="alert" />
              {t("jobs.warningSqlCritical")}
            </p>
          )}

        <button
          className="btn primary job-create"
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          {busy ? t("common.loading") : t("jobs.create")}
        </button>
      </div>

      {approval && (
        <section className="job-approval" aria-label={t("jobs.approval")}>
          <div className="job-section-head">
            <strong>{t("jobs.reviewImport")}</strong>
            <span>{approval.job.format.toUpperCase()}</span>
          </div>
          <dl>
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
          </dl>
          {approval.confirmationPhrase && (
            <label className="job-field">
              <span>
                {t("approval.confirmationPrompt")}{" "}
                <code>{approval.confirmationPhrase}</code>
              </span>
              <input
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
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

      {error && <div className="error job-error">{error}</div>}

      <section className="job-history" aria-label={t("jobs.history")}>
        <div className="job-section-head">
          <strong>{t("jobs.history")}</strong>
          <button
            className="btn small icon-only"
            disabled={jobs.isFetching}
            onClick={() => void jobs.refetch()}
            aria-label={t("common.refresh")}
          >
            <Icon name="refresh" />
          </button>
        </div>
        {jobs.isPending ? (
          <div className="job-empty">{t("common.loading")}</div>
        ) : jobs.error ? (
          <div className="error">{errMessage(jobs.error)}</div>
        ) : jobs.data?.length ? (
          <div className="job-list">
            {jobs.data.map((job) => {
              const percent = progress(job);
              const jobBusy = busyJobId === job.id;
              return (
                <div className="job-row" key={job.id}>
                  <button
                    className="job-row-main"
                    disabled={jobBusy}
                    onClick={() => void openJob(job)}
                  >
                    <span className={`job-state job-state-${job.state}`} />
                    <span>
                      <strong>
                        {job.kind === "export"
                          ? job.targetSummary
                          : job.sourceSummary}
                      </strong>
                      <small>
                        {job.kind === "export"
                          ? t("jobs.export")
                          : t("jobs.import")}{" "}
                        · {job.format.toUpperCase()} · {t(JOB_STATE_KEYS[job.state])}
                      </small>
                    </span>
                    <span className="job-count">
                      {job.rowsProcessed.toLocaleString()}
                    </span>
                  </button>
                  {percent != null && (
                    <div className="job-progress" aria-label={`${percent.toFixed(0)}%`}>
                      <span style={{ transform: `scaleX(${percent / 100})` }} />
                    </div>
                  )}
                  <div className="job-row-actions ds-control-row">
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
          <div className="job-empty">{t("jobs.empty")}</div>
        )}
      </section>

      {detail && (
        <section className="job-detail">
          <div className="job-section-head">
            <strong>{t("jobs.details")}</strong>
            <button
              className="btn small icon-only icon-xs"
              onClick={() => setDetail(null)}
              aria-label={t("common.close")}
            >
              <Icon name="close" />
            </button>
          </div>
          <dl>
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
          </dl>
          {detail.job.redactedError && (
            <p className="job-warning">
              <Icon name="alert" />
              {detail.job.redactedError}
            </p>
          )}
          {detail.artifacts.map((artifact) => (
            <button
              className="btn small job-artifact"
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
