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

export type KnowledgeSourceChanged = {
  sourceId: string;
  state: "syncing" | "ready" | "failed";
  errorKind: string | null;
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

export type KnowledgeMapping = {
  id: string;
  projectEnvironmentId: string;
  graphRevisionId: string;
  connectionId: string;
  connectionRevision: number;
  database: string;
  schemaFingerprint: string;
  fromNodeId: string;
  fromNodeName: string;
  targetKind: "table" | "column";
  targetIdentity: string;
  state: "proposed" | "approved" | "rejected" | "stale";
  proposedAt: string;
};

export type FunnelStepDefinition = {
  id: string;
  label: string;
  meaning: string;
  connectionRole: string;
  entityKey: string;
  timestampField: string;
  orderingRule: string;
  mappingState: "inferred" | "confirmed";
  mappingProposalId?: string;
  graphNodeIds: string[];
  evidenceIds: string[];
};

export type FunnelDashboardRecord = {
  id: string;
  connectionId: string;
  revision: number;
  title: string;
  description: string;
  sql: string;
  visualization: {
    version: number;
    kind: "auto" | "metric" | "line" | "bar" | "table";
    xColumn?: string;
    yColumns: string[];
  };
  createdAt: string;
  updatedAt: string;
};

export type FunnelDashboardTile = {
  definition: {
    id: string;
    title: string;
    kind: "metric" | "funnel" | "time_series" | "breakdown" | "table" | "markdown";
    dashboardId?: string;
    expectedDashboardRevision?: number;
    queryRunId?: string;
    composition?: {
      operation: "funnel" | "ratio" | "sum" | "difference";
      inputs: Array<{ tileId: string; label: string; column: string }>;
    };
    stepIds: string[];
    markdown?: string;
  };
  dashboard?: FunnelDashboardRecord;
  connectionRevision?: number;
  availability: "ready" | "missing_grant" | "stale_dashboard" | "error";
  unavailableReason?: string;
};

export type FunnelAnalysisArtifact = {
  id: string;
  projectEnvironmentId: string;
  environmentRevision: number;
  knowledgeGrantId: string;
  publishedFromKnowledgeGrantId?: string;
  graphRevisionIds: string[];
  sourceAgent: "dopedb.acp.claude" | "dopedb.acp.codex";
  title: string;
  question: string;
  purpose: string;
  timezone: string;
  timeRange: string;
  segmentFilters: string[];
  conversionWindowSeconds: number;
  denominatorSemantics: string;
  numeratorSemantics: string;
  deduplicationPolicy: string;
  lateEventPolicy: string;
  steps: FunnelStepDefinition[];
  tiles: FunnelDashboardTile[];
  warnings: string[];
  freshness: "current" | "graph_drift" | "schema_drift" | "partial";
  state: "draft" | "published" | "archived";
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type FunnelAnalysisTileRun = {
  tileId: string;
  queryId?: string;
  status: "ok" | "missing_grant" | "stale" | "error";
  result?: import("../../ipc/types").QueryResult;
  error?: string;
};

export type FunnelAnalysisRun = {
  artifactId: string;
  artifactRevision: number;
  startedAt: string;
  completedAt: string;
  tiles: FunnelAnalysisTileRun[];
};
