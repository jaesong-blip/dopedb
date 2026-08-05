import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = path.join(repositoryRoot, "workspace-cloud");
const allowedSink = path.join(workspaceRoot, "lib", "workspace-server-log.ts");
const runtimeRoots = [
  path.join(workspaceRoot, "app"),
  path.join(workspaceRoot, "lib"),
];
const directSink = /\bconsole\.(?:log|error|warn|info|debug|trace)\s*\(|\bprocess\.(?:stdout|stderr)\.write\s*\(/g;
const alternateSink = /\b(?:captureException|recordException|addEvent|pino|winston)\s*\(/g;

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(target));
    if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name)) files.push(target);
  }
  return files;
}

const violations = [];
for (const file of (await Promise.all(runtimeRoots.map(sourceFiles))).flat()) {
  const source = await readFile(file, "utf8");
  if (file !== allowedSink && (directSink.test(source) || alternateSink.test(source))) {
    violations.push(path.relative(repositoryRoot, file));
  }
  directSink.lastIndex = 0;
  alternateSink.lastIndex = 0;
}

const sinkSource = await readFile(allowedSink, "utf8");
const sinkCalls = sinkSource.match(/console\.error\(event, fields\);/g) ?? [];
if (sinkCalls.length !== 1) {
  violations.push("workspace-cloud/lib/workspace-server-log.ts: unexpected sink shape");
}
for (const forbidden of [
  "error.message",
  "JSON.stringify(fields)",
  "request.body",
  "response.body",
]) {
  if (sinkSource.includes(forbidden)) {
    violations.push(`workspace-cloud/lib/workspace-server-log.ts: forbidden ${forbidden}`);
  }
}

if (violations.length > 0) {
  throw new Error(
    `workspace server logging boundary violated:\n${[...new Set(violations)].join("\n")}`,
  );
}

console.log("workspace server logging boundary ok: one categorical sink, no direct runtime logs");
