#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const label = "dev.dopedb.github-issue-review";
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const workerPath = join(scriptDirectory, "local-issue-review.mjs");
const stateRoot = join(homedir(), "Library", "Application Support", "DopeDB", "issue-review");
const statePath = join(stateRoot, "state.json");
const launchAgentsDirectory = join(homedir(), "Library", "LaunchAgents");
const plistPath = join(launchAgentsDirectory, `${label}.plist`);
const outputPath = join(stateRoot, "worker.log");
const errorPath = join(stateRoot, "worker.error.log");
const domain = `gui/${process.getuid()}`;

function xml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function run(command, args, { allowFailure = false, inherit = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: inherit ? "inherit" : "pipe",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    const detail = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim().slice(-2_000);
    throw new Error(`${command} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function plist() {
  const executablePath = process.execPath;
  const path = process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(executablePath)}</string>
    <string>${xml(workerPath)}</string>
    <string>--once</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(repositoryRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(path)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>ThrottleInterval</key>
  <integer>60</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(outputPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(errorPath)}</string>
</dict>
</plist>
`;
}

async function install() {
  if (process.platform !== "darwin") throw new Error("LaunchAgent installation is supported only on macOS");
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  await mkdir(launchAgentsDirectory, { recursive: true, mode: 0o700 });
  if (!existsSync(statePath)) {
    run(process.execPath, [workerPath, "--initialize"], { inherit: true });
  }
  const temporaryPath = `${plistPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, plist(), { mode: 0o600 });
  await rename(temporaryPath, plistPath);
  run("/bin/launchctl", ["bootout", domain, plistPath], { allowFailure: true });
  run("/bin/launchctl", ["bootstrap", domain, plistPath]);
  run("/bin/launchctl", ["enable", `${domain}/${label}`]);
  run("/bin/launchctl", ["kickstart", "-k", `${domain}/${label}`]);
  process.stdout.write(`Installed ${label}. New or edited issues will be checked within about one minute.\n`);
  process.stdout.write(`Logs: ${outputPath}\nErrors: ${errorPath}\n`);
}

async function uninstall() {
  run("/bin/launchctl", ["bootout", domain, plistPath], { allowFailure: true });
  if (existsSync(plistPath)) {
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    const archivedPath = join(stateRoot, `${label}.${new Date().toISOString().replace(/[:.]/g, "-")}.plist.disabled`);
    await rename(plistPath, archivedPath);
    process.stdout.write(`Disabled LaunchAgent; recoverable plist archived at ${archivedPath}\n`);
  } else {
    process.stdout.write("LaunchAgent was not installed.\n");
  }
}

function status() {
  const result = run("/bin/launchctl", ["print", `${domain}/${label}`], { allowFailure: true });
  if (result.status === 0) process.stdout.write(result.stdout);
  else process.stdout.write("Local issue review LaunchAgent is not loaded.\n");
}

async function main() {
  const action = process.argv[2];
  if (action === "install") await install();
  else if (action === "uninstall") await uninstall();
  else if (action === "status") status();
  else throw new Error("Usage: node scripts/issue-review/launch-agent.mjs <install|uninstall|status>");
}

main().catch((error) => {
  process.stderr.write(`LaunchAgent operation failed: ${error.message}\n`);
  process.exitCode = 1;
});
