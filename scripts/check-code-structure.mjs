// Provides a full repository audit plus a CI ratchet. The baseline records only
// high-confidence hotspots and coupled fragment clusters; 300 lines remains a
// review prompt rather than a universal pass/fail ceiling.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { analyzeCodeStructure } from "./code-structure/analysis.mjs";
import { collectSourceInventory } from "./code-structure/source-inventory.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = path.join(root, "docs/architecture/code-structure-baseline.json");
const args = new Set(process.argv.slice(2));

function baselineFor(analysis) {
  return {
    version: 1,
    fragmentClusters: Object.fromEntries(analysis.fragmentation.map((finding) => [
      finding.directory,
      {
        candidateFiles: finding.candidateFiles,
        scoreBudget: finding.score,
      },
    ])),
    highRiskModules: Object.fromEntries(analysis.highRiskModules.map((finding) => [
      finding.path,
      {
        lineBudget: finding.loc,
        riskBudget: finding.riskScore,
      },
    ])),
  };
}

function formatSummary(analysis) {
  const { summary } = analysis;
  return [
    `Code structure: ${summary.files} files · ${summary.totalLoc.toLocaleString("en-US")} lines`,
    `  high-risk modules: ${summary.highRiskModules}`,
    `  review modules:    ${summary.reviewModules}`,
    `  fragment clusters: ${summary.fragmentClusters}`,
  ].join("\n");
}

function formatModule(finding) {
  const responsibilities = finding.responsibilities.length > 0
    ? finding.responsibilities.join(", ")
    : "single/unknown";
  return `${finding.path}: ${finding.loc} lines, risk ${finding.riskScore}, ${finding.topLevelDeclarations} declarations [${responsibilities}]`;
}

function printAudit(analysis) {
  console.log(formatSummary(analysis));
  const limit = args.has("--all") ? analysis.moduleFindings.length : 40;
  if (analysis.moduleFindings.length > 0) {
    console.log("\nRanked module review:");
    for (const finding of analysis.moduleFindings.slice(0, limit)) {
      console.log(`  ${finding.severity === "high" ? "HIGH" : "REVIEW"} ${formatModule(finding)}`);
    }
  }
  if (analysis.fragmentation.length > 0) {
    console.log("\nPossible over-fragmentation (human review required):");
    for (const finding of analysis.fragmentation.slice(0, args.has("--all") ? undefined : 20)) {
      console.log(
        `  REVIEW ${finding.directory}: ${finding.candidateFiles.length} tiny modules, ${finding.internalEdges} internal edges, ${finding.externalConsumerCount} external consumers`,
      );
    }
  }
}

function checkBaseline(analysis, baseline) {
  const failures = [];
  const currentModules = new Map(analysis.highRiskModules.map((finding) => [finding.path, finding]));
  const currentClusters = new Map(analysis.fragmentation.map((finding) => [finding.directory, finding]));

  for (const [filePath, finding] of currentModules) {
    const budget = baseline.highRiskModules[filePath];
    if (!budget) {
      failures.push(`${filePath}: new high-risk mixed-responsibility module (${finding.loc} lines, risk ${finding.riskScore})`);
      continue;
    }
    if (finding.loc > budget.lineBudget || finding.riskScore > budget.riskBudget) {
      failures.push(
        `${filePath}: structural risk grew from ${budget.lineBudget} lines/risk ${budget.riskBudget} to ${finding.loc} lines/risk ${finding.riskScore}`,
      );
    }
  }
  for (const filePath of Object.keys(baseline.highRiskModules)) {
    if (!currentModules.has(filePath)) {
      failures.push(`${filePath}: high-risk hotspot improved or moved; regenerate the baseline to keep the ratchet shrinking`);
    }
  }
  for (const [directory, finding] of currentClusters) {
    const budget = baseline.fragmentClusters[directory];
    if (!budget) {
      failures.push(`${directory}: new coupled tiny-module cluster (score ${finding.score})`);
      continue;
    }
    if (finding.score > budget.scoreBudget) {
      failures.push(`${directory}: fragmentation score grew from ${budget.scoreBudget} to ${finding.score}`);
    }
  }
  for (const directory of Object.keys(baseline.fragmentClusters)) {
    if (!currentClusters.has(directory)) {
      failures.push(`${directory}: fragment cluster improved or moved; regenerate the baseline to keep the ratchet shrinking`);
    }
  }
  return failures;
}

function runSelfCheck() {
  const largeMixedSource = [
    'import React, { useState } from "react";',
    'import { invoke } from "@tauri-apps/api/core";',
    "export function Mixed() {",
    "  const [state] = useState(null);",
    '  fetch("/api");',
    "  return <div className=\"x\">{state}</div>;",
    "}",
    ...Array.from({ length: 820 }, (_, index) => `export const value${index} = ${index};`),
  ].join("\n");
  const records = [{
    absolutePath: "/fixture/Mixed.tsx",
    category: "production",
    extension: ".tsx",
    relativePath: "src/Mixed.tsx",
    source: largeMixedSource,
  }];
  const analysis = analyzeCodeStructure(records);
  if (analysis.highRiskModules.length !== 1 || analysis.highRiskModules[0].path !== "src/Mixed.tsx") {
    throw new Error("code-structure self-check failed to identify a large mixed-responsibility module");
  }
}

runSelfCheck();
const analysis = analyzeCodeStructure(collectSourceInventory(root));

if (args.has("--json")) {
  console.log(JSON.stringify(analysis, null, 2));
  process.exit(0);
}
if (args.has("--print-baseline")) {
  console.log(JSON.stringify(baselineFor(analysis), null, 2));
  process.exit(0);
}
if (args.has("--audit")) {
  printAudit(analysis);
  process.exit(0);
}

if (!fs.existsSync(baselinePath)) {
  console.error(`${path.relative(root, baselinePath)} is missing; review --audit output and add --print-baseline output`);
  process.exit(1);
}
const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
const failures = checkBaseline(analysis, baseline);
if (failures.length > 0) {
  console.error("Code-structure ratchet failed:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(formatSummary(analysis));
