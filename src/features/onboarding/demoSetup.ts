// Guided-demo setup composes the existing connection and Project Environment
// commands. It never fabricates team membership, credentials, or Agent authority.
import type { AgentKnowledgeEnvironment } from "../agents/domain";
import { listAgentKnowledgeEnvironments } from "../agents/tauriAdapter";
import type { ConnectionId, ConnectionProfile } from "../connections/domain";
import type {
  CreateKnowledgeEnvironmentInput,
  CreateKnowledgeProjectInput,
  EnvironmentConnection,
  KnowledgeProject,
} from "../knowledge/domain";
import { bindKnowledgeEnvironmentConnectionWithRefresh } from "../knowledge/bindEnvironmentConnection";
import {
  createKnowledgeEnvironment,
  createKnowledgeProject,
  listKnowledgeProjects,
} from "../knowledge/tauriAdapter";

export const GUIDED_DEMO_PROJECT_NAME = "DopeDB Demo";
export const GUIDED_DEMO_ENVIRONMENT_NAME = "Sandbox";

type GuidedDemoGateway = {
  listAgentEnvironments: (
    connectionId: ConnectionId,
  ) => Promise<AgentKnowledgeEnvironment[]>;
  listProjects: () => Promise<KnowledgeProject[]>;
  createProject: (
    input: CreateKnowledgeProjectInput,
  ) => Promise<KnowledgeProject>;
  createEnvironment: (
    input: CreateKnowledgeEnvironmentInput,
  ) => Promise<KnowledgeProject>;
  bindConnection: (input: {
    projectEnvironmentId: string;
    connectionId: string;
    role: string;
    alias: string;
  }) => Promise<EnvironmentConnection>;
};

export type GuidedDemoEnvironmentSetup = {
  environmentId: string;
  createdEnvironmentId: string | null;
  binding: EnvironmentConnection | null;
};

const defaultGateway: GuidedDemoGateway = {
  listAgentEnvironments: listAgentKnowledgeEnvironments,
  listProjects: listKnowledgeProjects,
  createProject: createKnowledgeProject,
  createEnvironment: createKnowledgeEnvironment,
  bindConnection: bindKnowledgeEnvironmentConnectionWithRefresh,
};

export function selectGuidedDemoEnvironment(
  environments: readonly AgentKnowledgeEnvironment[],
): AgentKnowledgeEnvironment | null {
  return environments.find(
    (environment) =>
      environment.projectName === GUIDED_DEMO_PROJECT_NAME &&
      environment.name === GUIDED_DEMO_ENVIRONMENT_NAME,
  ) ?? environments[0] ?? null;
}

export async function ensureGuidedDemoEnvironment(
  connection: ConnectionProfile,
  gateway: GuidedDemoGateway = defaultGateway,
): Promise<GuidedDemoEnvironmentSetup> {
  const alreadyBound = selectGuidedDemoEnvironment(
    await gateway.listAgentEnvironments(connection.id),
  );
  if (alreadyBound) {
    return {
      environmentId: alreadyBound.id,
      createdEnvironmentId: null,
      binding: null,
    };
  }

  const projects = await gateway.listProjects();
  let project = projects.find(
    (candidate) => candidate.name === GUIDED_DEMO_PROJECT_NAME,
  ) ?? null;
  let createdEnvironmentId: string | null = null;

  if (!project) {
    project = await gateway.createProject({
      name: GUIDED_DEMO_PROJECT_NAME,
      environments: [
        {
          name: GUIDED_DEMO_ENVIRONMENT_NAME,
          riskClass: "development",
        },
      ],
    });
    createdEnvironmentId = project.environments[0]?.id ?? null;
  }

  let environment = project.environments.find(
    (candidate) => candidate.name === GUIDED_DEMO_ENVIRONMENT_NAME,
  ) ?? null;
  if (!environment) {
    project = await gateway.createEnvironment({
      projectId: project.id,
      name: GUIDED_DEMO_ENVIRONMENT_NAME,
      riskClass: "development",
    });
    environment = project.environments.find(
      (candidate) => candidate.name === GUIDED_DEMO_ENVIRONMENT_NAME,
    ) ?? null;
    createdEnvironmentId = environment?.id ?? null;
  }
  if (!environment) {
    throw new Error("The guided demo Environment was not created.");
  }

  const binding = await gateway.bindConnection({
    projectEnvironmentId: environment.id,
    connectionId: connection.id,
    role: "primary",
    alias: "commerce",
  });
  return {
    environmentId: environment.id,
    createdEnvironmentId,
    binding,
  };
}
