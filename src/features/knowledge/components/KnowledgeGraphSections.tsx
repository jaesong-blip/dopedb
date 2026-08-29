// Dormant graph mapping and exploration presentation retained behind the product flag.
import { Icon } from "../../../components/Icon";
import { Button } from "../../../design-system/components/Button";
import { Field, TextInput } from "../../../design-system/components/FormControls";
import {
  InlineNotice,
  LoadingLabel,
  StatusBadge,
  type StatusTone,
} from "../../../design-system/components/Status";
import { errMessage } from "../../../ipc/types";
import { useI18n } from "../../../lib/i18n";
import type { KnowledgeMapping, KnowledgeSearchResult } from "../domain";
import {
  knowledgeMappingStateKey,
  knowledgeMappingTargetKey,
} from "../workspaceModel";

interface KnowledgeMappingSectionProps {
  mappings: KnowledgeMapping[] | undefined;
  pending: boolean;
  error: unknown;
  decisionPending: boolean;
  onRefresh: () => void;
  onDecision: (
    proposalId: string,
    graphRevisionId: string,
    decision: "approved" | "rejected",
  ) => void;
}

export function KnowledgeMappingSection({
  mappings,
  pending,
  error,
  decisionPending,
  onRefresh,
  onDecision,
}: KnowledgeMappingSectionProps) {
  const { t } = useI18n();
  return (
    <section data-primary-flow className="tw:grid tw:gap-3 tw:border-b tw:border-border-subtle tw:pb-5">
      <div className="tw:flex tw:min-w-0 tw:flex-wrap tw:items-start tw:justify-between tw:gap-3">
        <div className="tw:grid tw:gap-1">
          <h2 className="tw:m-0 tw:text-base tw:font-semibold">
            {t("knowledge.mappingTitle")}
          </h2>
          <p className="tw:m-0 tw:max-w-[720px] tw:text-sm tw:leading-relaxed tw:text-muted-foreground">
            {t("knowledge.mappingBody")}
          </p>
        </div>
        <Button
          iconOnly
          size="compact"
          variant="ghost"
          title={t("knowledge.refreshMappings")}
          onClick={onRefresh}
        >
          <Icon name="refresh" />
        </Button>
      </div>
      {pending ? (
        <LoadingLabel>{t("knowledge.loadingMappings")}</LoadingLabel>
      ) : error ? (
        <InlineNotice tone="danger" icon="alert">
          {errMessage(error)}
        </InlineNotice>
      ) : (mappings?.length ?? 0) === 0 ? (
        <p className="tw:m-0 tw:text-sm tw:text-muted-foreground">
          {t("knowledge.emptyMappings")}
        </p>
      ) : (
        <div className="tw:grid tw:overflow-hidden tw:rounded-md tw:border tw:border-border-subtle">
          {mappings?.map((mapping) => {
            const tone: StatusTone =
              mapping.state === "approved"
                ? "success"
                : mapping.state === "rejected"
                  ? "danger"
                  : mapping.state === "stale"
                    ? "warning"
                    : "neutral";
            return (
              <article
                key={mapping.id}
                className="tw:grid tw:min-w-0 tw:grid-cols-[minmax(0,1fr)_auto] tw:items-center tw:gap-3 tw:border-b tw:border-border-subtle tw:px-3 tw:py-3 tw:last:border-b-0 tw:@max-[680px]:grid-cols-1"
              >
                <div className="tw:grid tw:min-w-0 tw:gap-1.5">
                  <div className="tw:flex tw:min-w-0 tw:flex-wrap tw:items-center tw:gap-2">
                    <StatusBadge tone={tone} density="compact">
                      {t(knowledgeMappingStateKey[mapping.state])}
                    </StatusBadge>
                    <StatusBadge density="compact">
                      {t(knowledgeMappingTargetKey[mapping.targetKind])}
                    </StatusBadge>
                    <span className="tw:truncate tw:text-xs tw:text-muted-foreground">
                      {mapping.database}
                    </span>
                  </div>
                  <div className="tw:grid tw:min-w-0 tw:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] tw:items-center tw:gap-2 tw:text-sm tw:@max-[560px]:grid-cols-1">
                    <code className="tw:truncate tw:text-xs">
                      {mapping.fromNodeName}
                    </code>
                    <span className="tw:text-xs tw:text-muted-foreground tw:@max-[560px]:hidden">→</span>
                    <code className="tw:truncate tw:text-xs">
                      {mapping.targetIdentity}
                    </code>
                  </div>
                  <span className="tw:truncate tw:font-mono tw:text-[11px] tw:text-muted-foreground">
                    {t("knowledge.mappingRevision", {
                      graph: mapping.graphRevisionId.slice(0, 8),
                      connection: mapping.connectionRevision,
                      schema: mapping.schemaFingerprint.slice(0, 8),
                    })}
                  </span>
                </div>
                {mapping.state === "proposed" ? (
                  <div className="tw:flex tw:flex-wrap tw:items-center tw:justify-end tw:gap-2 tw:@max-[680px]:justify-start">
                    <Button
                      size="compact"
                      variant="primary"
                      disabled={decisionPending}
                      onClick={() =>
                        onDecision(
                          mapping.id,
                          mapping.graphRevisionId,
                          "approved",
                        )
                      }
                    >
                      <Icon name="check" />
                      {t("knowledge.approve")}
                    </Button>
                    <Button
                      size="compact"
                      variant="dangerGhost"
                      disabled={decisionPending}
                      onClick={() =>
                        onDecision(
                          mapping.id,
                          mapping.graphRevisionId,
                          "rejected",
                        )
                      }
                    >
                      {t("knowledge.reject")}
                    </Button>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function KnowledgeExploreSection({
  query,
  result,
  pending,
  environmentSelected,
  onQueryChange,
  onSearch,
}: {
  query: string;
  result: KnowledgeSearchResult | undefined;
  pending: boolean;
  environmentSelected: boolean;
  onQueryChange: (query: string) => void;
  onSearch: () => void;
}) {
  const { t } = useI18n();
  return (
    <section data-primary-flow className="tw:grid tw:gap-3 tw:border-t tw:border-border-subtle tw:pt-5">
      <div className="tw:grid tw:gap-1">
        <h2 className="tw:m-0 tw:text-base tw:font-semibold">
          {t("knowledge.viewExplore")}
        </h2>
        <p className="tw:m-0 tw:text-sm tw:text-muted-foreground">
          {t("knowledge.exploreBody")}
        </p>
      </div>
      <div className="tw:grid tw:grid-cols-[minmax(0,1fr)_auto] tw:items-end tw:gap-2 tw:@max-[620px]:grid-cols-1">
        <Field label={t("knowledge.searchField")}>
          <TextInput
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && query.trim() && environmentSelected) {
                onSearch();
              }
            }}
          />
        </Field>
        <Button
          variant="primary"
          disabled={!query.trim() || !environmentSelected || pending}
          onClick={onSearch}
        >
          {pending ? t("knowledge.searching") : t("knowledge.search")}
        </Button>
      </div>
      {result ? (
        <div className="tw:grid tw:overflow-hidden tw:rounded-md tw:border tw:border-border-subtle">
          {result.matches.length === 0 ? (
            <p className="tw:m-0 tw:p-3 tw:text-sm tw:text-muted-foreground">
              {t("knowledge.emptySearch")}
            </p>
          ) : (
            result.matches.map((match) => (
              <div
                key={`${match.graphRevisionId}:${match.node.id}`}
                className="tw:grid tw:min-w-0 tw:grid-cols-[auto_minmax(0,1fr)] tw:items-center tw:gap-2 tw:border-b tw:border-border-subtle tw:px-3 tw:py-2 tw:last:border-b-0"
              >
                <StatusBadge density="compact">{match.node.kind}</StatusBadge>
                <span className="tw:grid tw:min-w-0 tw:gap-0.5">
                  <strong className="tw:truncate tw:text-sm">
                    {match.node.name}
                  </strong>
                  <span className="tw:truncate tw:font-mono tw:text-xs tw:text-muted-foreground">
                    {match.node.qualifiedName}
                  </span>
                </span>
              </div>
            ))
          )}
        </div>
      ) : null}
    </section>
  );
}
