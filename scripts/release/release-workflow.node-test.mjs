// Guards the immutable boundary: the complete draft closure is verified before
// the sole publish PATCH, then the tag-specific anonymous closure is verified.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const POSITIVE_DATABASE_ID = /^[1-9][0-9]*$/;
const DISALLOWED_JOB_PROPERTIES = new Set(["continue-on-error", "if"]);
const EXPECTED_RELEASE_WORKFLOW_SHA256 = "882c11684a2f69018ba52b31bc18dab460598267079082f4dc9f9e97b9ef31cd";
const EXPECTED_RELEASE_JOB_IDS = Object.freeze(["verify-release", "publish-tauri", "finalize-release"]);
const EXPECTED_RELEASE_JOB_PROPERTIES = Object.freeze({
  "verify-release": ["runs-on", "timeout-minutes", "permissions", "steps"],
  "publish-tauri": ["needs", "permissions", "timeout-minutes", "environment", "strategy", "runs-on", "steps"],
  "finalize-release": ["needs", "runs-on", "timeout-minutes", "permissions", "steps"],
});
const EXPECTED_RELEASE_JOB_NEEDS = Object.freeze({
  "verify-release": undefined,
  "publish-tauri": "verify-release",
  "finalize-release": "publish-tauri",
});
const REQUIRED_VERIFY_RELEASE_VERSION_GUARDS = Object.freeze([
  "node scripts/release/verify-release-version.mjs \"$tag_version\"",
]);
// The four readable step bodies below document the finalizer's command-level
// contract. These audited normalized job hashes additionally lock every setup
// action, use/with/env mapping, comment, blank line, and unnamed sibling.
const EXPECTED_CRITICAL_JOB_SHA256 = Object.freeze({
  "publish-tauri": "3ed24ce86d33b80516a6752e2b5dc33f371a874ed43ccfabf8018d0594b6c8e7",
  "finalize-release": "b78a3589ea50574229254787aea3edde87b1ded55f0fa918d452c4079a78f864",
});
const EXPECTED_CRITICAL_JOB_STEP_INVENTORIES = Object.freeze({
  "publish-tauri": [
    "uses:actions/checkout@v7",
    "Setup pnpm",
    "Setup Node.js",
    "Install Rust",
    "Rust cache",
    "Install frontend dependencies",
    "Build and upload Tauri release",
    "Upload stable direct-download asset",
  ],
  "finalize-release": [
    "uses:actions/checkout@v7",
    "Setup Node.js",
    "Install isolated Rust updater verifier",
    "Finalize public updater URLs",
    "Verify complete draft updater closure",
    "Publish the verified immutable release as latest",
    "Verify anonymous tag-specific public updater downloads",
  ],
});

const STEP_NAMES = Object.freeze({
  finalize: "Finalize public updater URLs",
  draftClosure: "Verify complete draft updater closure",
  publish: "Publish the verified immutable release as latest",
  publicClosure: "Verify anonymous tag-specific public updater downloads",
});

