// Opaque, short-lived proof that a final resource leaf came from an authorized
// provider listing. The browser can return this ciphertext, but cannot forge or
// alter the provider selectors sealed inside it.
import "server-only";

import { hkdfSync, randomUUID } from "node:crypto";
import { env } from "./env";
import {
  decodeEnvelopeKey,
  openEnvelope,
  sealEnvelope,
} from "./secret-envelope-core";
import type { ProviderResourceItem } from "./providers/provider-types";

const PROOF_VERSION = 1;
const PROOF_TTL_MS = 5 * 60 * 1_000;
const MAX_PROOF_LENGTH = 16 * 1_024;
const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;
const PROVIDERS = ["planetScale", "neon", "gcpCloudSql"] as const;
const KINDS = ["organizations", "projects", "databases", "branches", "instances"] as const;
const SELECTION_KEYS = [
  "organization",
  "project",
  "database",
  "branch",
  "instance",
  "engine",
  "networkMode",
] as const;

type Provider = typeof PROVIDERS[number];
type DiscoveryKind = typeof KINDS[number];

type SelectionProofPayload = {
  version: typeof PROOF_VERSION;
  organizationId: string;
  integrationId: string;
  integrationGeneration: string;
  receiptId: string;
  memberId: string;
  userId: string;
  sessionId: string;
  provider: Provider;
  kind: DiscoveryKind;
  selection: Record<string, string>;
  item: ProviderResourceItem;
  issuedAt: number;
  expiresAt: number;
};

export type VerifiedProviderDiscoveryProof = Omit<
  SelectionProofPayload,
  "integrationGeneration"
> & {
  integrationGeneration: bigint;
};

function context(organizationId: string, integrationId: string) {
  return `dopedb:provider-discovery-selection:${organizationId}:${integrationId}`;
}

function key() {
  // High-volume ephemeral proofs and long-lived provider credentials never
  // share the same AES-GCM key, even though deployments need only one root key.
  return Buffer.from(hkdfSync(
    "sha256",
    decodeEnvelopeKey(env.credentialKey()),
    Buffer.alloc(0),
    Buffer.from("dopedb:provider-discovery-proof:v1", "utf8"),
    32,
  ));
}

function exactRecord(value: unknown, fields: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return Object.keys(record).every((field) => fields.includes(field))
    ? record
    : null;
}

function safeScalar(value: unknown, maxLength = 512): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(value);
}

const NEON_BRANCH_STATES = ["init", "resetting", "ready", "archived", "unknown"] as const;

function parseProviderTarget(
  value: unknown,
): ProviderResourceItem["providerTarget"] | null | undefined {
  if (value === undefined) return undefined;
  const record = exactRecord(value, [
    "provider", "projectId", "branchId", "name", "currentState", "pendingState",
    "default", "protected",
  ]);
  if (
    !record
    || record.provider !== "neon"
    || !safeScalar(record.projectId, 128)
    || !safeScalar(record.branchId, 128)
    || !safeScalar(record.name, 256)
    || !NEON_BRANCH_STATES.includes(record.currentState as typeof NEON_BRANCH_STATES[number])
    || (record.pendingState !== null
      && !NEON_BRANCH_STATES.includes(record.pendingState as typeof NEON_BRANCH_STATES[number]))
    || typeof record.default !== "boolean"
    || typeof record.protected !== "boolean"
  ) {
    return null;
  }
  return {
    provider: "neon",
    projectId: record.projectId,
    branchId: record.branchId,
    name: record.name,
    currentState: record.currentState as typeof NEON_BRANCH_STATES[number],
    pendingState: record.pendingState as typeof NEON_BRANCH_STATES[number] | null,
    default: record.default,
    protected: record.protected,
  };
}

