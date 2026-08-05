// Drizzle schema for Better Auth and workspace collaboration metadata. Shared
// connection columns intentionally cannot represent target-database credentials.
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const workspaceControl = pgSchema("workspace_control");

export const user = workspaceControl.table("user", {
  id: text("id").default(sql`gen_random_uuid()::text`).primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const organization = workspaceControl.table("organization", {
  id: text("id").default(sql`gen_random_uuid()::text`).primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  metadata: text("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = workspaceControl.table(
  "session",
  {
    id: text("id").default(sql`gen_random_uuid()::text`).primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    activeOrganizationId: text("active_organization_id").references(() => organization.id, {
      onDelete: "set null",
    }),
  },
  (table) => [index("session_user_idx").on(table.userId)],
);

export const account = workspaceControl.table(
  "account",
  {
    id: text("id").default(sql`gen_random_uuid()::text`).primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("account_user_idx").on(table.userId),
    uniqueIndex("account_provider_subject_idx").on(table.providerId, table.accountId),
  ],
);

export const verification = workspaceControl.table(
  "verification",
  {
    id: text("id").default(sql`gen_random_uuid()::text`).primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const member = workspaceControl.table(
  "member",
  {
    id: text("id").default(sql`gen_random_uuid()::text`).primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organization.id, {
      onDelete: "cascade",
    }),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("viewer"),
    revocationPendingAt: timestamp("revocation_pending_at", { withTimezone: true }),
    revocationClaimedAt: timestamp("revocation_claimed_at", { withTimezone: true }),
    revocationClaimId: uuid("revocation_claim_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("member_organization_user_idx").on(table.organizationId, table.userId),
    // Makes a connection grant's tenant/member composite foreign key enforceable.
    uniqueIndex("member_organization_id_idx").on(table.organizationId, table.id),
    index("member_user_idx").on(table.userId),
    check(
      "member_revocation_claim_consistent",
      sql`(${table.revocationClaimedAt} IS NULL AND ${table.revocationClaimId} IS NULL)
        OR (${table.revocationClaimedAt} IS NOT NULL
          AND ${table.revocationClaimId} IS NOT NULL
          AND ${table.revocationPendingAt} IS NOT NULL)`,
    ),
  ],
);

export const invitation = workspaceControl.table(
  "invitation",
  {
    id: text("id").default(sql`gen_random_uuid()::text`).primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organization.id, {
      onDelete: "cascade",
    }),
    email: text("email").notNull(),
    role: text("role"),
    status: text("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    inviterId: text("inviter_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("invitation_organization_idx").on(table.organizationId),
    index("invitation_email_idx").on(table.email),
  ],
);

export const deviceCode = workspaceControl.table(
  "device_code",
  {
    id: text("id").default(sql`gen_random_uuid()::text`).primaryKey(),
    deviceCode: text("device_code").notNull().unique(),
    userCode: text("user_code").notNull().unique(),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    status: text("status").notNull(),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    pollingInterval: integer("polling_interval"),
    clientId: text("client_id"),
    scope: text("scope"),
  },
  (table) => [index("device_code_user_idx").on(table.userId)],
);

export const rateLimit = workspaceControl.table("rate_limit", {
  id: text("id").default(sql`gen_random_uuid()::text`).primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});

export const workspaceProfile = workspaceControl.table("workspace_profile", {
  organizationId: text("organization_id").primaryKey().references(() => organization.id, {
    onDelete: "cascade",
  }),
  lifecycleState: text("lifecycle_state").notNull().default("active"),
  encryptionKeyRef: text("encryption_key_ref").notNull(),
  residencyRegion: text("residency_region"),
  revision: bigint("revision", { mode: "number" }).notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("workspace_profile_revision", sql`${table.revision} >= 1 AND ${table.revision} <= 9007199254740991`),
]);

export const workspaceAuditEvent = workspaceControl.table(
  "workspace_audit_event",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organization.id, {
      onDelete: "cascade",
    }),
    actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id"),
    redactedSummary: jsonb("redacted_summary").notNull().default({}),
    requestId: uuid("request_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("workspace_audit_org_created_idx").on(table.organizationId, table.createdAt)],
);

// Long-lived provider authorization is isolated from connection templates. The
// credential payload is application-encrypted before it reaches this column; public
// serializers never select it.
export const workspaceProviderIntegration = workspaceControl.table(
  "workspace_provider_integration",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organization.id, {
      onDelete: "cascade",
    }),
    provider: text("provider").notNull(),
    status: text("status").notNull().default("active"),
    externalAccountId: text("external_account_id").notNull(),
    displayName: text("display_name").notNull(),
    encryptedCredential: text("encrypted_credential").notNull(),
    credentialExpiresAt: timestamp("credential_expires_at", { withTimezone: true }),
    grantedScope: text("granted_scope"),
    // A redacted, verified GCP project/instance pin for desktop-local WIF.
    // This is deliberately separate from the encrypted provider envelope so
    // read-only local-authority inventory never needs to decrypt a credential.
    localVerificationTarget: jsonb("local_verification_target"),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Stable bigint CAS token. PostgreSQL timestamps cannot be round-tripped
    // through JavaScript Date without losing microseconds.
    generation: bigint("generation", { mode: "bigint" }).notNull().default(sql`1`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revocationPendingAt: timestamp("revocation_pending_at", { withTimezone: true }),
    revocationClaimedAt: timestamp("revocation_claimed_at", { withTimezone: true }),
    revocationClaimId: uuid("revocation_claim_id"),
    refreshClaimedAt: timestamp("refresh_claimed_at", { withTimezone: true }),
    refreshClaimId: uuid("refresh_claim_id"),
    refreshGeneration: bigint("refresh_generation", { mode: "bigint" }),
    // PlanetScale refresh has no provider idempotency/fencing primitive.  A
    // durable remote_started fence therefore intentionally makes the integration
    // non-issuable until an explicit OAuth reconnect supersedes it.
    refreshPhase: text("refresh_phase").notNull().default("idle"),
    refreshRemoteStartedAt: timestamp("refresh_remote_started_at", { withTimezone: true }),
    // Disconnect owns a separate state machine because revocation of a provider
    // grant is externally irreversible even when credential cleanup is retried.
    disconnectPhase: text("disconnect_phase").notNull().default("idle"),
    disconnectGeneration: bigint("disconnect_generation", { mode: "bigint" }),
  },
  (table) => [
    uniqueIndex("provider_integration_org_provider_account_idx").on(
      table.organizationId,
      table.provider,
      table.externalAccountId,
    ),
    uniqueIndex("provider_integration_org_id_idx").on(
      table.organizationId,
      table.id,
    ),
    uniqueIndex("provider_integration_org_id_provider_idx").on(
      table.organizationId,
      table.id,
      table.provider,
    ),
    index("provider_integration_org_status_idx").on(
      table.organizationId,
      table.status,
    ),
    check(
      "provider_integration_revocation_claim_consistent",
      sql`(${table.revocationClaimedAt} IS NULL AND ${table.revocationClaimId} IS NULL)
        OR (${table.revocationClaimedAt} IS NOT NULL
          AND ${table.revocationClaimId} IS NOT NULL
          AND ${table.revocationPendingAt} IS NOT NULL)`,
    ),
    check("provider_integration_generation_positive", sql`${table.generation} >= 1`),
    // Never permit a credential envelope (or arbitrary provider metadata) to
    // masquerade as the desktop-local GCP verification projection. Active,
    // non-revoked GCP rows must have this exact target: otherwise a mixed
    // version deployment could recreate an issuable pre-projection row after
    // 0011 demoted the historical ones. Reconnect/revoked legacy rows remain
    // visible with NULL until an explicit reconnect verifies the target.
    check(
      "provider_integration_local_verification_target_shape",
      sql`(
        ${table.provider} = 'gcpCloudSql' AND (
          (
            ${table.status} = 'active' AND ${table.revokedAt} IS NULL
            AND ${table.localVerificationTarget} IS NOT NULL
            AND jsonb_typeof(${table.localVerificationTarget}) = 'object'
            AND ${table.localVerificationTarget} ?& ARRAY['kind', 'projectId', 'instanceId']
            AND (${table.localVerificationTarget} - 'kind' - 'projectId' - 'instanceId') = '{}'::jsonb
            AND ${table.localVerificationTarget}->>'kind' = 'gcpCloudSql'
            AND ${table.localVerificationTarget}->>'projectId' ~ '^[a-z][a-z0-9-]{4,28}[a-z0-9]$'
            AND ${table.localVerificationTarget}->>'instanceId' ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,97}$'
          )
          OR (
            (${table.status} <> 'active' OR ${table.revokedAt} IS NOT NULL)
            AND (
              ${table.localVerificationTarget} IS NULL OR (
                jsonb_typeof(${table.localVerificationTarget}) = 'object'
                AND ${table.localVerificationTarget} ?& ARRAY['kind', 'projectId', 'instanceId']
                AND (${table.localVerificationTarget} - 'kind' - 'projectId' - 'instanceId') = '{}'::jsonb
                AND ${table.localVerificationTarget}->>'kind' = 'gcpCloudSql'
                AND ${table.localVerificationTarget}->>'projectId' ~ '^[a-z][a-z0-9-]{4,28}[a-z0-9]$'
                AND ${table.localVerificationTarget}->>'instanceId' ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,97}$'
              )
            )
          )
        )
      ) OR (${table.provider} <> 'gcpCloudSql' AND ${table.localVerificationTarget} IS NULL)`,
    ),
    check(
      "provider_integration_refresh_claim_consistent",
      sql`(${table.refreshPhase} = 'idle'
            AND ${table.refreshClaimedAt} IS NULL AND ${table.refreshClaimId} IS NULL
            AND ${table.refreshGeneration} IS NULL AND ${table.refreshRemoteStartedAt} IS NULL)
        OR (${table.refreshPhase} = 'claimed'
            AND ${table.refreshClaimedAt} IS NOT NULL AND ${table.refreshClaimId} IS NOT NULL
            AND ${table.refreshGeneration} IS NOT NULL AND ${table.refreshRemoteStartedAt} IS NULL)
        OR (${table.refreshPhase} = 'remote_started'
            AND ${table.refreshClaimedAt} IS NOT NULL AND ${table.refreshClaimId} IS NOT NULL
            AND ${table.refreshGeneration} IS NOT NULL AND ${table.refreshRemoteStartedAt} IS NOT NULL)
        OR (${table.refreshPhase} = 'reconnect_required'
            AND ${table.refreshClaimedAt} IS NOT NULL AND ${table.refreshClaimId} IS NOT NULL
            AND ${table.refreshGeneration} IS NOT NULL AND ${table.refreshRemoteStartedAt} IS NOT NULL)`,
    ),
    check(
      "provider_integration_disconnect_phase",
      sql`${table.disconnectPhase} IN ('idle', 'claimed', 'lease_cleanup_pending', 'leases_revoked',
          'provider_revoke_started', 'provider_revoke_ambiguous',
          'provider_revoked', 'finalized')`,
    ),
    check(
      "provider_integration_disconnect_generation_consistent",
      sql`(${table.disconnectPhase} = 'idle' AND ${table.disconnectGeneration} IS NULL)
        OR (${table.disconnectPhase} <> 'idle' AND ${table.disconnectGeneration} IS NOT NULL)`,
    ),
  ],
);

// Provider mutations are durable workspace operations, not request-local API
// calls. The plan is redacted and immutable; remote_started is an external-I/O
// fence so an ambiguous response can only enter reconciliation, never blind
// retry. The initial closed kind set expands only with a real adapter.
export const workspaceProviderOperation = workspaceControl.table(
  "workspace_provider_operation",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organization.id, {
      onDelete: "cascade",
    }),
    integrationId: uuid("integration_id").notNull(),
    provider: text("provider").notNull(),
    integrationGeneration: bigint("integration_generation", { mode: "bigint" }).notNull(),
    kind: text("kind").notNull(),
    state: text("state").notNull().default("awaiting_approval"),
    idempotencyKey: uuid("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    planHash: text("plan_hash").notNull(),
    planVersion: integer("plan_version").notNull().default(1),
    planExpiresAt: timestamp("plan_expires_at", { withTimezone: true }).notNull(),
    risk: text("risk").notNull(),
    approvalPolicy: text("approval_policy").notNull(),
    requestedByMemberId: text("requested_by_member_id").notNull(),
    requestedByUserId: text("requested_by_user_id").notNull(),
    requestedBySessionId: text("requested_by_session_id").notNull(),
    requestedByRole: text("requested_by_role").notNull(),
    resourceScope: text("resource_scope").notNull(),
    sourceResourceId: text("source_resource_id").notNull(),
    targetName: text("target_name").notNull(),
    ownershipMarker: text("ownership_marker").notNull(),
    redactedPlan: jsonb("redacted_plan").notNull(),
    providerOperationId: text("provider_operation_id"),
    providerResourceId: text("provider_resource_id"),
    redactedResult: jsonb("redacted_result"),
    failureCode: text("failure_code"),
    claimId: uuid("claim_id"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    remoteStartedAt: timestamp("remote_started_at", { withTimezone: true }),
    reconcileAfter: timestamp("reconcile_after", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("provider_operation_org_id_idx").on(table.organizationId, table.id),
    uniqueIndex("provider_operation_org_idempotency_idx").on(
      table.organizationId,
      table.idempotencyKey,
    ),
    index("provider_operation_org_state_updated_idx").on(
      table.organizationId,
      table.state,
      table.updatedAt,
    ),
    index("provider_operation_integration_state_idx").on(
      table.integrationId,
      table.state,
    ),
    foreignKey({
      columns: [table.organizationId, table.integrationId, table.provider],
      foreignColumns: [
        workspaceProviderIntegration.organizationId,
        workspaceProviderIntegration.id,
        workspaceProviderIntegration.provider,
      ],
      name: "provider_operation_org_integration_fk",
    }).onDelete("cascade"),
    check("provider_operation_provider", sql`${table.provider} = 'neon'`),
    check(
      "provider_operation_kind",
      sql`${table.kind} IN (
        'neon.branch.create', 'neon.branch.delete', 'neon.branch.switch'
      )`,
    ),
    check(
      "provider_operation_state",
      sql`${table.state} IN (
        'awaiting_approval', 'approved', 'claimed', 'remote_started',
        'reconciling', 'succeeded', 'failed', 'needs_repair', 'cancelled'
      )`,
    ),
    check(
      "provider_operation_generation",
      sql`${table.integrationGeneration} >= 1`,
    ),
    check(
      "provider_operation_hashes",
      sql`${table.requestHash} ~ '^[0-9a-f]{64}$'
        AND ${table.planHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check("provider_operation_plan_version", sql`${table.planVersion} = 1`),
    check(
      "provider_operation_risk",
      sql`${table.risk} IN ('standard', 'production_data')`,
    ),
    check(
      "provider_operation_approval_policy",
      sql`${table.approvalPolicy} IN ('single_admin', 'separate_admin')
        AND (${table.risk} <> 'production_data'
          OR ${table.approvalPolicy} = 'separate_admin')`,
    ),
    check(
      "provider_operation_requester_role",
      sql`${table.requestedByRole} IN ('admin', 'owner')`,
    ),
    check(
      "provider_operation_scope_length",
      sql`char_length(${table.resourceScope}) BETWEEN 1 AND 512
        AND char_length(${table.sourceResourceId}) BETWEEN 1 AND 512
        AND char_length(${table.targetName}) BETWEEN 1 AND 256
        AND char_length(${table.ownershipMarker}) BETWEEN 1 AND 256
        AND char_length(${table.requestedByMemberId}) BETWEEN 1 AND 512
        AND char_length(${table.requestedByUserId}) BETWEEN 1 AND 512
        AND char_length(${table.requestedBySessionId}) BETWEEN 1 AND 512`,
    ),
    check(
      "provider_operation_neon_identifiers",
      sql`${table.resourceScope} ~ '^[a-z0-9][a-z0-9-]{0,59}$'
        AND ${table.sourceResourceId} ~ '^[a-z0-9][a-z0-9-]{0,59}$'
        AND ${table.ownershipMarker} ~ '^v1\\.[A-Za-z0-9_-]{43}$'`,
    ),
    check(
      "provider_operation_provider_identifiers",
      sql`${table.providerOperationId} IS NULL
        OR ${table.providerOperationId} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`,
    ),
    check(
      "provider_operation_provider_resource",
      sql`${table.providerResourceId} IS NULL
        OR ${table.providerResourceId} ~ '^[a-z0-9][a-z0-9-]{0,59}$'`,
    ),
    check(
      "provider_operation_failure_code",
      sql`${table.failureCode} IS NULL
        OR ${table.failureCode} ~ '^[A-Z][A-Z0-9_]{0,95}$'`,
    ),
    check(
      "provider_operation_json_shapes",
      sql`jsonb_typeof(${table.redactedPlan}) = 'object'
        AND (${table.redactedResult} IS NULL
          OR jsonb_typeof(${table.redactedResult}) = 'object')`,
    ),
    check(
      "provider_operation_plan_expiry",
      sql`${table.planExpiresAt} > ${table.createdAt}
        AND ${table.planExpiresAt} <= ${table.createdAt} + interval '15 minutes'`,
    ),
    check(
      "provider_operation_claim_consistency",
      sql`(
          ${table.state} IN ('awaiting_approval', 'approved')
          AND ${table.claimId} IS NULL AND ${table.claimedAt} IS NULL
          AND ${table.remoteStartedAt} IS NULL AND ${table.completedAt} IS NULL
        ) OR (
          ${table.state} = 'claimed'
          AND ${table.claimId} IS NOT NULL AND ${table.claimedAt} IS NOT NULL
          AND ${table.remoteStartedAt} IS NULL AND ${table.completedAt} IS NULL
        ) OR (
          ${table.state} IN ('remote_started', 'reconciling')
          AND ${table.claimId} IS NOT NULL AND ${table.claimedAt} IS NOT NULL
          AND ${table.remoteStartedAt} IS NOT NULL AND ${table.completedAt} IS NULL
        ) OR (
          ${table.state} IN ('succeeded', 'failed', 'needs_repair', 'cancelled')
          AND ${table.completedAt} IS NOT NULL
        )`,
    ),
    check(
      "provider_operation_claim_pair",
      sql`(${table.claimId} IS NULL AND ${table.claimedAt} IS NULL)
        OR (${table.claimId} IS NOT NULL AND ${table.claimedAt} IS NOT NULL)`,
    ),
    check(
      "provider_operation_failure_state",
      sql`${table.failureCode} IS NULL
        OR ${table.state} IN ('failed', 'needs_repair')`,
    ),
    check(
      "provider_operation_success_resource",
      sql`${table.state} <> 'succeeded' OR ${table.providerResourceId} IS NOT NULL`,
    ),
  ],
);

// Approval identity remains after a member leaves, while every transition
// rechecks that the same member/session/role is still live. One operation has
// one terminal approval decision; separate_admin rejects requester self-approval.
export const workspaceProviderOperationApproval = workspaceControl.table(
  "workspace_provider_operation_approval",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organization.id, {
      onDelete: "cascade",
    }),
    operationId: uuid("operation_id").notNull(),
    planHash: text("plan_hash").notNull(),
    decision: text("decision").notNull(),
    actorMemberId: text("actor_member_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    actorSessionId: text("actor_session_id").notNull(),
    actorRole: text("actor_role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("provider_operation_approval_org_operation_idx").on(
      table.organizationId,
      table.operationId,
    ),
    foreignKey({
      columns: [table.organizationId, table.operationId],
      foreignColumns: [
        workspaceProviderOperation.organizationId,
        workspaceProviderOperation.id,
      ],
      name: "provider_operation_approval_org_operation_fk",
    }).onDelete("cascade"),
    check(
      "provider_operation_approval_hash",
      sql`${table.planHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "provider_operation_approval_decision",
      sql`${table.decision} IN ('approved', 'rejected')`,
    ),
    check(
      "provider_operation_approval_role",
      sql`${table.actorRole} IN ('admin', 'owner')`,
    ),
  ],
);

// A discovered provider resource is a durable tenant-scoped, non-secret canonical
// fact. Browser import authority is deliberately kept in the separate, single-use
// receipt table below; never put session/member lifetime into this resource.
export const workspaceProviderResource = workspaceControl.table(
  "workspace_provider_resource",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organization.id, {
      onDelete: "cascade",
    }),
    provider: text("provider").notNull(),
    resourceFingerprint: text("resource_fingerprint").notNull(),
    resource: jsonb("resource").notNull(),
    redactedMetadata: jsonb("redacted_metadata").notNull(),
    capabilityManifest: jsonb("capability_manifest").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // PostgreSQL requires this exact non-partial unique target for every tenant
    // composite FK which names a provider resource.
    uniqueIndex("provider_resource_org_id_idx").on(table.organizationId, table.id),
    uniqueIndex("provider_resource_org_provider_fingerprint_idx").on(
      table.organizationId, table.provider, table.resourceFingerprint,
    ),
  ],
);

// Discovery authority is an opaque UUID, not a provider identifier. It is scoped to
// the exact live Better Auth session and member which observed the resource, and is
// consumed by the import CTE in the same statement as the resulting workspace state.
export const workspaceProviderDiscoveryReceipt = workspaceControl.table(
  "workspace_provider_discovery_receipt",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organization.id, {
      onDelete: "cascade",
    }),
    resourceId: uuid("resource_id").notNull(),
    integrationId: uuid("integration_id").notNull(),
    // Receipt consumption must observe the exact integration credential/policy
    // generation that produced the discovery result. This is deliberately not
    // a timestamp because Date cannot preserve PostgreSQL microseconds.
    integrationGeneration: bigint("integration_generation", { mode: "bigint" }).notNull(),
    memberId: text("member_id").notNull(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull().references(() => session.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("provider_discovery_receipt_org_expiry_idx").on(table.organizationId, table.expiresAt),
    foreignKey({
      columns: [table.organizationId, table.resourceId],
      foreignColumns: [workspaceProviderResource.organizationId, workspaceProviderResource.id],
      name: "provider_discovery_receipt_org_resource_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId, table.integrationId],
      foreignColumns: [workspaceProviderIntegration.organizationId, workspaceProviderIntegration.id],
      name: "provider_discovery_receipt_org_integration_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId, table.memberId],
      foreignColumns: [member.organizationId, member.id],
      name: "provider_discovery_receipt_org_member_fk",
    }).onDelete("cascade"),
  ],
);

// GCP service-account ownership is a global, hash-only claim. A principal can
// belong to exactly one integration so concurrent setup cannot reuse it elsewhere.
export const workspaceProviderPrincipalClaim = workspaceControl.table(
  "workspace_provider_principal_claim",
  {
    principalFingerprint: text("principal_fingerprint").primaryKey(),
    organizationId: text("organization_id").notNull().references(
      () => organization.id,
      { onDelete: "cascade" },
    ),
    integrationId: uuid("integration_id").notNull(),
    targetFingerprint: text("target_fingerprint").notNull(),
    accessKind: text("access_kind").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("provider_principal_claim_integration_access_idx").on(
      table.integrationId,
      table.accessKind,
    ),
    uniqueIndex("provider_principal_claim_org_target_idx")
      .on(table.organizationId, table.targetFingerprint)
      .where(sql`"access_kind" = 'read'`),
    index("provider_principal_claim_target_idx").on(table.targetFingerprint),
    foreignKey({
      columns: [table.organizationId, table.integrationId],
      foreignColumns: [
        workspaceProviderIntegration.organizationId,
        workspaceProviderIntegration.id,
      ],
      name: "provider_principal_claim_org_integration_fk",
    }).onDelete("cascade"),
    check(
      "provider_principal_claim_principal_hash",
      sql`${table.principalFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "provider_principal_claim_target_hash",
      sql`${table.targetFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "provider_principal_claim_access_kind",
      sql`${table.accessKind} IN ('read', 'write')`,
    ),
  ],
);

// OAuth state is single-use server data rather than a browser-readable cookie. Only
// a SHA-256 digest is retained, limiting the value of a database disclosure.
export const providerOauthState = workspaceControl.table(
  "provider_oauth_state",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organization.id, {
      onDelete: "cascade",
    }),
    userId: text("user_id").notNull().references(() => user.id, {
      onDelete: "cascade",
    }),
    provider: text("provider").notNull(),
    stateHash: text("state_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("provider_oauth_state_hash_idx").on(table.stateHash),
    index("provider_oauth_state_expiry_idx").on(table.expiresAt),
  ],
);

// A provider setup token exists only long enough to discover and bootstrap one
// cloud target. The OAuth access token is envelope-encrypted and never returned.
export const providerSetupSession = workspaceControl.table(
  "provider_setup_session",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organization.id, {
      onDelete: "cascade",
    }),
    userId: text("user_id").notNull().references(() => user.id, {
      onDelete: "cascade",
    }),
    provider: text("provider").notNull(),
    encryptedCredential: text("encrypted_credential").notNull(),
    accountLabel: text("account_label").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("provider_setup_session_scope_idx").on(
      table.organizationId,
      table.userId,
      table.provider,
    ),
    index("provider_setup_session_expiry_idx").on(table.expiresAt),
    check("provider_setup_session_provider", sql`${table.provider} = 'gcpCloudSql'`),
  ],
);

// Shared connection rows are deliberately templates, not credentials. There is no
// username, password, token, certificate, connection URL, or local secret reference
// column in this table, so those values cannot be uploaded accidentally by the API.
export const workspaceConnection = workspaceControl.table(
  "workspace_connection",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organization.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    engine: text("engine").notNull(),
    provider: text("provider").notNull().default("auto"),
    driverId: text("driver_id"),
    host: text("host").notNull(),
    port: integer("port").notNull(),
    databaseName: text("database_name").notNull(),
    sslmode: text("sslmode").notNull(),
    readonlyDefault: boolean("readonly_default").notNull().default(true),
    allowWrites: boolean("allow_writes").notNull().default(false),
    credentialMode: text("credential_mode").notNull().default("member_local"),
    providerIntegrationId: uuid("provider_integration_id").references(
      () => workspaceProviderIntegration.id,
      { onDelete: "set null" },
    ),
    providerResource: jsonb("provider_resource"),
    providerResourceId: uuid("provider_resource_id"),
    environment: text("environment"),
    schemaGroup: text("schema_group"),
    // Content optimistic-concurrency is separate from the revocation/lease epoch.
    contentRevision: bigint("content_revision", { mode: "number" }).notNull().default(1),
    revision: bigint("revision", { mode: "number" }).notNull().default(1),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    revocationPendingAt: timestamp("revocation_pending_at", { withTimezone: true }),
    revocationClaimedAt: timestamp("revocation_claimed_at", { withTimezone: true }),
    revocationClaimId: uuid("revocation_claim_id"),
  },
  (table) => [
    index("workspace_connection_org_updated_idx").on(
      table.organizationId,
      table.updatedAt,
    ),
    uniqueIndex("workspace_connection_org_id_idx").on(
      table.organizationId,
      table.id,
    ),
    foreignKey({
      columns: [table.organizationId, table.providerIntegrationId],
      foreignColumns: [
        workspaceProviderIntegration.organizationId,
        workspaceProviderIntegration.id,
      ],
      name: "workspace_connection_org_provider_integration_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.providerResourceId],
      foreignColumns: [workspaceProviderResource.organizationId, workspaceProviderResource.id],
      name: "workspace_connection_org_provider_resource_fk",
    }),
    uniqueIndex("workspace_connection_org_provider_resource_idx")
      .on(table.organizationId, table.providerResourceId)
      .where(sql`"provider_resource_id" IS NOT NULL AND "deleted_at" IS NULL`),
    check(
      "workspace_connection_revocation_claim_consistent",
      sql`(${table.revocationClaimedAt} IS NULL AND ${table.revocationClaimId} IS NULL)
        OR (${table.revocationClaimedAt} IS NOT NULL
          AND ${table.revocationClaimId} IS NOT NULL
          AND ${table.revocationPendingAt} IS NOT NULL)`,
    ),
    check("workspace_connection_content_revision", sql`${table.contentRevision} >= 1 AND ${table.contentRevision} <= 9007199254740991`),
    check("workspace_connection_revision", sql`${table.revision} >= 1 AND ${table.revision} <= 9007199254740991`),
    // Member-local templates are secretless and read-only. Managed integrations
    // may carry an administrator write policy, but credentials and provider
    // capability remain outside this row and are rechecked at lease issuance.
    check(
      "workspace_connection_member_local_read_only",
      sql`(${table.credentialMode} = 'member_local' AND ${table.readonlyDefault} = TRUE AND ${table.allowWrites} = FALSE)
        OR ${table.credentialMode} = 'managed'`,
    ),
  ],
);

// Target-database access is an explicit resource grant, never an implication of a
// workspace role. Composite foreign keys keep both the member and template in the
// same tenant even when an otherwise valid UUID is supplied by another workspace.
export const workspaceConnectionGrant = workspaceControl.table(
  "workspace_connection_grant",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull(),
    connectionId: uuid("connection_id").notNull(),
    memberId: text("member_id").notNull(),
    capability: text("capability").notNull().default("view"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("workspace_connection_grant_org_connection_member_idx").on(
      table.organizationId,
      table.connectionId,
      table.memberId,
    ),
    index("workspace_connection_grant_org_member_idx").on(table.organizationId, table.memberId),
    foreignKey({
      columns: [table.organizationId, table.connectionId],
      foreignColumns: [workspaceConnection.organizationId, workspaceConnection.id],
      name: "workspace_connection_grant_org_connection_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId, table.memberId],
      foreignColumns: [member.organizationId, member.id],
      name: "workspace_connection_grant_org_member_fk",
    }).onDelete("cascade"),
    check(
      "workspace_connection_grant_capability",
      sql`${table.capability} IN ('view', 'use', 'manage')`,
    ),
  ],
);

// Shared dashboards contain only a reusable, read-only definition. Query result
// rows, credentials, runtime parameters, and local execution history have no
// column in this projection and therefore cannot enter workspace sync by accident.
export const workspaceDashboard = workspaceControl.table(
  "workspace_dashboard",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organization.id, {
      onDelete: "cascade",
    }),
    connectionId: uuid("connection_id").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    sql: text("sql").notNull(),
    visualization: jsonb("visualization").notNull(),
    state: text("state").notNull().default("draft"),
    // Membership ids are immutable attribution values. They deliberately do not
    // carry a foreign key: member removal must not erase dashboard history, while
    // every live assignment is tenant-checked in the atomic mutation statement.
    ownerMemberId: text("owner_member_id").notNull(),
    updatedByMemberId: text("updated_by_member_id").notNull(),
    revision: bigint("revision", { mode: "number" }).notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("workspace_dashboard_org_id_idx").on(table.organizationId, table.id),
    index("workspace_dashboard_org_updated_idx").on(
      table.organizationId,
      table.updatedAt,
    ),
    index("workspace_dashboard_org_connection_idx").on(
      table.organizationId,
      table.connectionId,
    ),
    foreignKey({
      columns: [table.organizationId, table.connectionId],
      foreignColumns: [workspaceConnection.organizationId, workspaceConnection.id],
      name: "workspace_dashboard_org_connection_fk",
    }).onDelete("cascade"),
    check(
      "workspace_dashboard_title_length",
      sql`char_length(btrim(${table.title})) BETWEEN 1 AND 120`,
    ),
    check(
      "workspace_dashboard_description_length",
      sql`char_length(${table.description}) <= 2000`,
    ),
    check(
      "workspace_dashboard_sql_length",
      sql`octet_length(${table.sql}) BETWEEN 1 AND 100000`,
    ),
    check(
      "workspace_dashboard_state",
      sql`${table.state} IN ('draft', 'published', 'archived')`,
    ),
    check(
      "workspace_dashboard_revision",
      sql`${table.revision} >= 1 AND ${table.revision} <= 9007199254740991`,
    ),
  ],
);

