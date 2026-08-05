// One approval-gated Neon preparation flow: sealed discovery leaf -> preflight
// -> exact plan approval -> apply/verify -> receipt. No SQL or secret crosses it.
import { sql } from "drizzle-orm";

import { db } from "../../../../../../../../lib/db";
import { env } from "../../../../../../../../lib/env";
import {
  isUuid,
  jsonError,
  mutationAllowed,
  privateJson,
} from "../../../../../../../../lib/http";
import {
  activeProviderIntegration,
  discoverProviderResources,
  recordProviderDiscoveryReceipt,
  revalidateProviderDiscoveryAuthority,
  verifiedNeonCredential,
} from "../../../../../../../../lib/provider-integrations";
import {
  openProviderDiscoveryProof,
  sameProviderResourceItem,
} from "../../../../../../../../lib/provider-discovery-proof";
import {
  applyNeonBootstrap,
  inspectNeonBootstrap,
  NeonBootstrapRepairRequiredError,
  type NeonEnvironmentClassification,
} from "../../../../../../../../lib/providers/neon-bootstrap";
import { parseNeonResource } from "../../../../../../../../lib/providers/neon-core";
import { providerImportProjection } from "../../../../../../../../lib/providers/import-projection";
import { ProviderRequestError } from "../../../../../../../../lib/providers/provider-types";
import {
  openNeonBootstrapPlan,
  sealNeonBootstrapPlan,
} from "../../../../../../../../lib/secret-envelope";
import { workspaceAuditEvent } from "../../../../../../../../lib/schema";
import { authorizeWorkspace } from "../../../../../../../../lib/workspace-authorization";
import { workspaceAuditEventId } from "../../../../../../../../lib/workspace-audit-id";

type RouteContext = {
  params: Promise<{ workspaceId: string; integrationId: string }>;
};

const PLAN_VERSION = 1 as const;
const PLAN_TTL_MS = 10 * 60 * 1_000;
const RECEIPT_TTL_MS = 5 * 60 * 1_000;

type PlanPayload = {
  version: typeof PLAN_VERSION;
  organizationId: string;
  integrationId: string;
  integrationGeneration: string;
  memberId: string;
  userId: string;
  sessionId: string;
  resource: unknown;
  environment: NeonEnvironmentClassification | null;
  planHash: string;
  readyHash: string;
  findingCodes: string[];
  issuedAt: number;
  expiresAt: number;
};

function environment(value: unknown): NeonEnvironmentClassification | null | undefined {
  if (value === null || value === "") return null;
  return value === "development" || value === "production" ? value : undefined;
}

async function recordBootstrapAudit(input: {
  kind: string;
  organizationId: string;
  actorUserId: string;
  action: string;
  resourceId: string;
  summary: Record<string, unknown>;
  requestId: string;
}) {
  const id = workspaceAuditEventId(
    `neon-bootstrap:${input.kind}`,
    input.requestId,
  );
  const result = await db.execute<{ id: string }>(sql`
    INSERT INTO ${workspaceAuditEvent} AS existing
      ("id", "organization_id", "actor_user_id", "action", "resource_type",
       "resource_id", "redacted_summary", "request_id")
    VALUES (
      ${id}::uuid, ${input.organizationId}, ${input.actorUserId}, ${input.action},
      'provider_resource', ${input.resourceId},
      ${JSON.stringify(input.summary)}::jsonb, ${input.requestId}::uuid
    )
    ON CONFLICT ("id") DO UPDATE SET "id" = existing."id"
    WHERE existing."organization_id" = EXCLUDED."organization_id"
      AND existing."actor_user_id" = EXCLUDED."actor_user_id"
      AND existing."action" = EXCLUDED."action"
      AND existing."resource_type" = EXCLUDED."resource_type"
      AND existing."resource_id" = EXCLUDED."resource_id"
      AND existing."redacted_summary" = EXCLUDED."redacted_summary"
      AND existing."request_id" = EXCLUDED."request_id"
    RETURNING "id"
  `);
  return result.rows.length === 1;
}

function authorityFor(
  workspaceId: string,
  integrationId: string,
  integration: { provider: string; generation: bigint },
  authorization: {
    membership: { id: string };
    session: { user: { id: string }; session: { id: string } };
    role: string;
  },
) {
  return {
    organizationId: workspaceId,
    integrationId,
    provider: integration.provider,
    integrationGeneration: integration.generation,
    memberId: authorization.membership.id,
    userId: authorization.session.user.id,
    sessionId: authorization.session.session.id,
    role: authorization.role,
  };
}