function expectedSelectionKeys(provider: Provider, kind: DiscoveryKind) {
  if (provider === "planetScale") {
    if (kind === "organizations") return [] as const;
    if (kind === "databases") return ["organization"] as const;
    if (kind === "branches") return ["organization", "database"] as const;
  }
  if (provider === "neon") {
    if (kind === "projects") return [] as const;
    if (kind === "branches") return ["project"] as const;
    if (kind === "databases") return ["project", "branch"] as const;
  }
  if (provider === "gcpCloudSql") {
    if (kind === "projects") return [] as const;
    if (kind === "instances") return ["project"] as const;
    if (kind === "databases") return ["project", "instance"] as const;
  }
  return null;
}

export function canonicalProviderDiscoverySelection(
  provider: Provider,
  kind: DiscoveryKind,
  value: unknown,
) {
  const fields = expectedSelectionKeys(provider, kind);
  if (!fields) return null;
  const record = exactRecord(value, SELECTION_KEYS);
  if (
    !record
    || Object.keys(record).length !== fields.length
    || fields.some((field) => !Object.hasOwn(record, field))
  ) {
    return null;
  }
  const selection: Record<string, string> = {};
  for (const field of fields) {
    const raw = record[field];
    if (!safeScalar(raw)) return null;
    selection[field] = raw;
  }
  return selection;
}

function parseItem(value: unknown): ProviderResourceItem | null {
  const record = exactRecord(value, [
    "id", "name", "value", "kind", "production", "ready", "safeMigrations",
    "providerTarget",
  ]);
  const providerTarget = parseProviderTarget(record?.providerTarget);
  if (
    !record
    || !safeScalar(record.id)
    || !safeScalar(record.name)
    || !safeScalar(record.value)
    || (record.kind !== undefined && record.kind !== "postgres" && record.kind !== "mysql")
    || (record.production !== undefined
      && record.production !== true
      && record.production !== false
      && record.production !== "unknown")
    || (record.ready !== undefined && typeof record.ready !== "boolean")
    || (record.safeMigrations !== undefined && typeof record.safeMigrations !== "boolean")
    || providerTarget === null
  ) {
    return null;
  }
  return {
    id: record.id,
    name: record.name,
    value: record.value,
    ...(record.kind === "postgres" || record.kind === "mysql"
      ? { kind: record.kind }
      : {}),
    ...(record.production === true
      || record.production === false
      || record.production === "unknown"
      ? { production: record.production }
      : {}),
    ...(typeof record.ready === "boolean" ? { ready: record.ready } : {}),
    ...(typeof record.safeMigrations === "boolean"
      ? { safeMigrations: record.safeMigrations }
      : {}),
    ...(providerTarget ? { providerTarget } : {}),
  };
}

function parsePayload(
  value: unknown,
  expected: { organizationId: string; integrationId: string; now: number },
): VerifiedProviderDiscoveryProof | null {
  const record = exactRecord(value, [
    "version",
    "organizationId",
    "integrationId",
    "integrationGeneration",
    "receiptId",
    "memberId",
    "userId",
    "sessionId",
    "provider",
    "kind",
    "selection",
    "item",
    "issuedAt",
    "expiresAt",
  ]);
  if (
    !record
    || record.version !== PROOF_VERSION
    || record.organizationId !== expected.organizationId
    || record.integrationId !== expected.integrationId
    || !safeScalar(record.memberId)
    || !safeScalar(record.userId)
    || !safeScalar(record.sessionId)
    || !PROVIDERS.includes(record.provider as Provider)
    || !KINDS.includes(record.kind as DiscoveryKind)
    || typeof record.integrationGeneration !== "string"
    || !/^[1-9][0-9]{0,18}$/.test(record.integrationGeneration)
    || typeof record.receiptId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(record.receiptId)
    || !Number.isSafeInteger(record.issuedAt)
    || !Number.isSafeInteger(record.expiresAt)
  ) {
    return null;
  }
  const generation = BigInt(record.integrationGeneration);
  const issuedAt = record.issuedAt as number;
  const expiresAt = record.expiresAt as number;
  if (
    generation > MAX_POSTGRES_BIGINT
    || issuedAt > expected.now + 30_000
    || expiresAt <= expected.now
    || expiresAt <= issuedAt
    || expiresAt - issuedAt > PROOF_TTL_MS
  ) {
    return null;
  }
  const selection = canonicalProviderDiscoverySelection(
    record.provider as Provider,
    record.kind as DiscoveryKind,
    record.selection,
  );
  const item = parseItem(record.item);
  if (!selection || !item) return null;
  const neonDatabaseTarget = record.provider === "neon" && record.kind === "databases";
  if (
    neonDatabaseTarget !== (item.providerTarget !== undefined)
    || (item.providerTarget
      && (
        item.providerTarget.projectId !== selection.project
        || item.providerTarget.branchId !== selection.branch
      ))
  ) {
    return null;
  }
  return {
    version: PROOF_VERSION,
    organizationId: expected.organizationId,
    integrationId: expected.integrationId,
    integrationGeneration: generation,
    receiptId: record.receiptId,
    memberId: record.memberId,
    userId: record.userId,
    sessionId: record.sessionId,
    provider: record.provider as Provider,
    kind: record.kind as DiscoveryKind,
    selection,
    item,
    issuedAt,
    expiresAt,
  };
}

