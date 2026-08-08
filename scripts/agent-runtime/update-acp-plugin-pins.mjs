import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const repository = resolve(import.meta.dirname, "../..");
const catalogPath = join(repository, "agent-runtime/plugins/catalog.json");
const packagePath = join(repository, "agent-runtime/plugins/package.json");
const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
const pins = JSON.parse(await readFile(packagePath, "utf8"));

for (const plugin of catalog.plugins) {
  const latest = JSON.parse(await capture("npm", ["view", plugin.npmPackage, "version", "--json"]));
  if (typeof latest !== "string" || !/^\d+\.\d+\.\d+$/.test(latest)) {
    throw new Error(`npm returned an invalid version for ${plugin.npmPackage}`);
  }
  if (latest === plugin.adapterVersion) continue;
  const repositoryName = new URL(plugin.upstreamRepository).pathname.slice(1);
  const response = await fetch(`https://api.github.com/repos/${repositoryName}/commits/v${latest}`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "dopedb-acp-pin-bot" },
  });
  if (!response.ok) throw new Error(`GitHub rejected ${repositoryName} v${latest}: ${response.status}`);
  const commit = await response.json();
  if (typeof commit.sha !== "string" || !/^[0-9a-f]{40}$/.test(commit.sha)) {
    throw new Error(`GitHub returned an invalid commit for ${repositoryName} v${latest}`);
  }
  plugin.adapterVersion = latest;
  plugin.adapterBundleVersion = latest;
  plugin.upstreamTag = `v${latest}`;
  plugin.upstreamCommit = commit.sha;
  pins.dependencies[plugin.npmPackage] = latest;
}

await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
await writeFile(packagePath, `${JSON.stringify(pins, null, 2)}\n`);

function capture(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd: repository, stdio: ["ignore", "pipe", "inherit"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.on("error", rejectPromise);
    child.on("exit", (code) => code === 0 ? resolvePromise(output) : rejectPromise(new Error(`${command} exited ${code}`)));
  });
}