const EXPECTED_STEP_BODIES = Object.freeze({
  [STEP_NAMES.finalize]: [
    "        env:",
    "          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
    "        run: |",
    "          set -euo pipefail",
    "",
    "          mkdir -p release-finalize",
    "          gh release download \"$GITHUB_REF_NAME\" \\",
    "            --repo \"$GITHUB_REPOSITORY\" \\",
    "            --pattern latest.json \\",
    "            --dir release-finalize",
    "          gh release view \"$GITHUB_REF_NAME\" \\",
    "            --repo \"$GITHUB_REPOSITORY\" \\",
    "            --json assets > release-finalize/assets.json",
    "",
    "          node scripts/release/finalize-updater-json.mjs \\",
    "            --manifest release-finalize/latest.json \\",
    "            --assets release-finalize/assets.json \\",
    "            --repository \"$GITHUB_REPOSITORY\" \\",
    "            --tag \"$GITHUB_REF_NAME\"",
    "",
    "          gh release upload \"$GITHUB_REF_NAME\" \\",
    "            --repo \"$GITHUB_REPOSITORY\" \\",
    "            release-finalize/latest.json \\",
    "            --clobber",
    "",
    "          # Clobbering latest.json changes its asset size and digest. GitHub's",
    "          # draft asset metadata can lag the upload, so retry only that exact",
    "          # stale-metadata condition; every closure/schema failure stops now.",
    "          node scripts/release/wait-for-finalized-latest.mjs \\",
    "            --manifest release-finalize/latest.json \\",
    "            --assets release-finalize/assets.json \\",
    "            --repository \"$GITHUB_REPOSITORY\" \\",
    "            --tag \"$GITHUB_REF_NAME\"",
    "",
    "",
  ].join("\n"),
  [STEP_NAMES.draftClosure]: [
    "        env:",
    "          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
    "        run: |",
    "          set -euo pipefail",
    "",
    "          version=\"${GITHUB_REF_NAME#app-v}\"",
    "          mkdir -p release-finalize/draft-assets",
    "          for asset in \\",
    "            \"DopeDB_${version}_aarch64.app.tar.gz\" \\",
    "            \"DopeDB_${version}_aarch64.app.tar.gz.sig\" \\",
    "            \"DopeDB_${version}_x64.app.tar.gz\" \\",
    "            \"DopeDB_${version}_x64.app.tar.gz.sig\" \\",
    "            \"DopeDB_${version}_x64-setup.exe\" \\",
    "            \"DopeDB_${version}_x64-setup.exe.sig\"; do",
    "            gh release download \"$GITHUB_REF_NAME\" \\",
    "              --repo \"$GITHUB_REPOSITORY\" \\",
    "              --pattern \"$asset\" \\",
    "              --dir release-finalize/draft-assets",
    "          done",
    "",
    "          node scripts/release/finalize-updater-json.mjs \\",
    "            --manifest release-finalize/latest.json \\",
    "            --assets release-finalize/assets.json \\",
    "            --repository \"$GITHUB_REPOSITORY\" \\",
    "            --tag \"$GITHUB_REF_NAME\" \\",
    "            --check",
    "",
    "          cargo run --locked -p release-updater-verify -- \\",
    "            --manifest release-finalize/latest.json \\",
    "            --assets release-finalize/assets.json \\",
    "            --downloads release-finalize/draft-assets \\",
    "            --repository \"$GITHUB_REPOSITORY\" \\",
    "            --root \"$GITHUB_WORKSPACE\" \\",
    "            --tag \"$GITHUB_REF_NAME\"",
    "",
    "      # GitHub immutable published releases can change only title and notes,",
    "      # so public verification cannot precede the sole publish PATCH. All",
    "      # draft closure, digest, and independent Minisign gates above run first;",
    "      # the draft leaves the previous latest intact until this one REST",
    "      # operation atomically publishes and selects the new latest release.",
    "",
  ].join("\n"),
  [STEP_NAMES.publish]: [
    "        env:",
    "          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
    "        run: |",
    "          set -euo pipefail",
    "          # `id` is GitHub's GraphQL node ID (for example RE_kw...), whereas",
    "          # the REST PATCH endpoint requires the numeric `databaseId`.",
    "          release_id=\"$(gh release view \"$GITHUB_REF_NAME\" --repo \"$GITHUB_REPOSITORY\" --json databaseId --jq .databaseId)\"",
    "          if [[ ! \"$release_id\" =~ ^[1-9][0-9]*$ ]]; then",
    "            echo \"Release databaseId is missing or invalid.\" >&2",
    "            exit 1",
    "          fi",
    "          gh api --method PATCH \"repos/$GITHUB_REPOSITORY/releases/$release_id\" \\",
    "            -F draft=false \\",
    "            -f make_latest=true \\",
    "            --silent",
    "",
    "",
  ].join("\n"),
  [STEP_NAMES.publicClosure]: [
    "        run: |",
    "          set -euo pipefail",
    "",
    "          node scripts/release/download-public-updater-assets.mjs \\",
    "            --latest-url \"https://github.com/$GITHUB_REPOSITORY/releases/download/$GITHUB_REF_NAME/latest.json\" \\",
    "            --assets release-finalize/assets.json \\",
    "            --output release-finalize/public-assets \\",
    "            --repository \"$GITHUB_REPOSITORY\" \\",
    "            --tag \"$GITHUB_REF_NAME\"",
    "",
    "          cargo run --locked -p release-updater-verify -- \\",
    "            --manifest release-finalize/public-assets/latest.json \\",
    "            --assets release-finalize/assets.json \\",
    "            --downloads release-finalize/public-assets \\",
    "            --repository \"$GITHUB_REPOSITORY\" \\",
    "            --root \"$GITHUB_WORKSPACE\" \\",
    "            --tag \"$GITHUB_REF_NAME\"",
    "",
  ].join("\n"),
});

