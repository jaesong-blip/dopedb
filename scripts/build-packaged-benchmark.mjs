import { spawnSync } from "node:child_process";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

runPnpm(["build:sidecars"]);
runPnpm(["build"], {
  VITE_DOPEDB_PACKAGED_BENCHMARK: "1",
});

function runPnpm(args, extraEnvironment = {}) {
  if (platform() === "win32") {
    run(process.env.ComSpec ?? "cmd.exe", [
      "/d",
      "/s",
      "/c",
      "pnpm",
      ...args,
    ], extraEnvironment);
    return;
  }
  run("pnpm", args, extraEnvironment);
}

function run(command, args, extraEnvironment = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...extraEnvironment },
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
  }
}