function parsePlan(
  integrationId: string,
  token: unknown,
  expected: {
    workspaceId: string;
    generation: bigint;
    memberId: string;
    userId: string;
    sessionId: string;
  },
): PlanPayload | null {
  if (typeof token !== "string" || token.length === 0 || token.length > 64 * 1_024) {
    return null;
  }
  try {
    const plan = openNeonBootstrapPlan<PlanPayload>(integrationId, token);
    const fields = [
      "version", "organizationId", "integrationId", "integrationGeneration",
      "memberId", "userId", "sessionId", "resource", "environment", "planHash",
      "readyHash", "findingCodes", "issuedAt", "expiresAt",
    ];
    if (
      !plan
      || typeof plan !== "object"
      || Array.isArray(plan)
      || Object.keys(plan).length !== fields.length
      || fields.some((field) => !Object.hasOwn(plan, field))
      || plan.version !== PLAN_VERSION
      || plan.organizationId !== expected.workspaceId
      || plan.integrationId !== integrationId
      || plan.integrationGeneration !== expected.generation.toString()
      || plan.memberId !== expected.memberId
      || plan.userId !== expected.userId
      || plan.sessionId !== expected.sessionId
      || environment(plan.environment) === undefined
      || typeof plan.planHash !== "string"
      || !/^[0-9a-f]{64}$/.test(plan.planHash)
      || typeof plan.readyHash !== "string"
      || !/^[0-9a-f]{64}$/.test(plan.readyHash)
      || !Array.isArray(plan.findingCodes)
      || plan.findingCodes.length === 0
      || plan.findingCodes.length > 64
      || !plan.findingCodes.every(
        (code) => typeof code === "string" && /^NEON_[A-Z0-9_]{1,96}$/.test(code),
      )
      || !Number.isSafeInteger(plan.issuedAt)
      || !Number.isSafeInteger(plan.expiresAt)
      || plan.issuedAt > Date.now() + 30_000
      || plan.expiresAt <= Date.now()
      || plan.expiresAt <= plan.issuedAt
      || plan.expiresAt - plan.issuedAt > PLAN_TTL_MS
    ) {
      return null;
    }
    parseNeonResource(plan.resource);
    return plan;
  } catch {
    return null;
  }
}