function fail(message) {
  throw new Error(message);
}

function normalizeYamlBody(body) {
  return body.replace(/\r\n?/g, "\n");
}

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

function scanLines(source) {
  const lines = [];
  let start = 0;
  while (start < source.length) {
    const newline = source.indexOf("\n", start);
    const end = newline === -1 ? source.length : newline + 1;
    lines.push({
      start,
      end,
      text: source.slice(start, newline === -1 ? source.length : newline),
    });
    start = end;
  }
  return lines;
}

function findBoundary(lines, start, predicate) {
  for (let index = start; index < lines.length; index += 1) {
    if (predicate(lines[index].text)) {
      return lines[index].start;
    }
  }
  return lines.at(-1)?.end ?? 0;
}

function extractNamedSteps(workflow) {
  const source = workflow;
  const steps = new Map();
  const lines = scanLines(source);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const match = /^ {6}- name: ([^\n]+)$/.exec(line.text);
    if (!match) {
      continue;
    }
    const [, name] = match;
    const bodyStart = line.end;
    // A comment at six spaces is not a YAML sibling. Keep it (and any following
    // eight-space property) in this exact step contract until a real list item.
    const end = findBoundary(lines, lineIndex + 1, (candidate) => /^ {6}- /.test(candidate));
    const entries = steps.get(name) ?? [];
    entries.push({
      body: source.slice(bodyStart, end),
      bodyStart,
      end,
      index: line.start,
    });
    steps.set(name, entries);
  }
  return steps;
}

function extractJobs(workflow) {
  const source = workflow;
  const lines = scanLines(source);
  const jobsStart = lines.findIndex((line) => line.text === "jobs:");
  if (jobsStart === -1) {
    fail("release workflow must declare jobs");
  }
  const jobs = new Map();
  for (let lineIndex = jobsStart + 1; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (/^\S/.test(line.text)) {
      break;
    }
    if (!/^ {2}\S/.test(line.text) || /^ {2}#/.test(line.text)) {
      continue;
    }
    const match = /^ {2}([A-Za-z0-9_-]+):$/.exec(line.text);
    if (!match) {
      fail("release workflow contains a non-canonical top-level job key");
    }
    const [, name] = match;
    if (jobs.has(name)) {
      fail(`duplicate release job: ${name}`);
    }
    const bodyStart = line.end;
    const end = findBoundary(lines, lineIndex + 1, (candidate) => /^ {2}[A-Za-z0-9_-]+:$/.test(candidate) || /^\S/.test(candidate));
    jobs.set(name, {
      body: source.slice(bodyStart, end),
      bodyStart,
      end,
      index: line.start,
    });
  }
  return jobs;
}

function jobStepInventory(jobBody) {
  const steps = [];
  for (const line of scanLines(jobBody)) {
    const named = /^ {6}- name: (.+)$/.exec(line.text);
    if (named) {
      steps.push(named[1]);
      continue;
    }
    const uses = /^ {6}- uses: (.+)$/.exec(line.text);
    if (uses) {
      steps.push(`uses:${uses[1]}`);
    }
  }
  return steps;
}

