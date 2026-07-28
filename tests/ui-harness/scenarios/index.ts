// 장면 레지스트리. URL query, validator, capture와 spec이 같은 목록을 본다.
import { compactShell } from "./compactShell";
import { dashboard } from "./dashboard";
import { emptyResults } from "./emptyResults";
import { explorerConnected } from "./explorerConnected";
import { firstRun } from "./firstRun";
import { keyboardOnly } from "./keyboardOnly";
import { loadingError } from "./loadingError";
import { longContent } from "./longContent";
import { permissionReview } from "./permissionReview";
import { providerSetup } from "./providerSetup";
import { schemaErd } from "./schemaErd";
import { settings } from "./settings";
import { sqlTerminal } from "./sqlTerminal";
import { tableData } from "./tableData";
import { terminalOpen } from "./terminalOpen";
import type { UiHarnessSceneId, UiHarnessScenario } from "./types";

const registry: readonly UiHarnessScenario[] = [
  firstRun,
  explorerConnected,
  compactShell,
  terminalOpen,
  tableData,
  sqlTerminal,
  schemaErd,
  dashboard,
  settings,
  providerSetup,
  permissionReview,
  loadingError,
  emptyResults,
  longContent,
  keyboardOnly,
];

// 같은 id가 두 번 등록되면 Map이 조용히 하나를 덮어써 장면이 사라진다.
const duplicated = registry
  .map((scenario) => scenario.id)
  .filter((id, index, all) => all.indexOf(id) !== index);
if (duplicated.length > 0) {
  throw new Error(`[ui-harness] duplicate scene id: ${duplicated.join(", ")}`);
}

export const scenarios: ReadonlyMap<UiHarnessSceneId, UiHarnessScenario> =
  new Map(registry.map((scenario) => [scenario.id, scenario]));

export const scenarioIds: readonly UiHarnessSceneId[] = registry.map(
  (scenario) => scenario.id,
);

export function getScenario(id: string): UiHarnessScenario {
  const scenario = scenarios.get(id as UiHarnessSceneId);
  if (!scenario) {
    throw new Error(
      `[ui-harness] unknown scene "${id}". Registered scenes: ${scenarioIds.join(", ")}`,
    );
  }
  return scenario;
}

export function getScenarioFromLocation(location: Location): UiHarnessScenario {
  const requested = new URLSearchParams(location.search).get("scene");
  if (!requested) {
    throw new Error(
      "[ui-harness] missing ?scene= parameter; the harness never guesses a scene",
    );
  }
  return getScenario(requested);
}