export async function POST(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) {
    return jsonError("Invalid request origin", 403);
  }
  const { workspaceId, integrationId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(integrationId)) {
    return jsonError("Invalid workspace or integration id", 400);
  }
  const authorization = await authorizeWorkspace(request, workspaceId, "manage");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  if (authorization.role !== "admin" && authorization.role !== "owner") {
    return jsonError("Workspace access denied", 403);
  }
  const integration = await activeProviderIntegration(workspaceId, integrationId);
  if (!integration || integration.provider !== "neon") {
    return jsonError("Neon integration not found", 404);
  }
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || Array.isArray(body) || (body.action !== "preflight" && body.action !== "apply")) {
    return jsonError("Invalid Neon bootstrap request", 400);
  }
  const authority = authorityFor(
    workspaceId,
    integrationId,
    integration,
    authorization,
  );
  let repairContext: null | {
    idempotencyKey: string;
    planHash: string;
    findingCodes: string[];
    publicAclApproved: boolean;
    productionApproved: boolean;
  } = null;

  try {
    if (body.action === "preflight") {
      if (
        Object.keys(body).some((key) => !["action", "selectionProof", "environment"].includes(key))
        || typeof body.selectionProof !== "string"
        || body.selectionProof.length === 0
        || body.selectionProof.length > 16 * 1_024
      ) {
        return jsonError("Invalid Neon bootstrap selection", 400);
      }
      const selectedEnvironment = environment(body.environment);
      if (selectedEnvironment === undefined) {
        return jsonError("Invalid Neon environment classification", 400);
      }
      const proof = openProviderDiscoveryProof({
        organizationId: workspaceId,
        integrationId,
        proof: body.selectionProof,
      });
      if (
        !proof
        || proof.provider !== "neon"
        || proof.kind !== "databases"
        || proof.integrationGeneration !== integration.generation
        || proof.memberId !== authorization.membership.id
        || proof.userId !== authorization.session.user.id
        || proof.sessionId !== authorization.session.session.id
      ) {
        return jsonError("Neon selection proof expired or changed", 409);
      }
      const resources = await discoverProviderResources({
        integration,
        kind: proof.kind,
        selection: proof.selection,
      });
      const matching = resources.filter((item) => sameProviderResourceItem(item, proof.item));
      if (matching.length !== 1) {
        return jsonError("Neon database is no longer selectable", 409);
      }
      const resource = parseNeonResource({
        project: proof.selection.project,
        branch: proof.selection.branch,
        databaseId: matching[0].id,
        database: matching[0].value,
        engine: "postgres",
      });
      const credential = await verifiedNeonCredential(integration);
      const inspection = await inspectNeonBootstrap({
        credential,
        resource,
        environment: selectedEnvironment,
      });
      if (!await revalidateProviderDiscoveryAuthority(authority)) {
        return jsonError("Workspace access denied", 403);
      }
      const issuedAt = Date.now();
      const payload: PlanPayload = {
        version: PLAN_VERSION,
        organizationId: workspaceId,
        integrationId,
        integrationGeneration: integration.generation.toString(),
        memberId: authorization.membership.id,
        userId: authorization.session.user.id,
        sessionId: authorization.session.session.id,
        resource: inspection.resource,
        environment: selectedEnvironment,
        planHash: inspection.report.planHash,
        readyHash: inspection.readyHash,
        findingCodes: inspection.report.findings.map((item) => item.code),
        issuedAt,
        expiresAt: issuedAt + PLAN_TTL_MS,
      };
      return privateJson({
        report: inspection.report,
        plan: sealNeonBootstrapPlan(integrationId, payload),
        planExpiresAt: new Date(payload.expiresAt).toISOString(),
      });
    }

    const fields = [
      "action", "plan", "idempotencyKey", "publicAclApproved", "productionApproved",
    ];
    if (
      Object.keys(body).length !== fields.length
      || fields.some((field) => !Object.hasOwn(body, field))
      || typeof body.idempotencyKey !== "string"
      || !isUuid(body.idempotencyKey)
      || typeof body.publicAclApproved !== "boolean"
      || typeof body.productionApproved !== "boolean"
    ) {
      return jsonError("Invalid Neon bootstrap approval", 400);
    }
    const plan = parsePlan(integrationId, body.plan, {
      workspaceId,
      generation: integration.generation,
      memberId: authorization.membership.id,
      userId: authorization.session.user.id,
      sessionId: authorization.session.session.id,
    });
    if (!plan) return jsonError("Neon bootstrap plan expired or changed", 409);
    repairContext = {
      idempotencyKey: body.idempotencyKey,
      planHash: plan.planHash,
      findingCodes: plan.findingCodes,
      publicAclApproved: body.publicAclApproved,
      productionApproved: body.productionApproved,
    };
    const credential = await verifiedNeonCredential(integration);
    const applied = await applyNeonBootstrap({
      credential,
      resource: parseNeonResource(plan.resource),
      environment: plan.environment,
      expectedPlanHash: plan.planHash,
      expectedReadyHash: plan.readyHash,
      publicAclApproved: body.publicAclApproved,
      productionApproved: body.productionApproved,
    });
    if (!await revalidateProviderDiscoveryAuthority(authority)) {
      return jsonError("Workspace access denied", 403);
    }
    const receiptId = crypto.randomUUID();
    const receiptExpiresAt = new Date(Date.now() + RECEIPT_TTL_MS);
    const projection = providerImportProjection("neon", applied.resource, {
      production: applied.report.production,
      writeAvailable: true,
    });
    const receipt = await recordProviderDiscoveryReceipt({
      organizationId: workspaceId,
      integrationId,
      memberId: authorization.membership.id,
      userId: authorization.session.user.id,
      sessionId: authorization.session.session.id,
      role: authorization.role,
      provider: "neon",
      integrationGeneration: integration.generation,
      receiptId,
      expiresAt: receiptExpiresAt,
      projection,
    });
    if (!receipt) return jsonError("Workspace access denied", 403);
    const redactedSummary = {
      provider: "neon",
      providerAuditId: applied.providerAuditId,
      planHash: plan.planHash,
      production: applied.report.production,
      writeAvailable: true,
      productionApproved: body.productionApproved,
      publicAclApproved: body.publicAclApproved,
      findingCodes: plan.findingCodes,
    };
    const audited = await recordBootstrapAudit({
      kind: "success",
      organizationId: workspaceId,
      actorUserId: authorization.session.user.id,
      action: "provider.neon.bootstrap",
      resourceId: projection.fingerprint,
      summary: redactedSummary,
      requestId: body.idempotencyKey,
    });
    if (!audited) {
      return jsonError("Neon bootstrap idempotency key conflicts", 409);
    }
    return privateJson({
      report: applied.report,
      receipt: receipt.id,
      receiptExpiresAt: receipt.expiresAt.toISOString(),
    });
  } catch (error) {
    if (error instanceof NeonBootstrapRepairRequiredError && repairContext) {
      const repairSummary = {
        provider: "neon",
        providerAuditId: error.providerAuditId,
        planHash: repairContext.planHash,
        productionApproved: repairContext.productionApproved,
        publicAclApproved: repairContext.publicAclApproved,
        findingCodes: repairContext.findingCodes,
        repairCode: error.repairCode,
        temporaryRole: error.temporaryRole,
        temporaryObject: error.temporaryObject,
      };
      await recordBootstrapAudit({
        kind: `repair:${error.repairCode}:${error.temporaryRole ?? "policy"}:${
          error.temporaryObject ?? "object"
        }`,
        organizationId: workspaceId,
        actorUserId: authorization.session.user.id,
        action: "provider.neon.bootstrap_needs_repair",
        resourceId: error.providerAuditId,
        summary: repairSummary,
        requestId: repairContext.idempotencyKey,
      }).catch(() => false);
      return jsonError(
        "Neon bootstrap needs manual repair. Review the workspace audit before retrying.",
        503,
      );
    }
    if (error instanceof ProviderRequestError) {
      return jsonError(error.message, error.status);
    }
    return jsonError("Neon bootstrap failed", 502);
  }
}