export function sealProviderDiscoveryProof(input: {
  organizationId: string;
  integrationId: string;
  integrationGeneration: bigint;
  memberId: string;
  userId: string;
  sessionId: string;
  provider: Provider;
  kind: DiscoveryKind;
  selection: Record<string, string>;
  item: ProviderResourceItem;
  now?: number;
}) {
  const issuedAt = input.now ?? Date.now();
  const payload: SelectionProofPayload = {
    version: PROOF_VERSION,
    organizationId: input.organizationId,
    integrationId: input.integrationId,
    integrationGeneration: input.integrationGeneration.toString(),
    receiptId: randomUUID(),
    memberId: input.memberId,
    userId: input.userId,
    sessionId: input.sessionId,
    provider: input.provider,
    kind: input.kind,
    selection: { ...input.selection },
    item: { ...input.item },
    issuedAt,
    expiresAt: issuedAt + PROOF_TTL_MS,
  };
  if (!parsePayload(payload, {
    organizationId: input.organizationId,
    integrationId: input.integrationId,
    now: issuedAt,
  })) {
    throw new Error("Invalid provider discovery proof payload");
  }
  return sealEnvelope(
    key(),
    JSON.stringify(payload),
    context(input.organizationId, input.integrationId),
  );
}

export function openProviderDiscoveryProof(input: {
  organizationId: string;
  integrationId: string;
  proof: string;
  now?: number;
}): VerifiedProviderDiscoveryProof | null {
  if (!input.proof || input.proof.length > MAX_PROOF_LENGTH) return null;
  try {
    const plaintext = openEnvelope(
      key(),
      input.proof,
      context(input.organizationId, input.integrationId),
    );
    return parsePayload(JSON.parse(plaintext), {
      organizationId: input.organizationId,
      integrationId: input.integrationId,
      now: input.now ?? Date.now(),
    });
  } catch {
    return null;
  }
}

export function sameProviderResourceItem(
  left: ProviderResourceItem,
  right: ProviderResourceItem,
) {
  const leftTarget = left.providerTarget;
  const rightTarget = right.providerTarget;
  const sameTarget = (
    leftTarget === undefined && rightTarget === undefined
  ) || (
    leftTarget !== undefined
    && rightTarget !== undefined
    && leftTarget.provider === rightTarget.provider
    && leftTarget.projectId === rightTarget.projectId
    && leftTarget.branchId === rightTarget.branchId
    && leftTarget.name === rightTarget.name
    && leftTarget.currentState === rightTarget.currentState
    && leftTarget.pendingState === rightTarget.pendingState
    && leftTarget.default === rightTarget.default
    && leftTarget.protected === rightTarget.protected
  );
  return left.id === right.id
    && left.name === right.name
    && left.value === right.value
    && left.kind === right.kind
    && left.production === right.production
    && left.ready === right.ready
    && left.safeMigrations === right.safeMigrations
    && sameTarget;
}
