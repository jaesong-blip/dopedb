import {
  buildRuntimeDependencyGraph,
  cyclicDependencyComponents,
} from "./dependency-graph.mjs";

export function collectFrontendDependencyCycleDiagnostics({ read, relative, walk }) {
  const sourceFiles = new Set(
    walk("src")
      .map(relative)
      .filter((filePath) => (
        /\.(?:ts|tsx)$/.test(filePath)
        && !/\.(?:test|spec)\.[^.]+$/.test(filePath)
      )),
  );
  const { graph } = buildRuntimeDependencyGraph(
    [...sourceFiles].map((filePath) => [filePath, read(filePath)]),
    { includeDynamic: true },
  );
  return cyclicDependencyComponents(graph).map(
    (component) => `frontend dependency cycle: ${component.join(" -> ")}`,
  );
}
