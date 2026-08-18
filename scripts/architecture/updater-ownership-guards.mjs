const updatesScreenPath = "src/screens/Settings/Updates/index.tsx";
const updaterControllerPath = "src/features/updater/controller.ts";
const updaterHookPath = "src/features/updater/useAppUpdater.ts";

export function collectUpdaterOwnershipDiagnostics({ exists, read, relative, walk }) {
  const required = [updatesScreenPath, updaterControllerPath, updaterHookPath];
  const diagnostics = required
    .filter((filePath) => !exists(filePath))
    .map((filePath) => `required updater ownership file is missing: ${filePath}`);
  if (diagnostics.length > 0) return diagnostics;

  const screen = read(updatesScreenPath);
  if (/\buse(?:State|Effect|Ref)\b/.test(screen)) {
    diagnostics.push(`${updatesScreenPath}: updater lifecycle state must remain app-owned`);
  }
  if (/@tauri-apps\/(?:plugin-updater|plugin-process)/.test(screen)) {
    diagnostics.push(`${updatesScreenPath}: updater commands must remain behind the app controller`);
  }

  const downloadOwners = walk("src")
    .map(relative)
    .filter((filePath) => /\.(?:ts|tsx)$/.test(filePath))
    .filter((filePath) => read(filePath).includes(".downloadAndInstall("));
  if (
    downloadOwners.length !== 1 ||
    downloadOwners[0] !== updaterControllerPath
  ) {
    diagnostics.push(
      `updater downloadAndInstall must have one app-lifetime owner (${downloadOwners.join(", ") || "none"})`,
    );
  }

  const controller = read(updaterControllerPath);
  if (!controller.includes("if (this.installing) return this.installing;")) {
    diagnostics.push(`${updaterControllerPath}: updater install must remain single-flight`);
  }
  if (!controller.includes("this.activeInstallResource = resource;")) {
    diagnostics.push(`${updaterControllerPath}: updater resource lifetime must track the active install`);
  }

  return diagnostics;
}