function assertJobGuards(workflow) {
  const jobs = extractJobs(workflow);
  if (JSON.stringify([...jobs.keys()]) !== JSON.stringify(EXPECTED_RELEASE_JOB_IDS)) {
    fail("release workflow job IDs differ from the audited sole-publish DAG");
  }
  for (const [name, job] of jobs) {
    const properties = [];
    const expected = EXPECTED_RELEASE_JOB_PROPERTIES[name];
    let needs;
    for (const line of scanLines(job.body)) {
      if (!/^ {4}\S/.test(line.text) || /^ {4}#/.test(line.text)) {
        continue;
      }
      // Critical jobs deliberately admit only the audited, one-line plain-key
      // mapping form. This rejects YAML's explicit `?`/`:` entries as well as
      // quoted, escaped, tagged, folded, and literal semantic bypass keys.
      const match = /^ {4}([A-Za-z][A-Za-z0-9-]*):(?:[ \t].*)?$/.exec(line.text);
      if (!match) {
        if (expected) {
          fail(`${name} contains a non-canonical direct YAML mapping`);
        }
        continue;
      }
      const key = match[1];
      properties.push(key);
      if (key === "needs") {
        needs = line.text.slice(line.text.indexOf(":") + 1).trim();
      }
      if (DISALLOWED_JOB_PROPERTIES.has(key)) {
        fail(`${name} cannot set job-level ${key}`);
      }
    }
    if (expected && JSON.stringify(properties) !== JSON.stringify(expected)) {
      fail(`${name} differs from its audited job-level contract`);
    }
    if (needs !== EXPECTED_RELEASE_JOB_NEEDS[name]) {
      fail(`${name} differs from its audited sole-publish dependency`);
    }
    const expectedHash = EXPECTED_CRITICAL_JOB_SHA256[name];
    if (expectedHash && sha256(job.body) !== expectedHash) {
      fail(`${name} differs from its audited complete job contract`);
    }
    const expectedSteps = EXPECTED_CRITICAL_JOB_STEP_INVENTORIES[name];
    if (expectedSteps && JSON.stringify(jobStepInventory(job.body)) !== JSON.stringify(expectedSteps)) {
      fail(`${name} differs from its audited ordered step inventory`);
    }
  }
  for (const name of Object.keys(EXPECTED_RELEASE_JOB_PROPERTIES)) {
    if (!jobs.has(name)) {
      fail(`missing critical release job: ${name}`);
    }
  }
}

function assertVerifyReleaseVersionGuards(workflow) {
  const verifyRelease = extractJobs(workflow).get("verify-release");
  if (!verifyRelease) {
    fail("missing version-verification release job");
  }
  for (const guard of REQUIRED_VERIFY_RELEASE_VERSION_GUARDS) {
    if (!verifyRelease.body.includes(guard)) {
      fail(`verify-release is missing required CLI version guard: ${guard}`);
    }
  }
}

function exactCriticalSteps(workflow) {
  const all = extractNamedSteps(workflow);
  return Object.fromEntries(Object.values(STEP_NAMES).map((name) => {
    const entries = all.get(name) ?? [];
    if (entries.length !== 1) {
      fail(entries.length === 0 ? `missing critical release step: ${name}` : `duplicate critical release step: ${name}`);
    }
    return [name, entries[0]];
  }));
}

function countOccurrences(source, pattern) {
  return [...source.matchAll(pattern)];
}

function belongsTo(step, index) {
  return index >= step.index && index < step.end;
}

