import type {
  KnowledgeEnvironment,
  KnowledgeEnvironmentView,
  KnowledgeProject,
} from "../knowledge/domain";

export type ProjectEnvironmentResource<T> = {
  environment: KnowledgeEnvironment;
  resource: T;
};

export function projectResourceKey(
  projectId: string,
  view: Extract<KnowledgeEnvironmentView, "databases" | "sources" | "analyses">,
) {
  return `${projectId}:${view}`;
}

export function preferredProjectEnvironment(
  project: KnowledgeProject,
  activeEnvironmentId: string | null,
) {
  return (
    project.environments.find(
      (environment) => environment.id === activeEnvironmentId,
    ) ??
    project.environments[0] ??
    null
  );
}

export function flattenProjectEnvironmentResources<T>(
  project: KnowledgeProject,
  resourcesForEnvironment: (environmentId: string) => readonly T[],
): ProjectEnvironmentResource<T>[] {
  return project.environments.flatMap((environment) =>
    resourcesForEnvironment(environment.id).map((resource) => ({
      environment,
      resource,
    })),
  );
}
