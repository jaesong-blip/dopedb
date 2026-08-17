import { randomUUID } from "node:crypto";

import { expect } from "vitest";

import type { ProviderImportPostgresHarness } from "./fixture";

export async function runPersonalKnowledgeScenarios(
  fixture: ProviderImportPostgresHarness,
) {
  const personalScope = await import("../knowledge/personal-scope");
  const workspaceId = personalScope.personalKnowledgeOrganizationId(fixture.userId);
  const projectId = randomUUID();
  const environmentId = randomUUID();
  const authority = await personalScope.ensurePersonalKnowledgeScope({
    userId: fixture.userId,
    sessionId: fixture.sessionId,
    projects: [{
      id: projectId,
      name: "Personal harness",
      revision: 1,
      environments: [{
        id: environmentId,
        name: "Development",
        riskClass: "development",
        revision: 1,
      }],
    }],
  });
  expect(authority.workspaceId).toBe(workspaceId);
  expect(authority.memberId).toMatch(/^[0-9a-f-]{36}$/);

  const projection = await fixture.sql<{
    projects: number;
    environments: number;
  }[]>`
    SELECT
      (SELECT count(*)::int FROM "workspace_control"."knowledge_project"
       WHERE "organization_id" = ${workspaceId}) AS "projects",
      (SELECT count(*)::int FROM "workspace_control"."knowledge_project_environment"
       WHERE "organization_id" = ${workspaceId}) AS "environments"
  `;
  expect(projection[0]).toEqual({ projects: 1, environments: 1 });
}