// Revisions are immutable and contain the complete declarative definition needed
// for history and restore. A stale update is materialized as a separate dashboard,
// never as a conflict branch that can silently replace the current definition.
export const workspaceDashboardRevision = workspaceControl.table(
  "workspace_dashboard_revision",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organization.id, {
      onDelete: "cascade",
    }),
    dashboardId: uuid("dashboard_id").notNull(),
    revision: bigint("revision", { mode: "number" }).notNull(),
    baseRevision: bigint("base_revision", { mode: "number" }),
    operation: text("operation").notNull(),
    payload: jsonb("payload").notNull(),
    payloadHash: text("payload_hash").notNull(),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdByMemberId: text("created_by_member_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("workspace_dashboard_revision_org_dashboard_revision_idx").on(
      table.organizationId,
      table.dashboardId,
      table.revision,
    ),
    index("workspace_dashboard_revision_org_dashboard_created_idx").on(
      table.organizationId,
      table.dashboardId,
      table.createdAt,
    ),
    foreignKey({
      columns: [table.organizationId, table.dashboardId],
      foreignColumns: [workspaceDashboard.organizationId, workspaceDashboard.id],
      name: "workspace_dashboard_revision_org_dashboard_fk",
    }).onDelete("cascade"),
    check(
      "workspace_dashboard_revision_number",
      sql`${table.revision} >= 1 AND ${table.revision} <= 9007199254740991`,
    ),
    check(
      "workspace_dashboard_revision_base",
      sql`${table.baseRevision} IS NULL OR (${table.baseRevision} >= 0 AND ${table.baseRevision} <= 9007199254740991)`,
    ),
    check(
      "workspace_dashboard_revision_operation",
      sql`${table.operation} IN ('create', 'update', 'publish', 'archive', 'restore', 'transfer', 'delete', 'conflict_copy')`,
    ),
    check(
      "workspace_dashboard_revision_payload_hash",
      sql`${table.payloadHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

// Evidence-bound reports share only an analysis definition. Claims reference
// append-only evidence rows below; target result rows, local artifact handles,
// credentials, and Agent transcripts have no column in this projection.
export const workspaceReport = workspaceControl.table(
  "workspace_report",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organization.id, {
      onDelete: "cascade",
    }),
    connectionId: uuid("connection_id").notNull(),
    title: text("title").notNull(),
    question: text("question").notNull(),
    conclusion: text("conclusion").notNull(),
    preflightWarnings: jsonb("preflight_warnings").notNull().default([]),
    claims: jsonb("claims").notNull(),
    state: text("state").notNull().default("draft"),
    source: text("source").notNull(),
    // Membership ids remain immutable attribution values after member removal.
    // Live ownership is revalidated inside each atomic mutation statement.
    ownerMemberId: text("owner_member_id").notNull(),
    updatedByMemberId: text("updated_by_member_id").notNull(),
    revision: bigint("revision", { mode: "number" }).notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("workspace_report_org_id_idx").on(table.organizationId, table.id),
    index("workspace_report_org_updated_idx").on(table.organizationId, table.updatedAt),
    index("workspace_report_org_connection_idx").on(table.organizationId, table.connectionId),
    foreignKey({
      columns: [table.organizationId, table.connectionId],
      foreignColumns: [workspaceConnection.organizationId, workspaceConnection.id],
      name: "workspace_report_org_connection_fk",
    }).onDelete("cascade"),
    check(
      "workspace_report_title_length",
      sql`char_length(btrim(${table.title})) BETWEEN 1 AND 120`,
    ),
    check(
      "workspace_report_question_length",
      sql`char_length(btrim(${table.question})) BETWEEN 1 AND 8000`,
    ),
    check(
      "workspace_report_conclusion_length",
      sql`char_length(btrim(${table.conclusion})) BETWEEN 1 AND 20000`,
    ),
    check(
      "workspace_report_warnings_array",
      sql`jsonb_typeof(${table.preflightWarnings}) = 'array'`,
    ),
    check("workspace_report_claims_array", sql`jsonb_typeof(${table.claims}) = 'array'`),
    check(
      "workspace_report_state",
      sql`${table.state} IN ('draft', 'review', 'published', 'archived')`,
    ),
    check(
      "workspace_report_source",
      sql`${table.source} IN ('human', 'agent_proposal')`,
    ),
    check(
      "workspace_report_revision",
      sql`${table.revision} >= 1 AND ${table.revision} <= 9007199254740991`,
    ),
  ],
);

// Query evidence is append-only and contains no result material. The local
// desktop proves that queryRunId belongs to a successful connection-pinned read
// before proposing it; the hosted store binds that immutable receipt to a report.
export const workspaceReportEvidence = workspaceControl.table(
  "workspace_report_evidence",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organization.id, {
      onDelete: "cascade",
    }),
    reportId: uuid("report_id").notNull(),
    connectionId: uuid("connection_id").notNull(),
    queryRunId: uuid("query_run_id").notNull(),
    sql: text("sql").notNull(),
    queryHash: text("query_hash").notNull(),
    executedAt: timestamp("executed_at", { withTimezone: true }).notNull(),
    addedAtRevision: bigint("added_at_revision", { mode: "number" }).notNull(),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdByMemberId: text("created_by_member_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("workspace_report_evidence_org_report_id_idx").on(
      table.organizationId,
      table.reportId,
      table.id,
    ),
    uniqueIndex("workspace_report_evidence_org_report_run_idx").on(
      table.organizationId,
      table.reportId,
      table.queryRunId,
    ),
    index("workspace_report_evidence_org_report_created_idx").on(
      table.organizationId,
      table.reportId,
      table.createdAt,
    ),
    foreignKey({
      columns: [table.organizationId, table.reportId],
      foreignColumns: [workspaceReport.organizationId, workspaceReport.id],
      name: "workspace_report_evidence_org_report_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId, table.connectionId],
      foreignColumns: [workspaceConnection.organizationId, workspaceConnection.id],
      name: "workspace_report_evidence_org_connection_fk",
    }).onDelete("cascade"),
    check(
      "workspace_report_evidence_sql_length",
      sql`octet_length(${table.sql}) BETWEEN 1 AND 20000`,
    ),
    check(
      "workspace_report_evidence_query_hash",
      sql`${table.queryHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "workspace_report_evidence_revision",
      sql`${table.addedAtRevision} >= 1 AND ${table.addedAtRevision} <= 9007199254740991`,
    ),
  ],
);