export function validateReleaseWorkflow(workflow) {
  // Every offset-bearing parser and scan below receives this one canonical
  // source. Never compare offsets from normalized lines with raw CRLF bytes.
  const source = normalizeYamlBody(workflow);
  const steps = exactCriticalSteps(source);
  const finalize = steps[STEP_NAMES.finalize];
  const closure = steps[STEP_NAMES.draftClosure];
  const publish = steps[STEP_NAMES.publish];
  const publicClosure = steps[STEP_NAMES.publicClosure];

  if (!(finalize.index < closure.index && closure.index < publish.index && publish.index < publicClosure.index)) {
    fail("draft finalization and closure must precede publish, followed by anonymous verification");
  }
  for (const [name, expected] of Object.entries(EXPECTED_STEP_BODIES)) {
    if (normalizeYamlBody(steps[name].body) !== expected) {
      fail(`${name} differs from its audited complete step contract`);
    }
  }
  assertJobGuards(source);
  assertVerifyReleaseVersionGuards(source);

  const apiCalls = countOccurrences(source, /\bgh(?:[ \t\\\r\n]+)api\b/g);
  if (apiCalls.length !== 1 || !belongsTo(publish, apiCalls[0].index)) {
    fail("only the publish step may contain the sole GitHub REST API command");
  }
  if (countOccurrences(source, /\bgh(?:[ \t\\\r\n]+)release(?:[ \t\\\r\n]+)edit\b/g).length !== 0) {
    fail("gh release edit cannot promote an immutable release");
  }
  const latestFields = countOccurrences(source, /\bmake_latest\b/g);
  if (latestFields.length !== 1 || !belongsTo(publish, latestFields[0].index)) {
    fail("make_latest must appear exactly once in the publish contract");
  }
  if (/make_latest=false|--json id --jq \.id/.test(source)) {
    fail("immutable publish cannot demote latest or use a GraphQL node ID");
  }
  if (sha256(source) !== EXPECTED_RELEASE_WORKFLOW_SHA256) {
    fail("release workflow differs from its audited sole-publish contract");
  }
  return true;
}

function mutateCriticalBody(workflow, name, mutate) {
  const source = normalizeYamlBody(workflow);
  const step = exactCriticalSteps(source)[name];
  const body = mutate(step.body);
  return source.slice(0, step.bodyStart) + body + source.slice(step.end);
}

function appendStep(workflow, body) {
  const source = normalizeYamlBody(workflow);
  return `${source}\n      - name: Adversarial release mutation\n        run: |\n          set -euo pipefail\n${body}\n`;
}

function insertBeforeNextSibling(workflow, name, addition) {
  const source = normalizeYamlBody(workflow);
  const step = exactCriticalSteps(source)[name];
  return source.slice(0, step.end) + addition + source.slice(step.end);
}

function insertSiblingBeforeStep(workflow, name, sibling) {
  const source = normalizeYamlBody(workflow);
  const step = exactCriticalSteps(source)[name];
  return source.slice(0, step.index) + sibling + source.slice(step.index);
}

function insertJobProperty(workflow, jobName, property) {
  const source = normalizeYamlBody(workflow);
  const job = extractJobs(source).get(jobName);
  assert.ok(job, `missing job fixture target ${jobName}`);
  return source.slice(0, job.bodyStart) + property + source.slice(job.bodyStart);
}

function mutateJobBody(workflow, jobName, mutate) {
  const source = normalizeYamlBody(workflow);
  const job = extractJobs(source).get(jobName);
  assert.ok(job, `missing job fixture target ${jobName}`);
  return source.slice(0, job.bodyStart) + mutate(job.body) + source.slice(job.end);
}

function insertExplicitJobMapping(workflow, jobName, lines) {
  return insertJobProperty(workflow, jobName, `${lines.join("\n")}\n`);
}

function appendJob(workflow, header, stepLines, named = true) {
  const source = normalizeYamlBody(workflow);
  const step = named
    ? ["      - name: Premature immutable publish", "        run: |", ...stepLines.map((line) => `          ${line}`)]
    : ["      - run: |", ...stepLines.map((line) => `          ${line}`)];
  return `${source}\n${[
    ...header,
    "    needs: publish-tauri",
    "    permissions:",
    "      contents: write",
    "    runs-on: ubuntu-latest",
    "    steps:",
    ...step,
  ].join("\n")}\n`;
}

