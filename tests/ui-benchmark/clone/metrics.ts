import type { ReferenceCloneSceneId } from "./scenes";

export interface ReferenceMetric {
  value: number;
  unit: "px" | "count" | "ratio";
  source: string;
  meaning: string;
}

type ReferenceMetrics = Record<string, ReferenceMetric>;

const explorerSource =
  "observations/DopeDB-2026.1-explorer.md#7-clone이-표현할-측정값";
const firstRunSource =
  "observations/DopeDB-2026.1-first-run.md#clone-metrics";
const editorSource =
  "observations/DopeDB-2026.1-data-editor.md#clone-metrics";
const consoleSource =
  "observations/DopeDB-2026.1-query-console.md#clone-metrics";
const assistantSource =
  "observations/DopeDB-2026.1-assistant.md#clone-metrics";

const common: ReferenceMetrics = {
  railWidth: {
    value: 44,
    unit: "px",
    source: explorerSource,
    meaning: "Primary mode rail stays narrow and icon-led.",
  },
  panelHeaderHeight: {
    value: 36,
    unit: "px",
    source: explorerSource,
    meaning: "Panel title and window controls share one compact row.",
  },
  toolbarHeight: {
    value: 32,
    unit: "px",
    source: explorerSource,
    meaning: "Object-scoped actions form a second aligned header row.",
  },
  treeRowHeight: {
    value: 28,
    unit: "px",
    source: explorerSource,
    meaning: "Hierarchy depth does not change row density.",
  },
};

export const referenceMetrics: Record<
  ReferenceCloneSceneId,
  ReferenceMetrics
> = {
  "first-run": {
    railWidth: common.railWidth,
    recentPanelWidth: {
      value: 300,
      unit: "px",
      source: firstRunSource,
      meaning: "Recent context remains visible beside primary start actions.",
    },
    primaryActionHeight: {
      value: 36,
      unit: "px",
      source: firstRunSource,
      meaning: "Start actions use one consistent control scale.",
    },
    contentMeasure: {
      value: 620,
      unit: "px",
      source: firstRunSource,
      meaning: "Welcome copy stays readable rather than filling the window.",
    },
  },
  "data-editor": {
    ...common,
    explorerWidth: {
      value: 276,
      unit: "px",
      source: editorSource,
      meaning: "Object context remains visible while the grid owns most space.",
    },
    dataRowHeight: {
      value: 28,
      unit: "px",
      source: editorSource,
      meaning: "Headers and data rows keep a compact shared rhythm.",
    },
    frozenContextRows: {
      value: 3,
      unit: "count",
      source: editorSource,
      meaning: "Title, action toolbar, and column header remain above data.",
    },
  },
  "query-console": {
    ...common,
    explorerWidth: {
      value: 276,
      unit: "px",
      source: consoleSource,
      meaning: "Schema context persists alongside the editor.",
    },
    editorResultRatio: {
      value: 0.58,
      unit: "ratio",
      source: consoleSource,
      meaning: "The editor stays primary while results remain simultaneously visible.",
    },
    resultRowHeight: {
      value: 28,
      unit: "px",
      source: consoleSource,
      meaning: "Result density matches object-tree density.",
    },
  },
  "assistant-open": {
    ...common,
    explorerWidth: {
      value: 244,
      unit: "px",
      source: assistantSource,
      meaning: "Explorer remains visible when contextual review opens.",
    },
    assistantWidth: {
      value: 344,
      unit: "px",
      source: assistantSource,
      meaning: "Review has enough width for exact scope without replacing work.",
    },
    actionDistance: {
      value: 16,
      unit: "px",
      source: assistantSource,
      meaning: "Decision actions stay next to the bounded operation summary.",
    },
  },
};