// Complete report definitions are immutable revisions. Evidence remains in its
// own immutable relation and is referenced by the claim ids inside payload.
export const workspaceReportRevision = workspaceControl.table(
  "workspace_report_revision",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organization.id, {
      onDelete: "cascade",
    }),
    reportId: uuid("report_id").notNull(),
    revision: bigint("revision", { mode: "number" }).notNull(),
    baseRevision: bigint("base_revision", { mode: "number" }),
    operation: text("operation").notNull(),
    payload: jsonb("payload").notNull(),
    payloadHash: text("payload_hash").notNull(),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdByMemberId: text("created_by_member_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("workspace_report_revision_org_report_revision_idx").on(
      table.organizationId,
      table.reportId,
      table.revision,
    ),
    index("workspace_report_revision_org_report_created_idx").on(
      table.organizationId,
      table.reportId,
      table.createdAt,
    ),
    foreignKey({
      columns: [table.organizationId, table.reportId],
      foreignColumns: [workspaceReport.organizationId, workspaceReport.id],
      name: "workspace_report_revision_org_report_fk",
    }).onDelete("cascade"),
    check(
      "workspace_report_revision_number",
      sql`${table.revision} >= 1 AND ${table.revision} <= 9007199254740991`,
    ),
    check(
      "workspace_report_revision_base",
      sql`${table.baseRevision} IS NULL OR (${table.baseRevision} >= 0 AND ${table.baseRevision} <= 9007199254740991)`,
    ),
    check(
      "workspace_report_revision_operation",
      sql`${table.operation} IN ('create', 'propose', 'update', 'submit_review', 'return_draft', 'publish', 'archive', 'restore', 'transfer', 'append_evidence', 'delete')`,
    ),
    check(
      "workspace_report_revision_payload_hash",
      sql`${table.payloadHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

// Import idempotency is scoped to the tenant and binds the opaque receipt's
// canonical resource plus the sanitized request representation. The final import
// command writes this row only after it has created the projection, grant, immutable
// version, and audit event.
export const workspaceProviderImportRequest = workspaceControl.table(
  "workspace_provider_import_request",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organization.id, {
      onDelete: "cascade",
    }),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    productionApproved: boolean("production_approved").notNull().default(false),
    resourceId: uuid("resource_id").notNull(),
    connectionId: uuid("connection_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("provider_import_org_key_idx").on(table.organizationId, table.idempotencyKey),
    foreignKey({
      columns: [table.organizationId, table.resourceId],
      foreignColumns: [workspaceProviderResource.organizationId, workspaceProviderResource.id],
      name: "provider_import_org_resource_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.connectionId],
      foreignColumns: [workspaceConnection.organizationId, workspaceConnection.id],
      name: "provider_import_org_connection_fk",
    }).onDelete("restrict"),
    check("provider_import_request_hash", sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

// Resource versions are immutable tenant-scoped facts. The mutable connection row
// remains the current projection; offline candidates are stored on a conflict branch
// instead of replacing that projection.
export const workspaceResourceVersion = workspaceControl.table(
  "workspace_resource_version",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organization.id, {
      onDelete: "cascade",
    }),
    resourceType: text("resource_type").notNull(),
    resourceId: uuid("resource_id").notNull(),
    revision: bigint("revision", { mode: "number" }).notNull(),
    baseRevision: bigint("base_revision", { mode: "number" }),
    parentVersionId: uuid("parent_version_id"),
    branch: text("branch").notNull().default("main"),
    operation: text("operation").notNull(),
    payload: jsonb("payload").notNull(),
    payloadHash: text("payload_hash").notNull(),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("workspace_resource_version_org_id_idx").on(table.organizationId, table.id),
    uniqueIndex("workspace_resource_version_main_revision_idx")
      .on(table.organizationId, table.resourceType, table.resourceId, table.revision)
      .where(sql`"branch" = 'main'`),
    index("workspace_resource_version_org_resource_created_idx").on(
      table.organizationId,
      table.resourceType,
      table.resourceId,
      table.createdAt,
    ),
    foreignKey({
      columns: [table.organizationId, table.resourceId],
      foreignColumns: [workspaceConnection.organizationId, workspaceConnection.id],
      name: "workspace_resource_version_org_connection_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId, table.parentVersionId],
      foreignColumns: [table.organizationId, table.id],
      name: "workspace_resource_version_org_parent_fk",
    }).onDelete("restrict"),
    check("workspace_resource_version_type", sql`${table.resourceType} = 'connection'`),
    check("workspace_resource_version_branch", sql`${table.branch} IN ('main', 'conflict')`),
    check(
      "workspace_resource_version_revision",
      sql`(${table.branch} = 'main' AND ${table.revision} >= 1 AND ${table.revision} <= 9007199254740991)
        OR (${table.branch} = 'conflict' AND ${table.revision} >= 0 AND ${table.revision} <= 9007199254740991)`,
    ),
    check(
      "workspace_resource_version_base_revision",
      sql`${table.baseRevision} IS NULL OR (${table.baseRevision} >= 0 AND ${table.baseRevision} <= 9007199254740991)`,
    ),
    check(
      "workspace_resource_version_operation",
      sql`${table.operation} IN ('create', 'update', 'delete', 'restore')`,
    ),
    check("workspace_resource_version_payload_hash", sql`${table.payloadHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

// A conflict is an opaque tenant-local handle joining an immutable stale candidate
// to the main-line version that won the optimistic-concurrency race.
export const workspaceResourceConflict = workspaceControl.table(
  "workspace_resource_conflict",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organization.id, {
      onDelete: "cascade",
    }),
    resourceType: text("resource_type").notNull(),
    resourceId: uuid("resource_id").notNull(),
    expectedRevision: bigint("expected_revision", { mode: "number" }).notNull(),
    serverVersionId: uuid("server_version_id").notNull(),
    candidateVersionId: uuid("candidate_version_id").notNull(),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("workspace_resource_conflict_org_id_idx").on(table.organizationId, table.id),
    index("workspace_resource_conflict_org_resource_idx").on(
      table.organizationId,
      table.resourceType,
      table.resourceId,
      table.createdAt,
    ),
    foreignKey({
      columns: [table.organizationId, table.resourceId],
      foreignColumns: [workspaceConnection.organizationId, workspaceConnection.id],
      name: "workspace_resource_conflict_org_connection_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId, table.serverVersionId],
      foreignColumns: [workspaceResourceVersion.organizationId, workspaceResourceVersion.id],
      name: "workspace_resource_conflict_org_server_version_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.candidateVersionId],
      foreignColumns: [workspaceResourceVersion.organizationId, workspaceResourceVersion.id],
      name: "workspace_resource_conflict_org_candidate_version_fk",
    }).onDelete("restrict"),
    check("workspace_resource_conflict_type", sql`${table.resourceType} = 'connection'`),
    check("workspace_resource_conflict_expected_revision", sql`${table.expectedRevision} >= 0 AND ${table.expectedRevision} <= 9007199254740991`),
  ],
);

