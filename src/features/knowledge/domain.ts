export type KnowledgeEnvironment = {
  id: string;
  name: string;
  production: boolean;
  revision: number;
};

export type KnowledgeProject = {
  id: string;
  name: string;
  revision: number;
  environments: KnowledgeEnvironment[];
};

export type GithubKnowledgeRepository = {
  installationId: string;
  accountLogin: string;
  id: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  archived: boolean;
};

export type KnowledgeRevision =
  | {
      kind: "github";
      repositoryId: string;
      repository: string;
      refName: string;
      commitSha: string;
    }
  | {
      kind: "local_git";
      rootFingerprint: string;
      gitRootFingerprint: string;
      refName: string;
      commitSha: string;
      dirty: boolean;
      worktree: boolean;
    }
  | {
      kind: "local_snapshot";
      rootFingerprint: string;
      snapshotSha256: string;
    };

export type KnowledgeSource = {
  sourceId: string;
  projectId: string;
  projectName: string;
  projectEnvironmentId: string;
  environmentName: string;
  environmentRevision: number;
  production: boolean;
  provider: "github" | "local_folder";
  displayName: string;
  visibility: "local_only" | "shared_graph";
  revision: KnowledgeRevision;
  health: "ready" | "syncing" | "stale" | "failed" | "revoked";
  localCapabilityAvailable: boolean;
};

export type CreateKnowledgeProjectInput = {
  name: string;
  environments: Array<{ name: string; production: boolean }>;
};

export type GithubKnowledgeSourceInput = {
  projectId: string;
  projectEnvironmentId: string;
  installationId: string;
  repositoryId: string;
  repository: string;
  refName: string;
  displayName: string;
};

export type LocalKnowledgeSourceInput = {
  projectId: string;
  projectEnvironmentId: string;
  displayName: string;
};

export type KnowledgeSyncResult = {
  sourceId: string;
  graphRevisionId: string;
  parsedFiles: number;
  skippedFiles: number;
  changedFiles: string[];
  nodeCount: number;
  edgeCount: number;
};

export type KnowledgeNode = {
  id: string;
  kind: "file" | "module" | "type" | "function" | "route" | "table" | "column" | "migration" | "event" | "funnel" | "dashboard" | "report";
  name: string;
  qualifiedName: string;
  attributes?: Record<string, string>;
};

export type KnowledgeSearchResult = {
  graphRevisionId: string;
  matches: KnowledgeNode[];
};
