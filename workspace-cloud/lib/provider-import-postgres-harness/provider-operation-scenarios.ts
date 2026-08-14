import { randomUUID } from "node:crypto";

import { expect } from "vitest";

import type { AuthorityProviderScenarioResult } from "./authority-provider-scenarios";
import type { ProviderImportPostgresHarness } from "./fixture";

export async function runProviderOperationScenarios(
  fixture: ProviderImportPostgresHarness,
  provider: AuthorityProviderScenarioResult,
) {
  const {
    authority,
    integrationId,
    memberId,
    organizationId,
    otherOrganizationId,
    resourceId,
    sessionId,
    sql,
    userId,
  } = fixture;
  const { imported: left } = provider;

  const previousCredentialKey = process.env.WORKSPACE_CREDENTIAL_KEY;
  process.env.WORKSPACE_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString("base64url");
  try {
    const [{ canonicalHash }, { providerOperationOwnershipMarker }, switchPlanModule,
      { providerImportProjection }, { completeNeonBranchSwitch }] = await Promise.all([
      import("../workspace-versioning"),
      import("../provider-operation-marker"),
      import("../providers/neon-branch-switch-plan"),
      import("../providers/import-projection"),
      import("../provider-operation-store"),
    ]);
    const sourceResource = {
      project: "harness-project",
      branch: "harness-branch",
      databaseId: "123456789",
      database: "app",
      engine: "postgres" as const,
      schemas: ["public"],
    };
    const targetResource = {
      ...sourceResource,
      branch: "harness-target",
      databaseId: "987654321",
    };
    const sourceProjection = providerImportProjection("neon", sourceResource, {
      production: false,
      writeAvailable: true,
    });
    const targetProjection = providerImportProjection("neon", targetResource, {
      production: false,
      writeAvailable: true,
    });
    const operationId = randomUUID();
    const operationClaimId = randomUUID();
    const connectionClaimId = randomUUID();
    const plannedAt = new Date();
    const inventory = {
      projectId: sourceResource.project,
      rootIds: [sourceResource.branch],
      branches: [
        {
          id: sourceResource.branch,
          projectId: sourceResource.project,
          parentId: null,
          treeParentId: null,
          name: "Harness source",
          currentState: "ready" as const,
          pendingState: null,
          stateChangedAt: plannedAt.toISOString(),
          createdAt: plannedAt.toISOString(),
          updatedAt: plannedAt.toISOString(),
          creationSource: "primary",
          initSource: "parent-data" as const,
          sourceLsn: null,
          sourceTimestamp: null,
          default: true,
          protected: false,
          expiresAt: null,
          restrictedActions: [],
          production: false as const,
          ready: true,
          depth: 0,
        },
        {
          id: targetResource.branch,
          projectId: targetResource.project,
          parentId: sourceResource.branch,
          treeParentId: sourceResource.branch,
          name: "Harness target",
          currentState: "ready" as const,
          pendingState: null,
          stateChangedAt: plannedAt.toISOString(),
          createdAt: plannedAt.toISOString(),
          updatedAt: plannedAt.toISOString(),
          creationSource: "branch",
          initSource: "parent-data" as const,
          sourceLsn: null,
          sourceTimestamp: null,
          default: false,
          protected: false,
          expiresAt: null,
          restrictedActions: [],
          production: false as const,
          ready: true,
          depth: 1,
        },
      ],
    };
    const plan = switchPlanModule.buildNeonBranchSwitchPlan({
      request: switchPlanModule.parseNeonBranchSwitchPlanRequest({
        idempotencyKey: randomUUID(),
        projectId: sourceResource.project,
        connectionId: left.connection.id,
        targetBranchId: targetResource.branch,
        targetEnvironment: "development",
      }),
      inventory,
      connection: {
        connectionId: left.connection.id,
        connectionName: left.connection.name,
        providerResourceId: resourceId,
        projectId: sourceResource.project,
        sourceBranchId: sourceResource.branch,
        databaseId: sourceResource.databaseId,
        database: sourceResource.database,
        schemas: sourceResource.schemas,
        environment: "development",
        readonlyDefault: left.connection.readonlyDefault,
        allowWrites: left.connection.allowWrites,
        schemaGroup: left.connection.schemaGroup,
        contentRevision: 1,
        authorityRevision: 1,
        activeLeaseCount: 0,
      },
      target: {
        branch: inventory.branches[1],
        databaseId: targetResource.databaseId,
        database: targetResource.database,
        endpointId: "ep-harness-target",
        databaseFingerprint: "e".repeat(64),
        resourceFingerprint: targetProjection.fingerprint,
        managedAccessOperationId: null,
      },
      operationId,
      integrationId,
      integrationGeneration: 2n,
      now: plannedAt,
    });
    const planHash = canonicalHash(plan);
    const ownershipMarker = providerOperationOwnershipMarker({
      organizationId,
      integrationId,
      integrationGeneration: 2n,
      operationId,
      planHash,
    });
    await sql.begin(async (tx) => {
      await tx`
        UPDATE "workspace_control"."workspace_provider_resource"
        SET "resource_fingerprint" = ${sourceProjection.fingerprint},
            "resource" = ${JSON.stringify(sourceProjection.resource)}::jsonb,
            "redacted_metadata" = ${JSON.stringify(sourceProjection.metadata)}::jsonb,
            "capability_manifest" = ${JSON.stringify(sourceProjection.capabilities)}::jsonb
        WHERE "organization_id" = ${organizationId}
          AND "id" = ${resourceId}::uuid
      `;
      await tx`
        UPDATE "workspace_control"."workspace_connection"
        SET "provider_resource" = ${JSON.stringify(sourceProjection.resource)}::jsonb,
            "environment" = 'development',
            "revision" = 2,
            "revocation_pending_at" = ${plannedAt.toISOString()}::timestamptz,
            "revocation_claimed_at" = ${plannedAt.toISOString()}::timestamptz,
            "revocation_claim_id" = ${connectionClaimId}::uuid
        WHERE "organization_id" = ${organizationId}
          AND "id" = ${left.connection.id}::uuid
      `;
      await tx`
        INSERT INTO "workspace_control"."workspace_provider_operation"
          ("id", "organization_id", "integration_id", "provider",
           "integration_generation", "kind", "state", "idempotency_key",
           "request_hash", "plan_hash", "plan_expires_at", "risk",
           "approval_policy", "requested_by_member_id", "requested_by_user_id",
           "requested_by_session_id", "requested_by_role", "resource_scope",
           "source_resource_id", "target_name", "ownership_marker",
           "redacted_plan", "claim_id", "claimed_at", "remote_started_at",
           "created_at", "updated_at")
        VALUES
          (${operationId}::uuid, ${organizationId}, ${integrationId}::uuid, 'neon',
           2, 'neon.branch.switch', 'remote_started', ${randomUUID()}::uuid,
           ${"a".repeat(64)}, ${planHash}, ${plan.expiresAt}, 'standard',
           'single_admin', ${memberId}, ${userId}, ${sessionId}, 'admin',
           ${sourceResource.project}, ${sourceResource.branch}, ${plan.target.name},
           ${ownershipMarker}, ${JSON.stringify(plan)}::jsonb, ${operationClaimId}::uuid,
           ${plannedAt.toISOString()}::timestamptz,
           ${plannedAt.toISOString()}::timestamptz,
           ${plannedAt.toISOString()}::timestamptz,
           ${plannedAt.toISOString()}::timestamptz)
      `;
    });
    const switchPreflight = await sql<{
      operationReady: boolean;
      authorityReady: boolean;
      connectionReady: boolean;
      parentReady: boolean;
      grantReady: boolean;
      leasesEmpty: boolean;
    }[]>`
      SELECT
        EXISTS (
          SELECT 1 FROM "workspace_control"."workspace_provider_operation" operation
          WHERE operation."id" = ${operationId}::uuid
            AND operation."organization_id" = ${organizationId}
            AND operation."integration_id" = ${integrationId}::uuid
            AND operation."integration_generation" = 2
            AND operation."state" = 'remote_started'
            AND operation."claim_id" = ${operationClaimId}::uuid
            AND operation."plan_hash" = ${planHash}
            AND operation."ownership_marker" = ${ownershipMarker}
            AND operation."redacted_plan" = ${JSON.stringify(plan)}::jsonb
        ) AS "operationReady",
        EXISTS (
          SELECT 1
          FROM "workspace_control"."session" live_session
          JOIN "workspace_control"."member" live_member
            ON live_member."id" = ${memberId}
           AND live_member."organization_id" = ${organizationId}
           AND live_member."user_id" = ${userId}
          JOIN "workspace_control"."workspace_provider_integration" integration
            ON integration."id" = ${integrationId}::uuid
           AND integration."organization_id" = ${organizationId}
           AND integration."provider" = 'neon'
           AND integration."generation" = 2
           AND integration."revocation_claim_id" IS NULL
          WHERE live_session."id" = ${sessionId}
            AND live_session."user_id" = ${userId}
            AND live_session."expires_at" > now()
            AND live_member."role" = 'admin'
            AND live_member."revocation_pending_at" IS NULL
            AND live_member."revocation_claim_id" IS NULL
        ) AS "authorityReady",
        EXISTS (
          SELECT 1
          FROM "workspace_control"."workspace_connection" connection
          JOIN "workspace_control"."workspace_provider_resource" source_resource
            ON source_resource."organization_id" = connection."organization_id"
           AND source_resource."id" = connection."provider_resource_id"
           AND source_resource."resource" = connection."provider_resource"
          WHERE connection."id" = ${left.connection.id}::uuid
            AND connection."organization_id" = ${organizationId}
            AND connection."provider_resource_id" = ${resourceId}::uuid
            AND connection."provider_resource"->>'project' = ${sourceResource.project}
            AND connection."provider_resource"->>'branch' = ${sourceResource.branch}
            AND connection."provider_resource"->>'databaseId' = ${sourceResource.databaseId}
            AND connection."provider_resource"->>'database' = ${sourceResource.database}
            AND connection."name" = ${left.connection.name}
            AND connection."readonly_default" = ${left.connection.readonlyDefault}
            AND connection."allow_writes" = ${left.connection.allowWrites}
            AND connection."schema_group" IS NOT DISTINCT FROM ${left.connection.schemaGroup}
            AND connection."environment" = 'development'
            AND connection."content_revision" = 1
            AND connection."revision" = 2
            AND connection."revocation_pending_at" IS NOT NULL
            AND connection."revocation_claim_id" = ${connectionClaimId}::uuid
            AND connection."deleted_at" IS NULL
        ) AS "connectionReady",
        EXISTS (
          SELECT 1 FROM "workspace_control"."workspace_resource_version" version
          WHERE version."organization_id" = ${organizationId}
            AND version."resource_type" = 'connection'
            AND version."resource_id" = ${left.connection.id}::uuid
            AND version."branch" = 'main'
            AND version."revision" = 1
        ) AS "parentReady",
        EXISTS (
          SELECT 1 FROM "workspace_control"."workspace_connection_grant" grant_row
          WHERE grant_row."organization_id" = ${organizationId}
            AND grant_row."connection_id" = ${left.connection.id}::uuid
            AND grant_row."member_id" = ${memberId}
            AND grant_row."capability" = 'manage'
        ) AS "grantReady",
        NOT EXISTS (
          SELECT 1 FROM "workspace_control"."workspace_credential_lease" lease
          WHERE lease."organization_id" = ${organizationId}
            AND lease."connection_id" = ${left.connection.id}::uuid
            AND lease."revoked_at" IS NULL
        ) AS "leasesEmpty"
    `;
    expect(switchPreflight[0]).toEqual({
      operationReady: true,
      authorityReady: true,
      connectionReady: true,
      parentReady: true,
      grantReady: true,
      leasesEmpty: true,
    });
    let completion;
    try {
      completion = await completeNeonBranchSwitch({
        authority: { organizationId, ...authority },
        integrationId,
        integrationGeneration: 2n,
        operationId,
        kind: "neon.branch.switch",
        planHash,
        ownershipMarker,
        claimId: operationClaimId,
        connectionClaimId,
        plan,
        targetProjection,
        now: new Date(plannedAt.valueOf() + 1_000),
      });
    } catch (error) {
      const cause = error && typeof error === "object"
        ? (error as { cause?: unknown }).cause
        : null;
      const causeMessage = cause && typeof cause === "object"
        && typeof (cause as { message?: unknown }).message === "string"
        ? (cause as { message: string }).message
        : null;
      const errorMessage = error && typeof error === "object"
        && typeof (error as { message?: unknown }).message === "string"
        ? (error as { message: string }).message
        : null;
      const message = causeMessage
        ?? (errorMessage && !errorMessage.startsWith("Failed query:")
          ? errorMessage
          : "Neon branch switch SQL failed");
      throw new Error(message);
    }
    expect(completion).toMatchObject({
      operationId,
      connectionId: left.connection.id,
      contentRevision: 2,
      authorityRevision: 2,
      targetBranchId: targetResource.branch,
    });
    const switched = await sql<{
      branchId: string;
      databaseId: string;
      contentRevision: number;
      authorityRevision: number;
      pending: boolean;
      operationState: string;
      versions: number;
      switchAudits: number;
    }[]>`
      SELECT connection."provider_resource"->>'branch' AS "branchId",
        connection."provider_resource"->>'databaseId' AS "databaseId",
        connection."content_revision"::int AS "contentRevision",
        connection."revision"::int AS "authorityRevision",
        connection."revocation_pending_at" IS NOT NULL AS "pending",
        operation."state" AS "operationState",
        (SELECT count(*)::int
         FROM "workspace_control"."workspace_resource_version" version
         WHERE version."organization_id" = connection."organization_id"
           AND version."resource_type" = 'connection'
           AND version."resource_id" = connection."id") AS "versions",
        (SELECT count(*)::int
         FROM "workspace_control"."workspace_audit_event" event
         WHERE event."organization_id" = connection."organization_id"
           AND event."action" IN (
             'connection.provider_target.switch', 'provider.operation.succeeded'
           )) AS "switchAudits"
      FROM "workspace_control"."workspace_connection" connection
      JOIN "workspace_control"."workspace_provider_operation" operation
        ON operation."organization_id" = connection."organization_id"
       AND operation."id" = ${operationId}::uuid
      WHERE connection."organization_id" = ${organizationId}
        AND connection."id" = ${left.connection.id}::uuid
    `;
    expect(switched[0]).toEqual({
      branchId: targetResource.branch,
      databaseId: targetResource.databaseId,
      contentRevision: 2,
      authorityRevision: 2,
      pending: false,
      operationState: "succeeded",
      versions: 2,
      switchAudits: 2,
    });
  } finally {
    if (previousCredentialKey === undefined) {
      delete process.env.WORKSPACE_CREDENTIAL_KEY;
    } else {
      process.env.WORKSPACE_CREDENTIAL_KEY = previousCredentialKey;
    }
  }

  const [versionStore, versionContract] = await Promise.all([
    import("../workspace-versioning-store"),
    import("../workspace-versioning"),
  ]);
  const currentRows = await sql<{
    name: string;
    engine: "postgres";
    provider: "neon";
    driverId: string | null;
    host: string;
    port: number;
    database: string;
    sslmode: string;
    readonlyDefault: boolean;
    allowWrites: boolean;
    env: string | null;
    schemaGroup: string | null;
    contentRevision: number;
  }[]>`
    SELECT "name", "engine", "provider", "driver_id" AS "driverId",
      "host", "port", "database_name" AS "database", "sslmode",
      "readonly_default" AS "readonlyDefault", "allow_writes" AS "allowWrites",
      "environment" AS "env", "schema_group" AS "schemaGroup",
      "content_revision"::int AS "contentRevision"
    FROM "workspace_control"."workspace_connection"
    WHERE "organization_id" = ${organizationId}
      AND "id" = ${left.connection.id}::uuid
  `;
  const currentConnection = currentRows[0];
  if (!currentConnection || currentConnection.contentRevision !== 2) {
    throw new Error("Conflict harness requires the switched connection revision");
  }
  const { contentRevision: _contentRevision, ...currentTemplate } = currentConnection;
  const keptCandidate = versionContract.connectionVersionPayload({
    ...currentTemplate,
    name: "Harness stale candidate",
  });
  const keptConflictId = await versionStore.conflictConnectionCandidate({
    organizationId,
    connectionId: left.connection.id,
    expectedRevision: 1,
    payload: keptCandidate,
    authority,
  });
  const openKept = await versionStore.listConnectionConflicts({
    organizationId,
    membershipId: memberId,
  });
  expect(openKept).toHaveLength(1);
  expect(openKept[0]).toMatchObject({
    id: keptConflictId,
    connectionId: left.connection.id,
    currentMatchesServer: true,
    currentMatchesCandidate: false,
    current: { revision: 2 },
    server: { revision: 2 },
    candidate: { revision: 1, payload: { name: "Harness stale candidate" } },
  });
  await expect(versionStore.listConnectionConflicts({
    organizationId: otherOrganizationId,
    membershipId: memberId,
  })).resolves.toEqual([]);
  await expect(versionStore.resolveConnectionConflict({
    organizationId,
    conflictId: keptConflictId,
    resolution: "server",
    authority,
  })).resolves.toEqual({ resolution: "server", created: true });
  await expect(versionStore.resolveConnectionConflict({
    organizationId,
    conflictId: keptConflictId,
    resolution: "server",
    authority,
  })).resolves.toEqual({ resolution: "server", created: false });

  const appliedCandidate = versionContract.connectionVersionPayload({
    ...currentTemplate,
    name: "Harness applied candidate",
  });
  const appliedConflictId = await versionStore.conflictConnectionCandidate({
    organizationId,
    connectionId: left.connection.id,
    expectedRevision: 1,
    payload: appliedCandidate,
    authority,
  });
  const appliedHash = versionContract.canonicalHash(appliedCandidate);
  await sql.begin(async (tx) => {
    await tx`
      UPDATE "workspace_control"."workspace_connection"
      SET "name" = ${appliedCandidate.name}, "content_revision" = 3,
          "updated_at" = now()
      WHERE "organization_id" = ${organizationId}
        AND "id" = ${left.connection.id}::uuid
        AND "content_revision" = 2
    `;
    await tx`
      INSERT INTO "workspace_control"."workspace_resource_version"
        ("organization_id", "resource_type", "resource_id", "revision",
         "base_revision", "parent_version_id", "branch", "operation",
         "payload", "payload_hash", "created_by_user_id")
      SELECT ${organizationId}, 'connection', ${left.connection.id}::uuid, 3, 2,
        parent."id", 'main', 'update', ${JSON.stringify(appliedCandidate)}::jsonb,
        ${appliedHash}, ${userId}
      FROM "workspace_control"."workspace_resource_version" parent
      WHERE parent."organization_id" = ${organizationId}
        AND parent."resource_type" = 'connection'
        AND parent."resource_id" = ${left.connection.id}::uuid
        AND parent."branch" = 'main' AND parent."revision" = 2
    `;
  });
  await expect(versionStore.resolveConnectionConflict({
    organizationId,
    conflictId: appliedConflictId,
    resolution: "candidate",
    authority,
  })).resolves.toEqual({ resolution: "candidate", created: true });
  await expect(versionStore.resolveConnectionConflict({
    organizationId,
    conflictId: appliedConflictId,
    resolution: "server",
    authority,
  })).resolves.toEqual({ resolution: "candidate", created: false });

  const deleteCandidate = versionContract.connectionVersionPayload({
    ...currentTemplate,
    name: "Harness applied candidate",
  }, true);
  const deleteConflictId = await versionStore.conflictConnectionCandidate({
    organizationId,
    connectionId: left.connection.id,
    expectedRevision: 2,
    payload: deleteCandidate,
    authority,
    operation: "delete",
  });
  const deleteHash = versionContract.canonicalHash(deleteCandidate);
  await sql.begin(async (tx) => {
    await tx`
      UPDATE "workspace_control"."workspace_connection"
      SET "deleted_at" = now(), "content_revision" = 4, "updated_at" = now()
      WHERE "organization_id" = ${organizationId}
        AND "id" = ${left.connection.id}::uuid
        AND "content_revision" = 3
    `;
    await tx`
      INSERT INTO "workspace_control"."workspace_resource_version"
        ("organization_id", "resource_type", "resource_id", "revision",
         "base_revision", "parent_version_id", "branch", "operation",
         "payload", "payload_hash", "created_by_user_id")
      SELECT ${organizationId}, 'connection', ${left.connection.id}::uuid, 4, 3,
        parent."id", 'main', 'delete', ${JSON.stringify(deleteCandidate)}::jsonb,
        ${deleteHash}, ${userId}
      FROM "workspace_control"."workspace_resource_version" parent
      WHERE parent."organization_id" = ${organizationId}
        AND parent."resource_type" = 'connection'
        AND parent."resource_id" = ${left.connection.id}::uuid
        AND parent."branch" = 'main' AND parent."revision" = 3
    `;
  });
  const deleteReview = await versionStore.listConnectionConflicts({
    organizationId,
    membershipId: memberId,
  });
  expect(deleteReview).toHaveLength(1);
  expect(deleteReview[0]).toMatchObject({
    id: deleteConflictId,
    currentMatchesCandidate: true,
    current: { revision: 4, operation: "delete" },
    candidate: { operation: "delete", payload: { deleted: true } },
  });
  await expect(versionStore.resolveConnectionConflict({
    organizationId,
    conflictId: deleteConflictId,
    resolution: "candidate",
    authority,
  })).resolves.toEqual({ resolution: "candidate", created: true });
  await expect(versionStore.listConnectionConflicts({
    organizationId,
    membershipId: memberId,
  })).resolves.toEqual([]);
  await expect(sql`
    UPDATE "workspace_control"."workspace_resource_conflict_resolution"
    SET "resolution" = 'dismissed'
    WHERE "organization_id" = ${organizationId}
      AND "conflict_id" = ${appliedConflictId}::uuid
  `).rejects.toThrow(/append-only/);

}