// Conflict decisions are append-only audit facts. The chosen resulting version
// is retained alongside the decision so a later main-line change cannot rewrite
// what the reviewer actually approved.
export const workspaceResourceConflictResolution = workspaceControl.table(
  "workspace_resource_conflict_resolution",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organization.id, {
      onDelete: "cascade",
    }),
    conflictId: uuid("conflict_id").notNull(),
    resolution: text("resolution").notNull(),
    resultingVersionId: uuid("resulting_version_id").notNull(),
    resolvedByUserId: text("resolved_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("workspace_resource_conflict_resolution_org_id_idx")
      .on(table.organizationId, table.id),
    uniqueIndex("workspace_resource_conflict_resolution_org_conflict_idx")
      .on(table.organizationId, table.conflictId),
    foreignKey({
      columns: [table.organizationId, table.conflictId],
      foreignColumns: [workspaceResourceConflict.organizationId, workspaceResourceConflict.id],
      name: "workspace_resource_conflict_resolution_org_conflict_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId, table.resultingVersionId],
      foreignColumns: [workspaceResourceVersion.organizationId, workspaceResourceVersion.id],
      name: "workspace_resource_conflict_resolution_org_version_fk",
    }).onDelete("restrict"),
    check(
      "workspace_resource_conflict_resolution_value",
      sql`${table.resolution} IN ('server', 'candidate', 'dismissed')`,
    ),
  ],
);

