import { useState } from "react";
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
import { useI18n } from "../../lib/i18n";
import { analysisQueryKeys } from "./queryKeys";
import { AnalysisPublicationSnapshotPreview } from "./AnalysisPublicationSnapshotPreview";
import {
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

export function AnalysisPublicationPanel({
  article,
  scopeKey,
}: {
  article: AnalysisArticleRecord;
  scopeKey: string;
}) {
  const { lang, t } = useI18n();
  const queryClient = useQueryClient();
  const publicationKey = analysisQueryKeys.publication(scopeKey, article.id);
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
      if (!preview) throw new Error(t("analysis.publicationPreviewRequired"));
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

  if (article.state !== "live" || !article.liveRunId) {
    return (
      <div className="tw:mx-auto tw:grid tw:w-full tw:max-w-[900px] tw:gap-3 tw:p-5">
        <InlineNotice tone="warning" icon="alert">
          {t("analysis.publicationLiveFirst")}
        </InlineNotice>
      </div>
    );
  }

  return (
    <div className="tw:mx-auto tw:grid tw:w-full tw:max-w-[1200px] tw:gap-6 tw:p-5 tw:@max-[760px]:p-3">
      {error ? <InlineNotice tone="danger" icon="alert" role="alert">{error}</InlineNotice> : null}

      <section className="tw:grid tw:gap-3">
        <div className="tw:grid tw:gap-1">
          <h2 className="tw:m-0 tw:text-base tw:font-semibold">{t("analysis.publicationTitle")}</h2>
          <p className="tw:m-0 tw:max-w-[86ch] tw:text-sm tw:leading-body tw:text-muted-foreground">
            {t("analysis.publicationBody", { run: article.liveRunId.slice(0, 8) })}
          </p>
        </div>
        <div className="tw:grid tw:grid-cols-2 tw:gap-3 tw:@max-[680px]:grid-cols-1">
          <Field label={t("analysis.publicationPublicTitle")}>
            <TextInput value={request.title} maxLength={160} onChange={(event) => change({ title: event.target.value })} />
          </Field>
          <Field label={t("analysis.publicationSlug")}>
            <TextInput value={request.slug} pattern="[a-z0-9][a-z0-9-]{7,127}" onChange={(event) => change({ slug: event.target.value.toLocaleLowerCase() })} />
          </Field>
          <Field label={t("analysis.publicationVisibility")}>
            <SelectInput value={request.visibility} onChange={(event) => {
              const visibility = event.target.value === "public" ? "public" : "unlisted";
              change({ visibility, searchIndexable: visibility === "public" ? request.searchIndexable : false });
            }}>
              <option value="unlisted">{t("analysis.publicationUnlisted")}</option>
              <option value="public">{t("analysis.publicationPublic")}</option>
            </SelectInput>
          </Field>
          <Field label={t("analysis.publicationReplace")}>
            <SelectInput value={request.replacePublicationId ?? ""} onChange={(event) => change({ replacePublicationId: event.target.value || null })}>
              <option value="">{t("analysis.publicationNewUrl")}</option>
              {(publications.data ?? []).filter((publication) => !publication.revokedAt).map((publication) => (
                <option key={publication.id} value={publication.id}>{publication.slug} · v{publication.version}</option>
              ))}
            </SelectInput>
          </Field>
        </div>
        <Field label={t("analysis.publicationDescription")}>
          <TextAreaInput value={request.description} maxLength={2_000} onChange={(event) => change({ description: event.target.value })} />
        </Field>

        <div className="tw:grid tw:gap-2">
          <strong className="tw:text-sm tw:font-medium">{t("analysis.publicationBlocks")}</strong>
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
            <strong className="tw:text-sm tw:font-medium">{t("analysis.publicationParameters")}</strong>
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
            label={t("analysis.publicationSensitivityConfirm")}
            checked={request.sensitivityConfirmed}
            onChange={(event) => change({ sensitivityConfirmed: event.target.checked })}
          />
          <CheckboxField
            label={t("analysis.publicationProductionConfirm")}
            checked={request.productionConfirmed}
            onChange={(event) => change({ productionConfirmed: event.target.checked })}
          />
          <CheckboxField
            label={t("analysis.publicationIndexable")}
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
            {t("analysis.publicationPreview")}
          </Button>
          <ConfirmButton
            variant="primary"
            disabled={!preview || publishMutation.isPending}
            confirmLabel={t("analysis.publicationPublishConfirm")}
            onConfirm={() => publishMutation.mutate()}
          >
            <Icon name="externalLink" /> {t("analysis.publicationPublish")}
          </ConfirmButton>
        </div>
      </section>

      {preview ? (
        <AnalysisPublicationSnapshotPreview
          definition={article.definition}
          parameterIds={request.parameterIds}
          preview={preview}
        />
      ) : null}

      <section className="tw:grid tw:gap-3 tw:border-t tw:border-border-subtle tw:pt-5">
        <h2 className="tw:m-0 tw:text-base tw:font-semibold">{t("analysis.publicationHistory")}</h2>
        {publications.isPending ? <LoadingLabel>{t("analysis.publicationLoading")}</LoadingLabel> : publications.error ? (
          <InlineNotice tone="danger" icon="alert">{errMessage(publications.error)}</InlineNotice>
        ) : (publications.data?.length ?? 0) === 0 ? (
          <span className="tw:text-sm tw:text-muted-foreground">{t("analysis.publicationEmpty")}</span>
        ) : publications.data?.map((publication) => (
          <div key={publication.id} className="tw:grid tw:grid-cols-[auto_minmax(0,1fr)_auto] tw:items-center tw:gap-3 tw:rounded-md tw:border tw:border-border-subtle tw:bg-card tw:p-3">
            <StatusDot tone={publication.revokedAt ? "neutral" : "success"} />
            <span className="tw:grid tw:min-w-0 tw:gap-0.5">
              <strong className="tw:truncate tw:text-sm tw:font-medium">{publication.title}</strong>
              <span className="tw:truncate tw:text-xs tw:text-muted-foreground">{publication.slug} · v{publication.version} · {publication.visibility === "public" ? t("analysis.publicationPublic") : t("analysis.publicationUnlisted")} · {new Date(publication.publishedAt).toLocaleString(lang)}</span>
              <code className="tw:truncate tw:text-2xs tw:text-muted-foreground">{publication.snapshotHash}</code>
            </span>
            <span className="tw:flex tw:items-center tw:gap-1">
              {!publication.revokedAt ? (
                <Button
                  iconOnly
                  size="xs"
                  variant="ghost"
                  title={t("analysis.publicationOpen")}
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
                  label={t("analysis.publicationRevoke")}
                  confirmLabel={t("analysis.publicationRevokeConfirm")}
                  disabled={revokeMutation.isPending}
                  onConfirm={() => revokeMutation.mutate(publication.id)}
                >
                  <Icon name="trash" />
                </ConfirmButton>
              ) : <StatusBadge density="compact">{t("analysis.publicationRevoked")}</StatusBadge>}
            </span>
          </div>
        ))}
      </section>
    </div>
  );
}
