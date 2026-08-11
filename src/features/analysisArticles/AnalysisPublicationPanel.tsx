import { useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import ConfirmButton from "../../components/ConfirmButton";
import { Icon } from "../../components/Icon";
import { Button } from "../../design-system/components/Button";
import {
  CheckboxField,
  Field,
  SelectInput,
  TextAreaInput,
  TextInput,
} from "../../design-system/components/FormControls";
import {
  InlineNotice,
  LoadingLabel,
  StatusBadge,
  StatusDot,
} from "../../design-system/components/Status";
import { errMessage } from "../../ipc/types";
import { AnalysisArticleVisualization } from "./AnalysisArticleVisualization";
import {
  mergeAnalysisFragments,
  type AnalysisArticleRecord,
  type AnalysisPublicationPreview,
  type AnalysisPublicationRequest,
} from "./domain";
import {
  analysisPublicationUrl,
  listAnalysisPublications,
  previewAnalysisPublication,
  publishAnalysisSnapshot,
  revokeAnalysisPublication,
} from "./tauriAdapter";

const CONTROL_BLOCKS = new Set([
  "date_range_control",
  "comparison_control",
  "segment_control",
]);

function slugify(title: string): string {
  const stem = title
    .normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "analysis";
  return `${stem}-${crypto.randomUUID().slice(0, 8)}`;
}

function requestFor(article: AnalysisArticleRecord): AnalysisPublicationRequest {
  return {
    id: crypto.randomUUID(),
    runId: article.liveRunId ?? "",
    slug: slugify(article.definition.title),
    replacePublicationId: null,
    visibility: "unlisted",
    title: article.definition.title,
    description: article.definition.summary,
    blockIds: article.definition.blocks
      .filter((block) => !CONTROL_BLOCKS.has(block.kind))
      .map((block) => block.id),
    parameterIds: [],
    searchIndexable: false,
    sensitivityConfirmed: false,
    productionConfirmed: false,
    previewHash: null,
  };
}

export function AnalysisPublicationPanel({ article }: { article: AnalysisArticleRecord }) {
  const queryClient = useQueryClient();
  const publicationKey = ["analysis-publications", article.id] as const;
  const publications = useQuery({
    queryKey: publicationKey,
    queryFn: () => listAnalysisPublications(article.id),
    retry: false,
  });
  const [request, setRequest] = useState(() => requestFor(article));
  const [preview, setPreview] = useState<AnalysisPublicationPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const change = (patch: Partial<AnalysisPublicationRequest>) => {
    setRequest((current) => ({ ...current, ...patch, previewHash: null }));
    setPreview(null);
  };
  const previewMutation = useMutation({
    mutationFn: () => previewAnalysisPublication(article.id, { ...request, previewHash: null }),
    onSuccess: (value) => {
      setError(null);
      setPreview(value);
    },
    onError: (nextError) => setError(errMessage(nextError)),
  });
  const publishMutation = useMutation({
    mutationFn: () => {
      if (!preview) throw new Error("Preview this exact snapshot before publishing");
      return publishAnalysisSnapshot(article.id, {
        ...request,
        previewHash: preview.snapshotHash,
      });
    },
    onSuccess: async () => {
      setError(null);
      setPreview(null);
      setRequest(requestFor(article));
      await queryClient.invalidateQueries({ queryKey: publicationKey });
    },
    onError: (nextError) => setError(errMessage(nextError)),
  });
  const revokeMutation = useMutation({
    mutationFn: (publicationId: string) => revokeAnalysisPublication(article.id, publicationId),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: publicationKey });
    },
    onError: (nextError) => setError(errMessage(nextError)),
  });

  const previewDefinition = useMemo(() => {
    if (!preview) return null;
    return {
      ...article.definition,
      title: preview.snapshot.title,
      summary: preview.snapshot.summary,
      blocks: preview.snapshot.blocks.map((block) => ({
        id: block.id,
        kind: block.kind,
        title: block.title,
        width: block.width,
        config: block.config,
        sourceNodeId: article.definition.blocks.find((candidate) => candidate.id === block.id)?.sourceNodeId ?? null,
      })),
    };
  }, [article.definition, preview]);
  const previewData = useMemo(
    () => mergeAnalysisFragments(preview?.snapshot.blocks.flatMap((block) => block.fragments) ?? []),
    [preview],
  );

  if (article.state !== "live" || !article.liveRunId) {
    return (
      <div className="tw:mx-auto tw:grid tw:w-full tw:max-w-[900px] tw:gap-3 tw:p-5">
        <InlineNotice tone="warning" icon="alert">
          Publish an exact reviewed revision live before creating a fixed external snapshot.
        </InlineNotice>
      </div>
    );
  }

  return (
    <div className="tw:mx-auto tw:grid tw:w-full tw:max-w-[1200px] tw:gap-6 tw:p-5 tw:@max-[760px]:p-3">
      {error ? <InlineNotice tone="danger" icon="alert" role="alert">{error}</InlineNotice> : null}

      <section className="tw:grid tw:gap-3">
        <div className="tw:grid tw:gap-1">
          <h2 className="tw:m-0 tw:text-base tw:font-semibold">Fixed public snapshot</h2>
          <p className="tw:m-0 tw:max-w-[86ch] tw:text-sm tw:leading-body tw:text-muted-foreground">
            External readers receive only the selected, privacy-checked block values from live run {article.liveRunId.slice(0, 8)}. SQL, connection identity, refresh access, and workspace evidence never enter the public artifact.
          </p>
        </div>
        <div className="tw:grid tw:grid-cols-2 tw:gap-3 tw:@max-[680px]:grid-cols-1">
          <Field label="Public title">
            <TextInput value={request.title} maxLength={160} onChange={(event) => change({ title: event.target.value })} />
          </Field>
          <Field label="URL slug">
            <TextInput value={request.slug} pattern="[a-z0-9][a-z0-9-]{7,127}" onChange={(event) => change({ slug: event.target.value.toLocaleLowerCase() })} />
          </Field>
          <Field label="Visibility">
            <SelectInput value={request.visibility} onChange={(event) => {
              const visibility = event.target.value === "public" ? "public" : "unlisted";
              change({ visibility, searchIndexable: visibility === "public" ? request.searchIndexable : false });
            }}>
              <option value="unlisted">Unlisted link</option>
              <option value="public">Public</option>
            </SelectInput>
          </Field>
          <Field label="Replace publication">
            <SelectInput value={request.replacePublicationId ?? ""} onChange={(event) => change({ replacePublicationId: event.target.value || null })}>
              <option value="">Create a new URL</option>
              {(publications.data ?? []).filter((publication) => !publication.revokedAt).map((publication) => (
                <option key={publication.id} value={publication.id}>{publication.slug} · v{publication.version}</option>
              ))}
            </SelectInput>
          </Field>
        </div>
        <Field label="Description">
          <TextAreaInput value={request.description} maxLength={2_000} onChange={(event) => change({ description: event.target.value })} />
        </Field>

        <div className="tw:grid tw:gap-2">
          <strong className="tw:text-sm tw:font-medium">Published blocks</strong>
          <div className="tw:grid tw:grid-cols-2 tw:gap-1 tw:rounded-md tw:border tw:border-border-subtle tw:p-2 tw:@max-[620px]:grid-cols-1">
            {article.definition.blocks.filter((block) => !CONTROL_BLOCKS.has(block.kind)).map((block) => (
              <CheckboxField
                key={block.id}
                label={`${block.title || block.id} · ${block.kind.replace(/_/g, " ")}`}
                checked={request.blockIds.includes(block.id)}
                onChange={(event) => change({
                  blockIds: event.target.checked
                    ? [...request.blockIds, block.id]
                    : request.blockIds.filter((id) => id !== block.id),
                })}
              />
            ))}
          </div>
        </div>
        {article.definition.parameters.length ? (
          <div className="tw:grid tw:gap-2">
            <strong className="tw:text-sm tw:font-medium">Parameter values shown publicly</strong>
            <div className="tw:grid tw:grid-cols-2 tw:gap-1 tw:rounded-md tw:border tw:border-border-subtle tw:p-2 tw:@max-[620px]:grid-cols-1">
              {article.definition.parameters.map((parameter) => (
                <CheckboxField
                  key={parameter.id}
                  label={parameter.label}
                  checked={request.parameterIds.includes(parameter.id)}
                  onChange={(event) => change({
                    parameterIds: event.target.checked
                      ? [...request.parameterIds, parameter.id]
                      : request.parameterIds.filter((id) => id !== parameter.id),
                  })}
                />
              ))}
            </div>
          </div>
        ) : null}
        <div className="tw:grid tw:gap-2 tw:rounded-md tw:border tw:border-border-subtle tw:bg-card tw:p-3">
          <CheckboxField
            label="I reviewed every selected block and confirm its masking and sensitivity are safe for external readers"
            checked={request.sensitivityConfirmed}
            onChange={(event) => change({ sensitivityConfirmed: event.target.checked })}
          />
          <CheckboxField
            label="I approve publishing values produced from this live Environment revision"
            checked={request.productionConfirmed}
            onChange={(event) => change({ productionConfirmed: event.target.checked })}
          />
          <CheckboxField
            label="Allow search engines to index this public snapshot"
            checked={request.searchIndexable}
            disabled={request.visibility !== "public"}
            onChange={(event) => change({ searchIndexable: event.target.checked })}
          />
        </div>
        <div className="tw:flex tw:flex-wrap tw:justify-end tw:gap-2">
          <Button
            disabled={previewMutation.isPending || request.blockIds.length === 0 || !request.sensitivityConfirmed || !request.productionConfirmed}
            onClick={() => previewMutation.mutate()}
          >
            {previewMutation.isPending ? <Icon name="refresh" className="tw:animate-spin tw:motion-reduce:animate-none" /> : <Icon name="view" />}
            Preview exact snapshot
          </Button>
          <ConfirmButton
            variant="primary"
            disabled={!preview || publishMutation.isPending}
            confirmLabel="Publish this exact, fixed snapshot externally?"
            onConfirm={() => publishMutation.mutate()}
          >
            <Icon name="externalLink" /> Publish snapshot
          </ConfirmButton>
        </div>
      </section>

      {preview && previewDefinition ? (
        <section className="tw:grid tw:gap-3 tw:border-t tw:border-border-subtle tw:pt-5">
          <div className="tw:flex tw:flex-wrap tw:items-center tw:gap-2">
            <h2 className="tw:m-0 tw:text-base tw:font-semibold">Approved preview</h2>
            <StatusBadge density="compact">{preview.snapshotHash.slice(0, 12)}</StatusBadge>
            <span className="tw:text-xs tw:text-muted-foreground">Data as of {new Date(preview.snapshot.dataAsOf).toLocaleString()}</span>
          </div>
          {preview.snapshot.parameters.length ? (
            <dl className="tw:flex tw:flex-wrap tw:gap-2">
              {preview.snapshot.parameters.map((parameter) => (
                <div className="tw:flex tw:items-center tw:gap-1 tw:rounded-full tw:border tw:border-border-subtle tw:px-2 tw:py-1 tw:text-xs" key={parameter.label}>
                  <dt className="tw:text-muted-foreground">{parameter.label}</dt>
                  <dd className="tw:m-0 tw:font-mono">{String(parameter.value)}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          <AnalysisArticleVisualization
            definition={previewDefinition}
            data={previewData}
            parameterValues={{}}
            onParameterChange={() => undefined}
          />
        </section>
      ) : null}

      <section className="tw:grid tw:gap-3 tw:border-t tw:border-border-subtle tw:pt-5">
        <h2 className="tw:m-0 tw:text-base tw:font-semibold">Publication history</h2>
        {publications.isPending ? <LoadingLabel>Loading publications…</LoadingLabel> : publications.error ? (
          <InlineNotice tone="danger" icon="alert">{errMessage(publications.error)}</InlineNotice>
        ) : (publications.data?.length ?? 0) === 0 ? (
          <span className="tw:text-sm tw:text-muted-foreground">No external snapshot has been published.</span>
        ) : publications.data?.map((publication) => (
          <div key={publication.id} className="tw:grid tw:grid-cols-[auto_minmax(0,1fr)_auto] tw:items-center tw:gap-3 tw:rounded-md tw:border tw:border-border-subtle tw:bg-card tw:p-3">
            <StatusDot tone={publication.revokedAt ? "neutral" : "success"} />
            <span className="tw:grid tw:min-w-0 tw:gap-0.5">
              <strong className="tw:truncate tw:text-sm tw:font-medium">{publication.title}</strong>
              <span className="tw:truncate tw:text-xs tw:text-muted-foreground">{publication.slug} · v{publication.version} · {publication.visibility} · {new Date(publication.publishedAt).toLocaleString()}</span>
              <code className="tw:truncate tw:text-2xs tw:text-muted-foreground">{publication.snapshotHash}</code>
            </span>
            <span className="tw:flex tw:items-center tw:gap-1">
              {!publication.revokedAt ? (
                <Button
                  iconOnly
                  size="xs"
                  variant="ghost"
                  title="Open public snapshot"
                  onClick={() => void analysisPublicationUrl(publication.slug).then(openUrl)}
                >
                  <Icon name="externalLink" />
                </Button>
              ) : null}
              {!publication.revokedAt ? (
                <ConfirmButton
                  iconOnly
                  size="xs"
                  variant="ghost"
                  label="Revoke public snapshot"
                  confirmLabel="Revoke this public URL?"
                  disabled={revokeMutation.isPending}
                  onConfirm={() => revokeMutation.mutate(publication.id)}
                >
                  <Icon name="trash" />
                </ConfirmButton>
              ) : <StatusBadge density="compact">Revoked</StatusBadge>}
            </span>
          </div>
        ))}
      </section>
    </div>
  );
}