// Backup payloads are ciphertext only. Metadata snapshots are immutable after
// creation; deletion is a retention tombstone and never exposes the envelope.
export const workspaceMetadataBackup = workspaceControl.table(
  "workspace_metadata_backup",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organization.id, {
      onDelete: "cascade",
    }),
    sourceRevision: bigint("source_revision", { mode: "number" }).notNull(),
    keyReference: text("key_reference").notNull(),
    keyVersion: text("key_version").notNull(),
    ciphertext: text("ciphertext").notNull(),
    snapshotHash: text("snapshot_hash").notNull(),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("workspace_metadata_backup_org_id_idx").on(table.organizationId, table.id),
    index("workspace_metadata_backup_org_created_idx").on(
      table.organizationId,
      table.createdAt,
    ),
    check("workspace_metadata_backup_snapshot_hash", sql`${table.snapshotHash} ~ '^[0-9a-f]{64}$'`),
    check("workspace_metadata_backup_source_revision", sql`${table.sourceRevision} >= 1 AND ${table.sourceRevision} <= 9007199254740991`),
  ],
);

// Lease rows are a secret-free revocation and audit index. One-time passwords and
// tokens are returned directly to the native client and are never inserted here.
export const workspaceCredentialLease = workspaceControl.table(
  "workspace_credential_lease",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organization.id, {
      onDelete: "cascade",
    }),
    connectionId: uuid("connection_id").notNull().references(() => workspaceConnection.id, {
      onDelete: "cascade",
    }),
    integrationId: uuid("integration_id").notNull().references(
      () => workspaceProviderIntegration.id,
      { onDelete: "cascade" },
    ),
    userId: text("user_id").notNull().references(() => user.id, {
      onDelete: "cascade",
    }),
    provider: text("provider").notNull(),
    accessMode: text("access_mode").notNull(),
    externalCredentialId: text("external_credential_id").notNull(),
    externalCredentialKind: text("external_credential_kind").notNull(),
    // Exact redacted resource identity returned by the live Provider proof.
    // Nullable only for legacy and pre-verification pending reservations.
    providerAuditId: text("provider_audit_id"),
    activeSlot: integer("active_slot"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    // Cron workers claim cleanup atomically. Failed provider calls retain only
    // retry scheduling metadata; provider error text is never persisted.
    cleanupAttempts: integer("cleanup_attempts").notNull().default(0),
    cleanupNextAttemptAt: timestamp("cleanup_next_attempt_at", {
      withTimezone: true,
    }),
    cleanupClaimedAt: timestamp("cleanup_claimed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("credential_lease_member_active_idx").on(
      table.organizationId,
      table.userId,
      table.expiresAt,
    ),
    index("credential_lease_connection_active_idx").on(
      table.connectionId,
      table.expiresAt,
    ),
    index("credential_lease_expiry_idx").on(table.expiresAt),
    uniqueIndex("credential_lease_active_slot_idx")
      .on(
        table.organizationId,
        table.connectionId,
        table.userId,
        table.activeSlot,
      )
      .where(sql`"revoked_at" IS NULL`),
    check(
      "credential_lease_active_slot_range",
      sql`${table.activeSlot} IS NULL OR ${table.activeSlot} BETWEEN 1 AND 5`,
    ),
    check(
      "credential_lease_live_slot_required",
      sql`${table.revokedAt} IS NOT NULL OR ${table.activeSlot} IS NOT NULL`,
    ),
    check(
      "credential_lease_provider_audit_id_length",
      sql`${table.providerAuditId} IS NULL OR char_length(${table.providerAuditId}) BETWEEN 1 AND 512`,
    ),
    index("credential_lease_cleanup_ready_idx")
      .on(table.cleanupAttempts, table.cleanupNextAttemptAt, table.expiresAt)
      .where(sql`"revoked_at" IS NULL`),
    foreignKey({
      columns: [table.organizationId, table.connectionId],
      foreignColumns: [
        workspaceConnection.organizationId,
        workspaceConnection.id,
      ],
      name: "credential_lease_org_connection_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId, table.integrationId],
      foreignColumns: [
        workspaceProviderIntegration.organizationId,
        workspaceProviderIntegration.id,
      ],
      name: "credential_lease_org_integration_fk",
    }).onDelete("cascade"),
  ],
);

export const authSchema = {
  user,
  session,
  account,
  verification,
  organization,
  member,
  invitation,
  deviceCode,
  rateLimit,
};