function removeFinalizerCommand(body) {
  return body.replace([
    "          node scripts/release/finalize-updater-json.mjs \\",
    "            --manifest release-finalize/latest.json \\",
    "            --assets release-finalize/assets.json \\",
    "            --repository \"$GITHUB_REPOSITORY\" \\",
    "            --tag \"$GITHUB_REF_NAME\"",
  ].join("\n"), "          # finalizer intentionally bypassed");
}

function assertActionlintValid(workflow, name) {
  const result = spawnSync("actionlint", ["-"], { input: workflow, encoding: "utf8" });
  if (result.error?.code === "ENOENT") {
    // actionlint is intentionally an external CI tool, not an application
    // dependency; its required repository check still runs independently.
    return;
  }
  assert.equal(result.status, 0, `${name} must remain actionlint-valid: ${result.stderr || result.stdout}`);
}

function withLineEndings(workflow, ending) {
  return normalizeYamlBody(workflow).replace(/\n/g, ending);
}

test("release workflow exactly matches the audited immutable publish contract", async () => {
  const rawWorkflow = await readFile(path.join(root, ".github/workflows/release.yml"), "utf8");
  const workflow = normalizeYamlBody(rawWorkflow);
  assert.equal(validateReleaseWorkflow(rawWorkflow), true, "raw checkout workflow");
  assert.equal(validateReleaseWorkflow(workflow), true);
  for (const invalid of ["", "0", "-1", "1.5", "RE_kwDOAa1b2c3d4e5f"]) {
    assert.equal(POSITIVE_DATABASE_ID.test(invalid), false, `${invalid || "empty"} must not reach REST PATCH`);
  }
  assert.equal(POSITIVE_DATABASE_ID.test("123456789"), true);
});

test("release workflow validation uses one normalized coordinate system", async () => {
  const rawWorkflow = await readFile(path.join(root, ".github/workflows/release.yml"), "utf8");
  const workflow = normalizeYamlBody(rawWorkflow);
  assert.equal(validateReleaseWorkflow(rawWorkflow), true, "raw checkout workflow");
  for (const [name, candidate] of [
    ["LF", workflow],
    ["CRLF", withLineEndings(workflow, "\r\n")],
    ["CR-only", withLineEndings(workflow, "\r")],
  ]) {
    assertActionlintValid(candidate, name);
    assert.equal(validateReleaseWorkflow(candidate), true, name);
  }
  assert.throws(
    () => validateReleaseWorkflow(workflow.replace(/\n/g, "\r\r\n")),
    Error,
    "CRCRLF is malformed and must not be a positive fixture",
  );

  const prematureJob = appendJob(workflow, ["  premature-crlf-curl:"], [
    "curl --request PATCH \"https://api.github.com/repos/$GITHUB_REPOSITORY/releases/1\" --data 'draft=false'",
  ]);
  const verifyReleaseMutation = mutateJobBody(workflow, "verify-release", (body) => body.replace(
    "          git fetch origin main",
    "          gh release edit \"$GITHUB_REF_NAME\" --latest\n\n          git fetch origin main",
  ));
  const criticalStepMutation = mutateCriticalBody(workflow, STEP_NAMES.publish, (body) => body.replace(
    "            --silent",
    "            --silent || true",
  ));
  for (const [name, candidate] of [
    ["CRLF premature job", withLineEndings(prematureJob, "\r\n")],
    ["CRLF verify-release mutation", withLineEndings(verifyReleaseMutation, "\r\n")],
    ["CRLF critical-step mutation", withLineEndings(criticalStepMutation, "\r\n")],
  ]) {
    assertActionlintValid(candidate, name);
    assert.throws(() => validateReleaseWorkflow(candidate), Error, name);
  }
});

