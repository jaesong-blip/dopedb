// Selects one packaged benchmark scenario while each scenario family owns its
// fixtures and interactions in a focused module.
import { useEffect } from "react";

import { AnalysisPublicationSnapshotScenario } from "./AnalysisPublicationSnapshotScenario";
import {
  AgentToolsScenario,
  AgentTranscriptScenario,
} from "./packaged/AgentScenarios";
import {
  ExplorerSearchScenario,
  LongLivedDataScenario,
  QueryResultScenario,
} from "./packaged/DataScenarios";
import {
  IdleRuntimeScenario,
  InteractionSurfacesScenario,
} from "./packaged/InteractionScenarios";
import {
  SqlEditorScenario,
  TableFirstRowScenario,
} from "./packaged/SqlScenarios";
import {
  BenchmarkSurface,
  finishBenchmark,
} from "./packaged/benchmarkHarness";

export function PackagedBenchmarkApplication({
  scenario,
  phase,
}: {
  scenario: string;
  phase: "install" | "restart" | null;
}) {
  switch (scenario) {
    case "sql-editor":
      return <SqlEditorScenario />;
    case "explorer-search":
      return <ExplorerSearchScenario />;
    case "query-result":
      return <QueryResultScenario />;
    case "table-first-row":
      return <TableFirstRowScenario />;
    case "agent-transcript":
      return <AgentTranscriptScenario />;
    case "agent-tools":
      return <AgentToolsScenario phase={phase} />;
    case "long-lived-data":
      return <LongLivedDataScenario />;
    case "interaction-surfaces":
      return <InteractionSurfacesScenario />;
    case "idle-runtime":
      return <IdleRuntimeScenario />;
    case "publication-snapshot-qa":
      return <AnalysisPublicationSnapshotScenario />;
    default:
      return <BenchmarkFailure />;
  }
}

function BenchmarkFailure() {
  useEffect(() => {
    void finishBenchmark();
  }, []);
  return <BenchmarkSurface title="Unsupported benchmark scenario" />;
}
