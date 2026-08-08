export type KnowledgeEnvironment = {
  id: string;
  name: string;
  riskClass: "production" | "staging" | "development" | "test" | "custom";
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
  riskClass: KnowledgeEnvironment["riskClass"];
  provider: "github" | "local_folder";
  displayName: string;
  visibility: "local_only" | "shared_graph";
  revision: KnowledgeRevision;
  health: "ready" | "syncing" | "stale" | "failed" | "revoked";
  localCapabilityAvailable: boolean;
};

export type CreateKnowledgeProjectInput = {
  name: string;
  environments: Array<{ name: string; riskClass: KnowledgeEnvironment["riskClass"] }>;
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
  graphRevisionIds: string[];
  matches: Array<{
    graphRevisionId: string;
    node: KnowledgeNode;
  }>;
};

export type EnvironmentConnection = {
  id: string;
  projectEnvironmentId: string;
  environmentRevision: number;
  connectionId: string | null;
  remoteConnectionId: string | null;
  connectionRevision: number;
  currentConnectionRevision: number;
  connectionName: string;
  role: string;
  alias: string;
  stale: boolean;
};

export type BindEnvironmentConnectionInput = {
  projectEnvironmentId: string;
  connectionId: string;
  role: string;
  alias: string;
};
