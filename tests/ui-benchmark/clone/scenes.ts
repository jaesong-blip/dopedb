export const referenceCloneSceneIds = [
  "first-run",
  "data-editor",
  "query-console",
  "assistant-open",
] as const;

export type ReferenceCloneSceneId = (typeof referenceCloneSceneIds)[number];

export interface ReferenceCloneScene {
  id: ReferenceCloneSceneId;
  eyebrow: string;
  title: string;
  context: string;
  activeObject?: string;
}

export const referenceCloneScenes: Record<
  ReferenceCloneSceneId,
  ReferenceCloneScene
> = {
  "first-run": {
    id: "first-run",
    eyebrow: "START",
    title: "Choose where to begin",
    context: "Recent workspaces stay within reach.",
  },
  "data-editor": {
    id: "data-editor",
    eyebrow: "DATA",
    title: "orders",
    context: "analytics / public",
    activeObject: "orders",
  },
  "query-console": {
    id: "query-console",
    eyebrow: "QUERY",
    title: "Revenue review",
    context: "analytics / read-only",
    activeObject: "revenue.sql",
  },
  "assistant-open": {
    id: "assistant-open",
    eyebrow: "REVIEW",
    title: "Operation scope",
    context: "analytics / exact statement",
    activeObject: "orders",
  },
};

export function isReferenceCloneSceneId(
  value: string | null,
): value is ReferenceCloneSceneId {
  return referenceCloneSceneIds.includes(value as ReferenceCloneSceneId);
}
