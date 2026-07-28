#!/usr/bin/env node
// UI 검수 하네스 자산 검증. 일상 CI에 넣지 않고 `pnpm ui:harness:validate`로 실행한다.
//
// 검증 범위
//   1. reference manifest 완결성 (제품·버전·platform·scene·해상도·hash·observation)
//   2. repository-audit reference의 sha256을 실제 파일과 대조
//   3. private-reference가 파일 경로를 저장하지 않고 논리 키만 갖는지
//   4. 임시 경로·사용자 홈 경로 유출
//   5. fixture와 문서의 credential 패턴
//   6. rubric schema의 평가 항목 집합
//   7. baseline hash manifest (있을 때만)
//
// scenario ID 중복은 tests/ui-harness/scenarios/index.ts가 import 시점에 throw하고,
// scenario와 reference의 연결은 tsc와 benchmark.harness.ts가 검증한다.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import {
  SCENES,
  assertUniqueSceneSet,
  verifyBaselineInventory,
} from "./lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const benchmarkDir = path.join(root, "tests", "ui-benchmark");

const RUBRIC_CRITERIA = [
  "accessibility",
  "actionLocality",
  "contextContinuity",
  "densityAndAlignment",
  "orientation",
  "workbenchHierarchy",
];

/** fixture와 reference 문서에 절대 들어가면 안 되는 값. */
const CREDENTIAL_PATTERNS = [
  [/postgres(?:ql)?:\/\//i, "실제 PostgreSQL 연결 문자열"],
  [/mongodb(?:\+srv)?:\/\//i, "실제 MongoDB 연결 문자열"],
  [/mysql:\/\//i, "실제 MySQL 연결 문자열"],
  [/\bDATABASE_URL\s*=/i, "연결 URL 환경변수"],
  [/\bPASSWORD\s*=/i, "비밀번호 환경변수"],
  [/\bGOCSPX-/, "Google OAuth client secret"],
  [/\bsk-[A-Za-z0-9]{16,}/, "API secret key"],
  [/\bghp_[A-Za-z0-9]{20,}/, "GitHub personal access token"],
  [/\bAKIA[0-9A-Z]{12,}/, "AWS access key id"],
  [/\bBearer\s+[A-Za-z0-9._-]{20,}/, "bearer token"],
];

/** 임시 경로와 실제 사용자 홈 경로. */
const LEAKED_PATH_PATTERNS = [
  [/\/private\/tmp\//, "임시 경로"],
  [/\/var\/folders\//, "macOS 임시 경로"],
  [/(?:^|[\s"'(])\/tmp\//, "임시 경로"],
  [/\/Users\/[A-Za-z0-9._-]+\//, "실제 사용자 홈 경로"],
  [/C:\\\\?Users\\\\?[A-Za-z0-9._-]+/, "Windows 사용자 홈 경로"],
];

/** example.invalid 밖의 이메일은 실제 주소로 취급한다. */
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const ALLOWED_EMAIL_DOMAIN = "example.invalid";

const failures = [];

function fail(message) {
  failures.push(message);
}

function relative(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function filesBelow(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesBelow(resolved);
    return entry.isFile() ? [resolved] : [];
  });
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function validateManifest() {
  const manifestPath = path.join(benchmarkDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    fail("tests/ui-benchmark/manifest.json is missing");
    return;
  }
  const manifest = readJson(manifestPath);

  if (manifest.schemaVersion !== 1) fail("manifest: unsupported schemaVersion");
  if (manifest.policy?.blocking !== false) {
    fail("manifest: DopeDB benchmark must stay non-blocking (policy.blocking === false)");
  }
  if (!Array.isArray(manifest.references) || manifest.references.length === 0) {
    fail("manifest: at least one reference is required");
    return;
  }

  const seen = new Set();
  for (const reference of manifest.references) {
    const id = reference.id ?? "<missing id>";
    const required = [
      "id",
      "product",
      "version",
      "platform",
      "scenario",
      "resolution",
      "scale",
      "sha256",
      "distribution",
      "redistributable",
      "observations",
    ];
    for (const field of required) {
      if (reference[field] === undefined) fail(`manifest ${id}: missing "${field}"`);
    }
    if (seen.has(id)) fail(`manifest: duplicate reference id "${id}"`);
    seen.add(id);

    if (!/^[0-9a-f]{64}$/.test(String(reference.sha256))) {
      fail(`manifest ${id}: sha256 must be 64 hex characters`);
    }
    const { width, height } = reference.resolution ?? {};
    if (!Number.isInteger(width) || !Number.isInteger(height)) {
      fail(`manifest ${id}: resolution must be integer width and height`);
    }
    if (!Number.isFinite(reference.scale) || reference.scale <= 0) {
      fail(`manifest ${id}: scale must be a positive number`);
    }

    const observation = path.join(benchmarkDir, reference.observations ?? "");
    if (!fs.existsSync(observation)) {
      fail(`manifest ${id}: observation document is missing (${reference.observations})`);
    }

    if (reference.distribution === "repository-audit") {
      if (!reference.file) {
        fail(`manifest ${id}: repository-audit reference must name its committed file`);
        continue;
      }
      const file = path.join(root, reference.file);
      if (!fs.existsSync(file)) {
        fail(`manifest ${id}: referenced file is missing (${reference.file})`);
        continue;
      }
      const actual = sha256(file);
      if (actual !== reference.sha256) {
        fail(`manifest ${id}: sha256 mismatch (recorded ${reference.sha256}, actual ${actual})`);
      }
    } else if (reference.distribution === "private-reference") {
      if (reference.file !== undefined) {
        fail(`manifest ${id}: private reference must not store a file path`);
      }
      if (!reference.logicalKey) {
        fail(`manifest ${id}: private reference needs a logicalKey to locate it`);
      }
    } else {
      fail(`manifest ${id}: unknown distribution "${reference.distribution}"`);
    }
  }
}

function validateRubric() {
  const rubricPath = path.join(benchmarkDir, "rubric.schema.json");
  if (!fs.existsSync(rubricPath)) {
    fail("tests/ui-benchmark/rubric.schema.json is missing");
    return;
  }
  const rubric = readJson(rubricPath);
  const criteria = Object.keys(rubric.properties?.scores?.properties ?? {}).sort();
  if (JSON.stringify(criteria) !== JSON.stringify(RUBRIC_CRITERIA)) {
    fail(`rubric: criteria must be exactly ${RUBRIC_CRITERIA.join(", ")}`);
  }
  if (rubric.properties?.blocking?.const !== false) {
    fail("rubric: scorecard must declare blocking === false");
  }
  const finding = rubric.$defs?.finding?.required ?? [];
  for (const field of ["region", "severity", "evidence", "recommendation"]) {
    if (!finding.includes(field)) {
      fail(`rubric: every finding must require "${field}"`);
    }
  }
}

/** 하네스 소스와 benchmark 문서를 훑어 금지된 값을 찾는다. */
export function scanForbiddenValues(source) {
  const found = [];
  for (const [pattern, label] of [...CREDENTIAL_PATTERNS, ...LEAKED_PATH_PATTERNS]) {
    if (pattern.test(source)) found.push(label);
  }
  for (const email of source.match(EMAIL_PATTERN) ?? []) {
    if (!email.toLowerCase().endsWith(`@${ALLOWED_EMAIL_DOMAIN}`)) {
      found.push(`example.invalid 밖의 이메일 (${email})`);
    }
  }
  return found;
}

function validateSources() {
  const targets = [
    ...filesBelow(path.join(root, "tests", "ui-harness")),
    ...filesBelow(benchmarkDir),
  ].filter((file) => /\.(?:ts|tsx|mjs|json|md|html|css)$/.test(file));

  for (const file of targets) {
    const found = scanForbiddenValues(fs.readFileSync(file, "utf8"));
    for (const label of found) fail(`${relative(file)}: ${label}`);
  }
  return targets.length;
}

async function validateScenariosAndCloneMetrics() {
  const manifest = readJson(path.join(benchmarkDir, "manifest.json"));
  const referenceIds = new Set(manifest.references.map((entry) => entry.id));
  const cloneIds = [
    "first-run",
    "data-editor",
    "query-console",
    "assistant-open",
  ];
  const server = await createServer({
    root,
    configFile: false,
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  try {
    const scenarioModule = await server.ssrLoadModule(
      "/tests/ui-harness/scenarios/index.ts",
    );
    const metricModule = await server.ssrLoadModule(
      "/tests/ui-benchmark/clone/metrics.ts",
    );
    const ids = [...scenarioModule.scenarioIds];
    try {
      assertUniqueSceneSet(ids);
    } catch (error) {
      fail(`scenarios: ${error.message}`);
    }

    for (const [key, scenario] of scenarioModule.scenarios) {
      if (key !== scenario.id) {
        fail(`scenarios: registry key "${key}" does not match id "${scenario.id}"`);
      }
      if (!referenceIds.has(scenario.benchmark.referenceId)) {
        fail(
          `scenario ${scenario.id}: unknown reference "${scenario.benchmark.referenceId}"`,
        );
      }
      if (!cloneIds.includes(scenario.benchmark.referenceCloneScene)) {
        fail(
          `scenario ${scenario.id}: unknown clone "${scenario.benchmark.referenceCloneScene}"`,
        );
      }
      const rubric = [...new Set(scenario.benchmark.rubric)].sort();
      if (JSON.stringify(rubric) !== JSON.stringify(RUBRIC_CRITERIA)) {
        fail(`scenario ${scenario.id}: rubric criteria are incomplete`);
      }
      if (scenario.benchmark.requiredRegions.length === 0) {
        fail(`scenario ${scenario.id}: requiredRegions must not be empty`);
      }
      const commands = [...scenario.expected.commands];
      if (
        commands.length === 0 ||
        JSON.stringify(commands) !==
          JSON.stringify([...new Set(commands)].sort())
      ) {
        fail(`scenario ${scenario.id}: expected commands must be a sorted set`);
      }
    }

    const metrics = metricModule.referenceMetrics;
    for (const clone of cloneIds) {
      if (!metrics[clone] || Object.keys(metrics[clone]).length === 0) {
        fail(`clone ${clone}: metrics are missing`);
        continue;
      }
      for (const [name, metric] of Object.entries(metrics[clone])) {
        if (!Number.isFinite(metric.value)) {
          fail(`clone ${clone}.${name}: value must be finite`);
        }
        if (!/^(?:px|count|ratio)$/.test(metric.unit)) {
          fail(`clone ${clone}.${name}: unsupported unit "${metric.unit}"`);
        }
        if (
          typeof metric.source !== "string" ||
          !metric.source.includes("#")
        ) {
          fail(`clone ${clone}.${name}: observation source needs a section anchor`);
          continue;
        }
        const [sourceFile] = metric.source.split("#");
        if (!fs.existsSync(path.join(benchmarkDir, sourceFile))) {
          fail(`clone ${clone}.${name}: observation source is missing (${sourceFile})`);
        }
      }
    }
  } catch (error) {
    fail(`scenario/clone module validation failed: ${error.message}`);
  } finally {
    await server.close();
  }

  const cloneSourceFiles = filesBelow(path.join(benchmarkDir, "clone")).filter(
    (file) =>
      /\.(?:tsx|html|css)$/.test(file) ||
      /clone\/scenes\.ts$/.test(file),
  );
  for (const file of cloneSourceFiles) {
    const source = fs.readFileSync(file, "utf8");
    if (/\b(?:DopeDB|DopeDB|DopeDB)\b/i.test(source)) {
      fail(`${relative(file)}: clean-room visible source contains product wording`);
    }
    if (
      /(?:from\s+|import\s*\()["'][^"']*(?:\/src\/|\.\.\/\.\.\/src\/)/.test(
        source,
      )
    ) {
      fail(`${relative(file)}: clean-room clone imports production source`);
    }
  }
}

function validateBaselines() {
  const approvalPath = path.join(benchmarkDir, "approvals", "baseline-manifest.json");
  if (!fs.existsSync(approvalPath)) {
    fail("baseline manifest is missing");
    return 0;
  }
  const approvals = readJson(approvalPath);
  if (approvals.schemaVersion !== 1) fail("baseline manifest: unsupported schemaVersion");

  for (const baseline of approvals.baselines ?? []) {
    for (const field of [
      "scene",
      "viewport",
      "sha256",
      "benchmarkReference",
      "file",
      "reason",
      "approvedAt",
    ]) {
      if (!baseline[field]) fail(`baseline ${baseline.scene ?? "?"}: missing "${field}"`);
    }
    const shot = path.join(root, baseline.file ?? "");
    if (!baseline.file || !fs.existsSync(shot)) {
      fail(`baseline ${baseline.scene}: snapshot is missing (${baseline.file})`);
      continue;
    }
    const actual = sha256(shot);
    if (actual !== baseline.sha256) {
      fail(
        `baseline ${baseline.scene}: snapshot hash mismatch — approve it explicitly ` +
          `(recorded ${baseline.sha256}, actual ${actual})`,
      );
    }
  }
  try {
    verifyBaselineInventory({ manifest: approvals, requireAll: true });
  } catch (error) {
    fail(`baseline manifest: ${error.message}`);
  }
  if ((approvals.baselines ?? []).length !== SCENES.length) {
    fail(
      `baseline manifest: expected ${SCENES.length} entries, ` +
        `found ${(approvals.baselines ?? []).length}`,
    );
  }
  return (approvals.baselines ?? []).length;
}

// 스캐너가 실제로 잡는지 자체 검사한다. 가드가 조용히 무력화되는 것을 막는다.
const scannerProbe = scanForbiddenValues(
  'const url = "postgresql://u:p@host/db"; const who = "real.person@gmail.com";',
);
if (scannerProbe.length < 2) {
  throw new Error("ui-harness validator: forbidden-value scanner failed its self-test");
}
if (scanForbiddenValues('const who = "analyst@example.invalid";').length !== 0) {
  throw new Error("ui-harness validator: scanner must allow example.invalid fixtures");
}

validateManifest();
validateRubric();
const scanned = validateSources();
await validateScenariosAndCloneMetrics();
const baselines = validateBaselines();

if (failures.length > 0) {
  console.error("ui harness validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `ui harness validation ok: ${scanned} harness/benchmark files scanned, ` +
    `${baselines} approved baseline(s).`,
);