test("release workflow validator rejects adversarial command and property mutations", async () => {
  const rawWorkflow = await readFile(path.join(root, ".github/workflows/release.yml"), "utf8");
  const workflow = normalizeYamlBody(rawWorkflow);
  assert.equal(validateReleaseWorkflow(rawWorkflow), true, "raw checkout workflow");
  const mutations = [
    ["release version verifier removal", mutateJobBody(workflow, "verify-release", (body) => body.replace(/^          tag_version=.*\n          node scripts\/release\/verify-release-version\.mjs \"\$tag_version\"\n/m, ""))],
    ["release version verifier bypass", mutateJobBody(workflow, "verify-release", (body) => body.replace("          node scripts/release/verify-release-version.mjs \"$tag_version\"", "          : \"$tag_version\" # version verifier bypassed"))],
    ["exit zero after draft closure", mutateCriticalBody(workflow, STEP_NAMES.draftClosure, (body) => body.replace("\n      # GitHub immutable", "\n          exit 0\n\n      # GitHub immutable"))],
    ["exit zero in public verification", mutateCriticalBody(workflow, STEP_NAMES.publicClosure, (body) => body.replace(/\n$/, "\n          exit 0\n"))],
    ["release id reassignment", mutateCriticalBody(workflow, STEP_NAMES.publish, (body) => body.replace("          gh api", "          release_id=1\n          gh api"))],
    ["commented finalizer", mutateCriticalBody(workflow, STEP_NAMES.finalize, removeFinalizerCommand)],
    ["whitespace continue on error", mutateCriticalBody(workflow, STEP_NAMES.publish, (body) => body.replace("        env:\n", "        continue-on-error : true\n        env:\n"))],
    ["alternate whitespace multiline PATCH", appendStep(workflow, "          gh  api \\\n            -X PATCH \"repos/$GITHUB_REPOSITORY/releases/$release_id\" \\\n            -F draft=false -f \"make_latest=$LATEST\"")],
    ["variableized make latest", mutateCriticalBody(workflow, STEP_NAMES.publish, (body) => body.replace("-f make_latest=true", "-f \"make_latest=$LATEST\""))],
    ["extra promotion step", appendStep(workflow, "          gh release edit \"$GITHUB_REF_NAME\" --latest")],
    ["step conditional", mutateCriticalBody(workflow, STEP_NAMES.publish, (body) => body.replace("        env:\n", "        if: always()\n        env:\n"))],
    ["continue on error", mutateCriticalBody(workflow, STEP_NAMES.publish, (body) => body.replace("        env:\n", "        continue-on-error: true\n        env:\n"))],
    ["ignored shell failure", mutateCriticalBody(workflow, STEP_NAMES.publish, (body) => body.replace("            --silent", "            --silent || true"))],
    ["comment gap false conditional", insertBeforeNextSibling(workflow, STEP_NAMES.draftClosure, "      # a comment does not end the previous step\n        if: github.ref == ''\n")],
    ["comment gap continue on error", insertBeforeNextSibling(workflow, STEP_NAMES.draftClosure, "      # a comment does not end the previous step\n        continue-on-error: true\n")],
    ["job false conditional", insertJobProperty(workflow, "finalize-release", "    if: github.ref == ''\n")],
    ["job continue on error", insertJobProperty(workflow, "publish-tauri", "    continue-on-error : true\n")],
    ["explicit plain if", insertExplicitJobMapping(workflow, "finalize-release", ["    ? if", "    : always()"])],
    ["explicit double quoted if", insertExplicitJobMapping(workflow, "finalize-release", ["    ? \"if\"", "    : always()"])],
    ["explicit single quoted continue on error", insertExplicitJobMapping(workflow, "finalize-release", ["    ? 'continue-on-error'", "    : true"])],
    ["explicit escaped if", insertExplicitJobMapping(workflow, "finalize-release", ["    ? \"\\x69f\"", "    : always()"])],
    ["explicit commented continue on error", insertExplicitJobMapping(workflow, "finalize-release", ["    ? # key continues below", "      continue-on-error", "    : true"])],
    ["explicit tagged if", insertExplicitJobMapping(workflow, "finalize-release", ["    ? !!str if", "    : always()"])],
    ["explicit folded continue on error", insertExplicitJobMapping(workflow, "finalize-release", ["    ? >-", "      continue-on-error", "    : true"])],
    ["explicit literal if", insertExplicitJobMapping(workflow, "finalize-release", ["    ? |-", "      if", "    : always()"])],
    ["early curl PATCH sibling", insertSiblingBeforeStep(workflow, STEP_NAMES.draftClosure, [
      "      - name: Early curl release promotion",
      "        run: |",
      "          set -euo pipefail",
      "          release_id=\"$(gh release view \"$GITHUB_REF_NAME\" --repo \"$GITHUB_REPOSITORY\" --json databaseId --jq .databaseId)\"",
      "          curl --request PATCH \"https://api.github.com/repos/$GITHUB_REPOSITORY/releases/$release_id\" --data 'draft=false'",
      "",
    ].join("\n"))],
    ["unnamed alternate HTTP sibling", appendStep(workflow, [
      "          curl --request PATCH \"https://api.github.com/repos/$GITHUB_REPOSITORY/releases/1\" --data 'draft=false'",
    ].join("\n"))],
    ["premature curl PATCH job", appendJob(workflow, ["  premature-publish:"], [
      "set -euo pipefail",
      "release_id=\"$(gh release view \"$GITHUB_REF_NAME\" --repo \"$GITHUB_REPOSITORY\" --json databaseId --jq .databaseId)\"",
      "curl --request PATCH \"https://api.github.com/repos/$GITHUB_REPOSITORY/releases/$release_id\" --data 'draft=false'",
    ])],
    ["premature gh api job", appendJob(workflow, ["  premature-gh-api:"], [
      "gh api --method PATCH \"repos/$GITHUB_REPOSITORY/releases/1\" -F draft=false",
    ])],
    ["premature gh release job", appendJob(workflow, ["  premature-gh-release:"], [
      "gh release edit \"$GITHUB_REF_NAME\" --latest",
    ])],
    ["premature wget job", appendJob(workflow, ["  premature-wget:"], [
      "wget --method=PATCH --body-data='draft=false' \"https://api.github.com/repos/$GITHUB_REPOSITORY/releases/1\"",
    ])],
    ["premature node job", appendJob(workflow, ["  premature-node:"], [
      "node -e 'fetch(\"https://api.github.com\", { method: \"PATCH\" })'",
    ])],
    ["premature python job", appendJob(workflow, ["  premature-python:"], [
      "python -c 'import urllib.request; urllib.request.urlopen(urllib.request.Request(\"https://api.github.com\", method=\"PATCH\"))'",
    ])],
    ["unnamed extra job", appendJob(workflow, ["  premature-unnamed:"], ["echo harmless"], false)],
    ["quoted extra job", appendJob(workflow, ["  \"premature-quoted\":"], ["echo harmless"])],
    ["explicit extra job", appendJob(workflow, ["  ? premature-explicit", "  :"], ["echo harmless"])],
    ["tagged extra job", appendJob(workflow, ["  ? !!str premature-tagged", "  :"], ["echo harmless"])],
    ["folded extra job", appendJob(workflow, ["  ? >-", "    premature-folded", "  :"], ["echo harmless"])],
    ["literal extra job", appendJob(workflow, ["  ? |-", "    premature-literal", "  :"], ["echo harmless"])],
    ["escaped extra job", appendJob(workflow, ["  ? \"\\x70remature-escaped\"", "  :"], ["echo harmless"])],
    ["altered needs", mutateJobBody(workflow, "finalize-release", (body) => body.replace("    needs: publish-tauri", "    needs: verify-release"))],
    ["altered permissions", mutateJobBody(workflow, "finalize-release", (body) => body.replace("    permissions:\n      contents: write", "    permissions:\n      contents: read"))],
  ];
  for (const [name, candidate] of mutations) {
    assertActionlintValid(candidate, name);
    assert.throws(() => validateReleaseWorkflow(candidate), Error, name);
  }
});
