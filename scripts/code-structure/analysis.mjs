// Turns inventory metrics into review findings. Oversized and fragmented are
// symmetric signals: either can raise navigation cost, while neither alone is a
// mechanical refactor order.
import path from "node:path";

import { measureModule } from "./module-metrics.mjs";

const INTENTIONAL_BOUNDARY_NAMES = new Set([
  "commands",
  "constants",
  "contracts",
  "domain",
  "errors",
  "events",
  "ids",
  "ports",
  "types",
]);

const RESOLVABLE_EXTENSIONS = [".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"];

function sourceStem(relativePath) {
  return path.posix.basename(relativePath, path.posix.extname(relativePath));
}

function resolveLocalSpecifier(module, specifier, modulesByPath) {
  if (!specifier.startsWith(".")) return null;
  const base = path.posix.normalize(path.posix.join(module.directory, specifier));
  for (const candidate of [
    base,
    ...RESOLVABLE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...RESOLVABLE_EXTENSIONS.map((extension) => path.posix.join(base, `index${extension}`)),
  ]) {
    if (modulesByPath.has(candidate)) return candidate;
  }
  return null;
}

function moduleDependencies(modules) {
  const modulesByPath = new Map(modules.map((module) => [module.relativePath, module]));
  const graph = new Map();
  const inbound = new Map(modules.map((module) => [module.relativePath, []]));
  for (const module of modules) {
    const dependencies = module.importSpecifiers
      .map((specifier) => resolveLocalSpecifier(module, specifier, modulesByPath))
      .filter(Boolean);
    graph.set(module.relativePath, dependencies);
    for (const dependency of dependencies) inbound.get(dependency)?.push(module.relativePath);
  }
  return { graph, inbound };
}

function tinyFragmentCandidate(module) {
  const stem = sourceStem(module.relativePath);
  return (
    module.category === "production"
    && [".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"].includes(module.extension)
    && module.substantive >= 3
    && module.substantive <= 70
    && module.runtimeDeclarations <= 3
    && !["index", "lib", "main", "mod"].includes(stem)
    && !INTENTIONAL_BOUNDARY_NAMES.has(stem)
  );
}

function collectFragmentation(modules, dependencyData) {
  const byDirectory = new Map();
  for (const module of modules.filter(tinyFragmentCandidate)) {
    const siblings = byDirectory.get(module.directory) ?? [];
    siblings.push(module);
    byDirectory.set(module.directory, siblings);
  }
  const findings = [];
  for (const [directory, candidates] of byDirectory) {
    if (candidates.length < 4) continue;
    const candidatePaths = new Set(candidates.map((candidate) => candidate.relativePath));
    const internalEdges = candidates.reduce(
      (count, candidate) => count + (dependencyData.graph.get(candidate.relativePath) ?? [])
        .filter((dependency) => candidatePaths.has(dependency)).length,
      0,
    );
    const externalConsumers = new Set(candidates.flatMap(
      (candidate) => (dependencyData.inbound.get(candidate.relativePath) ?? [])
        .filter((importer) => !candidatePaths.has(importer)),
    ));
    const totalSubstantive = candidates.reduce((total, candidate) => total + candidate.substantive, 0);
    const coupled = internalEdges >= candidates.length - 1;
    const concentrated = totalSubstantive <= 240 && externalConsumers.size <= 2;
    if (internalEdges < 2 || (!coupled && !concentrated)) continue;
    const score = candidates.length + internalEdges * 2 + Math.max(0, 240 - totalSubstantive) / 60;
    findings.push({
      candidateFiles: candidates.map((candidate) => candidate.relativePath).sort(),
      directory,
      externalConsumerCount: externalConsumers.size,
      internalEdges,
      kind: "fragment-cluster",
      score: Number(score.toFixed(2)),
      severity: "review",
      totalSubstantive,
    });
  }
  return findings.sort((left, right) => right.score - left.score || left.directory.localeCompare(right.directory));
}

function collectModuleFindings(modules) {
  return modules.flatMap((module) => {
    if (module.category === "generated" || module.loc <= module.reviewThreshold) return [];
    const severity = (
      ["production", "tooling"].includes(module.category)
      &&
      module.loc > module.strongThreshold
      && (
        module.riskScore >= 6
        || module.responsibilities.length >= 3
        || module.topLevelDeclarations >= 24
      )
    ) ? "high" : "review";
    return [{
      category: module.category,
      importCount: module.importSpecifiers.length,
      kind: "module-review",
      loc: module.loc,
      parseError: module.parseError,
      path: module.relativePath,
      responsibilities: module.responsibilities,
      riskScore: module.riskScore,
      severity,
      substantive: module.substantive,
      topLevelDeclarations: module.topLevelDeclarations,
    }];
  }).sort((left, right) => (
    Number(right.severity === "high") - Number(left.severity === "high")
    || right.riskScore - left.riskScore
    || right.loc - left.loc
    || left.path.localeCompare(right.path)
  ));
}

export function analyzeCodeStructure(records) {
  const modules = records.map(measureModule);
  const dependencyData = moduleDependencies(modules);
  const moduleFindings = collectModuleFindings(modules);
  const fragmentation = collectFragmentation(modules, dependencyData);
  const categoryCounts = Object.fromEntries(
    [...new Set(modules.map((module) => module.category))]
      .sort()
      .map((category) => [category, modules.filter((module) => module.category === category).length]),
  );
  return {
    categoryCounts,
    findings: [...moduleFindings, ...fragmentation],
    fragmentation,
    highRiskModules: moduleFindings.filter((finding) => finding.severity === "high"),
    moduleFindings,
    modules,
    summary: {
      files: modules.length,
      fragmentClusters: fragmentation.length,
      highRiskModules: moduleFindings.filter((finding) => finding.severity === "high").length,
      reviewModules: moduleFindings.filter((finding) => finding.severity === "review").length,
      totalLoc: modules.reduce((total, module) => total + module.loc, 0),
    },
  };
}
