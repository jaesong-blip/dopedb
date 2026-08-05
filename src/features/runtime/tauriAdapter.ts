import { invoke } from "@tauri-apps/api/core";

export type StartupStage = {
  name: string;
  classification: "critical" | "post_paint";
  startedMs: number;
  durationMs: number;
  status: "ready" | "failed";
};

export type StartupSummary = {
  elapsedMs: number;
  stages: StartupStage[];
};

export function recordStartupMark(
  mark: "first_shell_commit" | "selected_connection_restored",
  succeeded = true,
): Promise<void> {
  return invoke("record_startup_mark", { mark, succeeded });
}

export function runtimeStartupSummary(): Promise<StartupSummary> {
  return invoke("runtime_startup_summary");
}
