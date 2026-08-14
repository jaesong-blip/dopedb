import { queryOptions } from "@tanstack/react-query";

import type { KnowledgeSourceSyncProgress } from "./domain";
import { knowledgeQueryKeys } from "./queryKeys";
import { listKnowledgeSourceSyncProgress } from "./tauriAdapter";

const ACTIVE_POLL_MS = 5_000;
const IDLE_POLL_MS = 60_000;

export function knowledgeSyncProgressQuery(
  workspaceScopeKey: string,
  enabled: boolean,
) {
  return queryOptions({
    queryKey: knowledgeQueryKeys.sourceSyncProgress(workspaceScopeKey),
    queryFn: listKnowledgeSourceSyncProgress,
    enabled,
    retry: false,
    refetchInterval: (query) =>
      (query.state.data?.length ?? 0) > 0 ? ACTIVE_POLL_MS : IDLE_POLL_MS,
    refetchIntervalInBackground: true,
  });
}

export function knowledgeSyncRemainingFiles(
  progress: KnowledgeSourceSyncProgress,
) {
  return Math.max(0, progress.totalFiles - progress.completedFiles);
}

export function knowledgeSyncOverallPercent(
  progress: KnowledgeSourceSyncProgress,
): number | null {
  if (progress.totalFiles <= 0) return null;
  const phaseRatio = Math.min(
    1,
    Math.max(0, progress.completedFiles / progress.totalFiles),
  );
  if (progress.phase === "manifest") return phaseRatio * 10;
  if (progress.phase === "indexing") return 10 + phaseRatio * 70;
  return Math.min(99, 80 + phaseRatio * 19);
}
