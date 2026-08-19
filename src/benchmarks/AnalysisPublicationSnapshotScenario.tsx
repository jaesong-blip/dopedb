import { useEffect, useState } from "react";

import { AnalysisPublicationSnapshotPreview } from "../features/analysisArticles/AnalysisPublicationSnapshotPreview";
import type {
  AnalysisArticleDefinition,
  AnalysisPublicationPreview,
} from "../features/analysisArticles/domain";

const PARAMETER_IDS = [
  "00000000-0000-0000-0000-000000000101",
  "00000000-0000-0000-0000-000000000102",
  "00000000-0000-0000-0000-000000000103",
] as const;
const TABLE_BLOCK_ID = "00000000-0000-0000-0000-000000000201";

const definition: AnalysisArticleDefinition = {
  version: 1,
  source: "human",
  title: "Revenue by segment",
  question: "How did reviewed revenue change by segment?",
  summary: "A fixed, reviewed snapshot for packaged-runtime QA.",
  timezone: "Asia/Seoul",
  parameters: [
    {
      id: PARAMETER_IDS[0],
      label: "Include refunds",
      type: "boolean",
      required: true,
      defaultValue: false,
      options: [],
    },
    {
      id: PARAMETER_IDS[1],
      label: "Segment",
      type: "enum",
      required: true,
      defaultValue: "Enterprise",
      options: ["Enterprise", "Growth", "Starter"],
    },
    {
      id: PARAMETER_IDS[2],
      label: "As of",
      type: "date",
      required: true,
      defaultValue: "2026-08-18",
      options: [],
    },
  ],
  queries: [],
  transforms: [],
  metrics: [],
  blocks: [
    {
      id: TABLE_BLOCK_ID,
      kind: "table",
      title: "Reviewed revenue",
      sourceNodeId: null,
      width: 12,
      config: {},
    },
    {
      id: "00000000-0000-0000-0000-000000000202",
      kind: "segment_control",
      title: "Segment",
      sourceNodeId: null,
      width: 4,
      config: { parameterIds: [PARAMETER_IDS[1]] },
    },
  ],
  claims: [],
  refresh: {
    mode: "manual",
    cron: null,
    timezone: "Asia/Seoul",
    runnerId: null,
    maxStalenessSeconds: 86_400,
    resultRetentionDays: 30,
    shareReviewedResults: false,
  },
  warnings: [],
};

const preview: AnalysisPublicationPreview = {
  snapshotHash: "a".repeat(64),
  snapshot: {
    version: 1,
    title: "Revenue by segment",
    description: "Immutable public snapshot candidate",
    summary: definition.summary,
    timezone: definition.timezone,
    dataAsOf: "2026-08-18T09:00:00.000Z",
    searchIndexable: false,
    parameters: [
      { label: "Include refunds", value: false },
      { label: "Segment", value: "Enterprise" },
      { label: "As of", value: "2026-08-18" },
    ],
    blocks: [{
      id: TABLE_BLOCK_ID,
      kind: "table",
      title: "Reviewed revenue",
      width: 12,
      config: {},
      fragments: [{
        version: 1,
        blockId: TABLE_BLOCK_ID,
        ordinal: 0,
        columns: [
          {
            name: "segment",
            type: "string",
            nullable: false,
            role: "dimension",
            sensitivity: "public",
            masking: "none",
          },
          {
            name: "revenue",
            type: "currency",
            nullable: false,
            role: "measure",
            sensitivity: "public",
            masking: "none",
          },
        ],
        rows: [
          ["Enterprise", 248_000],
          ["Growth", 119_500],
          ["Starter", 46_200],
        ],
        truncated: false,
      }],
    }],
  },
};

export function AnalysisPublicationSnapshotScenario() {
  const [verified, setVerified] = useState(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const snapshot = document.querySelector<HTMLElement>(
        "[data-analysis-publication-snapshot]",
      );
      const hasParameterInput = Boolean(snapshot?.querySelector(
        "input, select, textarea, [role=checkbox]",
      ));
      const text = snapshot?.textContent ?? "";
      setVerified(Boolean(snapshot)
        && !hasParameterInput
        && ["Include refunds", "false", "Segment", "Enterprise", "As of", "2026-08-18"]
          .every((value) => text.includes(value)));
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  return (
    <main className="tw:flex tw:h-screen tw:min-h-0 tw:w-screen tw:min-w-0 tw:flex-col tw:overflow-hidden tw:bg-background tw:text-foreground">
      <header className="tw:flex tw:min-h-control-lg tw:shrink-0 tw:flex-wrap tw:items-center tw:justify-between tw:gap-2 tw:border-b tw:border-border-subtle tw:bg-card tw:px-4 tw:py-2">
        <span className="tw:text-sm tw:font-semibold">
          Packaged QA · immutable publication preview
        </span>
        <span
          className="tw:text-xs tw:font-medium tw:text-muted-foreground"
          data-publication-snapshot-qa={verified ? "verified" : "checking"}
          role="status"
        >
          {verified
            ? "Verified: fixed values, no parameter inputs"
            : "Checking snapshot accessibility contract…"}
        </span>
      </header>
      <div className="scrollbar-sleek tw:min-h-0 tw:flex-1 tw:overflow-auto tw:p-5">
        <div className="tw:mx-auto tw:grid tw:w-full tw:max-w-[1200px] tw:gap-4">
          <p className="tw:m-0 tw:text-sm tw:text-muted-foreground">
            This isolated package-only scenario renders the production publication
            snapshot component. Close the app after manual accessibility and visual QA.
          </p>
          <AnalysisPublicationSnapshotPreview
            definition={definition}
            parameterIds={PARAMETER_IDS}
            preview={preview}
          />
        </div>
      </div>
    </main>
  );
}
