import { useMemo } from "react";

import { StatusBadge } from "../../design-system/components/Status";
import { useI18n } from "../../lib/i18n";
import { AnalysisArticleVisualization } from "./AnalysisArticleVisualization";
import {
  mergeAnalysisFragments,
  type AnalysisArticleDefinition,
  type AnalysisPublicationPreview,
} from "./domain";

export function AnalysisPublicationSnapshotPreview({
  definition,
  parameterIds,
  preview,
}: {
  definition: AnalysisArticleDefinition;
  parameterIds: readonly string[];
  preview: AnalysisPublicationPreview;
}) {
  const { lang, t } = useI18n();
  const previewDefinition = useMemo(() => ({
    ...definition,
    title: preview.snapshot.title,
    summary: preview.snapshot.summary,
    blocks: preview.snapshot.blocks.map((block) => ({
      id: block.id,
      kind: block.kind,
      title: block.title,
      width: block.width,
      config: block.config,
      sourceNodeId: definition.blocks.find((candidate) =>
        candidate.id === block.id)?.sourceNodeId ?? null,
    })),
  }), [definition, preview]);
  const previewData = useMemo(
    () => mergeAnalysisFragments(
      preview.snapshot.blocks.flatMap((block) => block.fragments),
    ),
    [preview],
  );
  const previewParameterValues = useMemo(() => {
    const selected = new Set(parameterIds);
    const parameters = definition.parameters.filter((parameter) =>
      selected.has(parameter.id),
    );
    return Object.fromEntries(
      parameters.flatMap((parameter, index) => {
        const snapshot = preview.snapshot.parameters[index];
        return snapshot ? [[parameter.id, snapshot.value]] : [];
      }),
    );
  }, [definition.parameters, parameterIds, preview]);

  return (
    <section
      data-analysis-publication-snapshot
      className="tw:grid tw:gap-3 tw:border-t tw:border-border-subtle tw:pt-5"
    >
      <div className="tw:flex tw:flex-wrap tw:items-center tw:gap-2">
        <h2 className="tw:m-0 tw:text-base tw:font-semibold">
          {t("analysis.publicationApprovedPreview")}
        </h2>
        <StatusBadge density="compact">
          {preview.snapshotHash.slice(0, 12)}
        </StatusBadge>
        <span className="tw:text-xs tw:text-muted-foreground">
          {t("analysis.publicationDataAsOf", {
            time: new Date(preview.snapshot.dataAsOf).toLocaleString(lang),
          })}
        </span>
      </div>
      {preview.snapshot.parameters.length ? (
        <dl className="tw:flex tw:flex-wrap tw:gap-2">
          {preview.snapshot.parameters.map((parameter) => (
            <div
              className="tw:flex tw:items-center tw:gap-1 tw:rounded-full tw:border tw:border-border-subtle tw:px-2 tw:py-1 tw:text-xs"
              key={parameter.label}
            >
              <dt className="tw:text-muted-foreground">{parameter.label}</dt>
              <dd className="tw:m-0 tw:font-mono">{String(parameter.value)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <AnalysisArticleVisualization
        definition={previewDefinition}
        data={previewData}
        parameterValues={previewParameterValues}
        mode="snapshot"
      />
    </section>
  );
}
