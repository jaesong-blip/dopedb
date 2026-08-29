// Neon control-plane adapter. The encrypted API key discovers one project hierarchy
// and obtains an owner session only long enough to create or revoke a constrained role.
import "server-only";

import {
  boundedJsonResponse,
  BoundedJsonResponseError,
} from "../bounded-json-response";
import { createHash, randomBytes } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { MAX_PROVIDER_RESULTS } from "./adapter-contract";
import {
  NEON_LEASE_SECONDS,
  NEON_PUBLIC_DATABASE_ESCAPE_SQL,
  NEON_PUBLIC_SCHEMA_CREATE_SQL,
  NEON_PUBLIC_SCHEMA_ESCAPE_SQL,
  NEON_ROLE_CONNECTION_LIMIT,
  createNeonScramVerifier,
  neonDatabaseName,
  neonInheritedRoleRetirementStatement,
  neonIntegrationIdentity,
  neonLeaseRole,
  neonLeaseRoleName,
  neonOwnerRoleName,
  neonPublicDatabaseBoundaryError,
  neonRoleRevokeStatements,
  neonRoleStatements,
  neonSegment,
  parseNeonConnectionUri,
  type NeonCredential,
  type NeonResource,
} from "./neon-core";
import {
  ProviderRequestError,
  type ManagedAccessMode,
  type ManagedProviderLease,
  type ProviderResourceItem,
} from "./provider-types";
import {
  neonBranchQueryable,
  parseNeonBranchInventory,
  type NeonBranchInventory,
} from "./neon-branches";
import type { NeonBranchCreatePlan } from "./neon-branch-plan";
import type { NeonBranchDeletePlan } from "./neon-branch-delete-plan";
import {
  neonBranchMutationBody,
  parseNeonBranchAnnotation,
  parseNeonBranchCreateReceipt,
  parseNeonBranchDeleteReceipt,
  parseNeonBranchEndpoints,
  parseNeonBranchOperation,
  type NeonBranchCreateReceipt,
  type NeonBranchDeleteReceipt,
  type NeonOperationStatus,
} from "./neon-branch-mutation";
export type {
  NeonBranchCreateReceipt,
  NeonBranchDeleteReceipt,
} from "./neon-branch-mutation";

export const API_ORIGIN = "https://console.neon.tech/api/v2";
export const REQUEST_TIMEOUT_MS = 15_000;
const NEON_PAGE_LIMIT = 100;
const MAX_NEON_PAGES = 16;
const MAX_NEON_RESPONSE_BYTES = 2 * 1_024 * 1_024;
export const MAX_NEON_MUTATION_RESPONSE_BYTES = 512 * 1_024;
export const NEON_MUTATION_RETRY_DELAY_MS = 250;
type JsonObject = Record<string, unknown>;

export type NeonBranchReconciliation = Readonly<{
  status: "missing" | "pending" | "ready" | "conflict" | "failed";
  branchId: string | null;
  providerOperationId: string | null;
  providerOperationStatus: NeonOperationStatus | null;
  endpointId: string | null;
  databaseCount: number | null;
  databaseFingerprint: string | null;
  retiredInheritedRoleCount: number | null;
  credentialFenceFingerprint: string | null;
  managedAccessState:
    | "waiting_for_provider"
    | "not_requested"
    | "bootstrap_required"
    | "needs_repair"
    | "unavailable";
  failureCode: string | null;
}>;

export type NeonBranchDeleteReconciliation = Readonly<{
  status: "pending" | "ready" | "conflict" | "failed";
  branchId: string;
  providerOperationId: string | null;
  providerOperationStatus: NeonOperationStatus | null;
  endpointId: null;
  databaseCount: null;
  databaseFingerprint: null;
  retiredInheritedRoleCount: null;
  credentialFenceFingerprint: null;
  managedAccessState: "unavailable";
  failureCode: string | null;
}>;

export function neonBranchDatabaseFingerprint(
  databases: readonly Pick<ProviderResourceItem, "id" | "name">[],
) {
  return createHash("sha256")
    .update(JSON.stringify(databases.map((database) => ({
      id: database.id,
      name: database.name,
    })).sort((left, right) => (
      left.id < right.id ? -1 : left.id === right.id ? 0 : 1
    ))), "utf8")
    .digest("hex");
}

export class NeonBranchMutationRequestError extends ProviderRequestError {
  constructor(
    message: string,
    status: number,
    readonly responseReceived: boolean,
    readonly explicitlyRetrySafe: boolean,
  ) {
    super("neon", message, status);
    this.name = "NeonBranchMutationRequestError";
  }
}

export type NeonAuthInfo = {
  displayName: string;
  externalAccountId: string;
  projectCount: number;
  projectIds: readonly string[];
  scopeFingerprint: string;
  authMethod: "api_key_user" | "api_key_org" | "api_key_unclassified";
  broadScope: boolean;
};

export class NeonLeaseCleanupRequiredError extends ProviderRequestError {
  constructor(readonly externalCredentialId: string) {
    super("neon", "Neon database role cleanup is pending", 503);
    this.name = "NeonLeaseCleanupRequiredError";
  }
}

export class NeonInheritedCredentialFenceConflictError extends Error {
  constructor() {
    super("Neon inherited credential fence requires repair");
    this.name = "NeonInheritedCredentialFenceConflictError";
  }
}

export function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderRequestError("neon", "Neon returned an invalid response", 502);
  }
  return value as JsonObject;
}

export function requiredString(value: unknown, field: string) {
  if (typeof value !== "string" || !value || value.length > 2_048) {
    throw new ProviderRequestError("neon", `Neon response omitted ${field}`, 502);
  }
  return value;
}

function requiredResourceId(value: unknown, field: string) {
  if (typeof value === "string") return requiredString(value, field);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  throw new ProviderRequestError("neon", `Neon response omitted ${field}`, 502);
}

export function apiSegment(value: string) {
  if (!neonSegment(value)) {
    throw new ProviderRequestError("neon", "Invalid Neon resource identifier", 400);
  }
  return encodeURIComponent(value);
}

export async function boundedJson(
  response: Response,
  maxBytes = MAX_NEON_RESPONSE_BYTES,
): Promise<unknown> {
  try {
    return await boundedJsonResponse(response, maxBytes);
  } catch (error) {
    if (
      error instanceof BoundedJsonResponseError
      && error.failure === "oversized"
    ) {
      throw new ProviderRequestError("neon", "Neon response is too large", 502);
    }
    throw new ProviderRequestError("neon", "Neon returned an invalid response", 502);
  }
}

export async function apiRequest(
  credential: NeonCredential,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await fetch(`${API_ORIGIN}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${credential.apiKey}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch(() => {
    throw new ProviderRequestError("neon", "Neon API is unavailable", 502);
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    // A revoked provider key is a failed integration dependency, not an expired
    // DopeDB session. Never let a provider 401 sign the desktop user out.
    const status = response.status === 401
      ? 424
      : response.status >= 500
        ? 502
        : response.status;
    throw new ProviderRequestError("neon", "Neon rejected the request", status);
  }
  return response.status === 204 ? null : boundedJson(response);
}

function nextCursor(body: JsonObject) {
  const pagination = body.pagination;
  if (pagination === undefined || pagination === null) {
    return null;
  }
  if (typeof pagination !== "object" || Array.isArray(pagination)) {
    throw new ProviderRequestError("neon", "Neon returned invalid pagination", 502);
  }
  const page = pagination as JsonObject;
  const value = page.next ?? page.cursor;
  if (value === undefined || value === null || value === "") return null;
  if (
    typeof value !== "string"
    || value.length > 2_048
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new ProviderRequestError("neon", "Neon returned invalid pagination", 502);
  }
  return value;
}

export async function listNeonCollection(input: {
  credential: NeonCredential;
  path: string;
  collection: string;
  query?: URLSearchParams;
  requestPageLimit?: boolean;
  scopeLabel: string;
}) {
  const rows: JsonObject[] = [];
  const seenCursors = new Set<string>();
  const seenIds = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < MAX_NEON_PAGES; page += 1) {
    const query = new URLSearchParams(input.query);
    if (input.requestPageLimit !== false) {
      query.set("limit", String(NEON_PAGE_LIMIT));
    }
    if (cursor) query.set("cursor", cursor);
    const suffix = query.size > 0 ? `?${query}` : "";
    const body = object(await apiRequest(
      input.credential,
      `${input.path}${suffix}`,
    ));
    const collection = body[input.collection];
    const pageRows = Array.isArray(collection)
      ? collection.map(object)
      : [];
    if (pageRows.length > MAX_PROVIDER_RESULTS - rows.length) {
      throw new ProviderRequestError(
        "neon",
        `Neon ${input.scopeLabel} scope is too large to import safely`,
        409,
      );
    }
    for (const row of pageRows) {
      const id = requiredResourceId(row.id, `${input.scopeLabel} id`);
      if (seenIds.has(id)) {
        throw new ProviderRequestError(
          "neon",
          `Neon ${input.scopeLabel} pagination returned duplicate resources`,
          502,
        );
      }
      seenIds.add(id);
    }
    rows.push(...pageRows);
    const next = nextCursor(body);
    if (!next) return rows;
    if (rows.length >= MAX_PROVIDER_RESULTS || seenCursors.has(next)) {
      throw new ProviderRequestError(
        "neon",
        `Neon ${input.scopeLabel} pagination could not be completed safely`,
        409,
      );
    }
    seenCursors.add(next);
    cursor = next;
  }
  throw new ProviderRequestError(
    "neon",
    `Neon ${input.scopeLabel} pagination exceeded its safety limit`,
    409,
  );
}

export async function listNeonProjects(
  credential: NeonCredential,
): Promise<ProviderResourceItem[]> {
  if (credential.projectId) {
    const body = object(await apiRequest(
      credential,
      `/projects/${apiSegment(credential.projectId)}`,
    ));
    const project = object(body.project);
    const id = requiredString(project.id, "project id");
    if (id !== credential.projectId) {
      throw new ProviderRequestError(
        "neon",
        "Neon returned a different project than requested",
        502,
      );
    }
    return [{
      id,
      value: id,
      name: requiredString(project.name, "project name"),
      kind: "postgres",
      ready: true,
      production: "unknown" as const,
    }];
  }
  const query = new URLSearchParams({ timeout: "15000" });
  if (credential.organizationId) query.set("org_id", credential.organizationId);
  const rows = await listNeonCollection({
    credential,
    path: "/projects",
    collection: "projects",
    query,
    scopeLabel: "project",
  });
  return rows.map((row) => {
    const id = requiredString(row.id, "project id");
    return {
      id,
      value: id,
      name: requiredString(row.name, "project name"),
      kind: "postgres",
      ready: true,
      production: "unknown" as const,
    };
  });
}

export async function inspectNeonCredential(
  credential: NeonCredential,
): Promise<NeonAuthInfo> {
  try {
    // Neon infers org_id from organization and project-scoped organization
    // keys. Identify the key first so a user-entered org_id is sent only for a
    // personal key, as required by the provider contract.
    let accountId: string | null = null;
    let authMethod: NeonAuthInfo["authMethod"] = "api_key_unclassified";
    try {
      const authBody = object(await apiRequest(credential, "/auth"));
      accountId = requiredString(
        authBody.account_id,
        "authenticated account id",
      );
      if (
        authBody.auth_method !== "api_key_user"
        && authBody.auth_method !== "api_key_org"
      ) {
        throw new ProviderRequestError(
          "neon",
          "Neon credential is not an API key",
          409,
        );
      }
      authMethod = authBody.auth_method;
    } catch (error) {
      // Neon currently returns 400 from the account-level auth endpoint for
      // some otherwise valid project-scoped organization keys. Project
      // discovery remains the exact authority check for that compatibility
      // path; all other auth failures stay fatal.
      if (
        !(error instanceof ProviderRequestError)
        || error.message !== "Neon rejected the request"
        || error.status !== 400
      ) {
        throw error;
      }
    }
    const projects = await listNeonProjects(
      authMethod !== "api_key_user"
        ? { ...credential, organizationId: null }
        : credential,
    );
    if (projects.length === 0) {
      throw new ProviderRequestError(
        "neon",
        "Neon API key cannot access a project",
        403,
      );
    }
    const projectIds = projects.map((project) => project.value);
    const identity = neonIntegrationIdentity(
      authMethod === "api_key_org" && accountId
        ? { kind: "organization", id: accountId }
        : authMethod === "api_key_user" && accountId
          ? { kind: "user", id: accountId }
          : {
              kind: "organization",
              id: `scope-${createHash("sha256")
                .update([...projectIds].sort().join("\n"), "utf8")
                .digest("base64url")}`,
            },
      projectIds,
    );
    return {
      displayName: projects.length === 1
        ? `Neon · ${projects[0].name}`
        : `Neon · 프로젝트 ${projects.length}개`,
      externalAccountId: identity.externalAccountId,
      projectCount: projects.length,
      projectIds: projects.map((project) => project.id),
      scopeFingerprint: identity.scopeFingerprint,
      authMethod,
      // An org_id query narrows discovery, but not a personal key's authority.
      // An unclassified compatibility key is conservatively treated as broad.
      broadScope: credential.projectId === null && authMethod !== "api_key_org",
    };
  } catch (error) {
    if (
      !(error instanceof ProviderRequestError)
      || error.message !== "Neon rejected the request"
    ) {
      throw error;
    }
    if (error.status === 424) {
      throw new ProviderRequestError(
        "neon",
        "Neon API key is invalid or revoked",
        error.status,
      );
    }
    if (error.status === 400) {
      throw new ProviderRequestError(
        "neon",
        credential.projectId
          ? "Neon could not verify this project for the API key"
          : "Neon could not discover projects for this API key",
        error.status,
      );
    }
    if (error.status === 404 && credential.projectId) {
      throw new ProviderRequestError(
        "neon",
        "Neon project was not found or this API key cannot access it",
        error.status,
      );
    }
    if (error.status === 403) {
      throw new ProviderRequestError(
        "neon",
        "Neon API key cannot access the requested scope",
        error.status,
      );
    }
    if (error.status === 429) {
      throw new ProviderRequestError(
        "neon",
        "Neon API request limit was reached. Try again shortly.",
        error.status,
      );
    }
    throw error;
  }
}

export async function listNeonDatabases(
  credential: NeonCredential,
  project: string,
  branch: string,
): Promise<ProviderResourceItem[]> {
  // The current Neon database endpoint is unpaginated. The generic collector
  // still follows a future cursor response, but does not send undocumented
  // pagination parameters on the first request.
  const rows = await listNeonCollection({
    credential,
    path: `/projects/${apiSegment(project)}/branches/${apiSegment(branch)}/databases`,
    collection: "databases",
    requestPageLimit: false,
    scopeLabel: "database",
  });
  return rows.map((row) => {
    const id = requiredResourceId(row.id, "database id");
    const name = requiredString(row.name, "database name");
    if (
      !/^[0-9]{1,19}$/.test(id)
      || row.branch_id !== branch
      || !neonDatabaseName(name)
    ) {
      throw new ProviderRequestError(
        "neon",
        "Neon returned an invalid branch database",
        502,
      );
    }
    return {
      id,
      value: name,
      name,
      kind: "postgres",
      ready: true,
      production: "unknown" as const,
    };
  });
}

async function databaseOwner(
  credential: NeonCredential,
  resource: NeonResource,
) {
  const body = object(await apiRequest(
    credential,
    `/projects/${apiSegment(resource.project)}/branches/${
      apiSegment(resource.branch)
    }/databases`,
  ));
  const rows = Array.isArray(body.databases) ? body.databases.map(object) : [];
  const databases = rows.filter((row) => (
    requiredResourceId(row.id, "database id") === resource.databaseId
    && row.branch_id === resource.branch
    && row.name === resource.database
  ));
  if (databases.length !== 1) return null;
  const owner = requiredString(databases[0].owner_name, "database owner");
  return neonOwnerRoleName(owner) ? owner : null;
}

async function readWriteEndpoint(
  credential: NeonCredential,
  resource: NeonResource,
) {
  const body = object(await apiRequest(
    credential,
    `/projects/${apiSegment(resource.project)}/branches/${
      apiSegment(resource.branch)
    }/endpoints`,
  ));
  const rows = Array.isArray(body.endpoints) ? body.endpoints.map(object) : [];
  const parsed = parseNeonBranchEndpoints(rows, resource.branch);
  const endpoints = parsed.filter((endpoint) => (
    endpoint.type === "read_write" && !endpoint.disabled
  ));
  if (endpoints.length !== 1) {
    throw new ProviderRequestError(
      "neon",
      "Neon branch does not have one exact read-write endpoint",
      409,
    );
  }
  const endpoint = rows.find((row) => (
    row.id === endpoints[0].id
    && row.branch_id === resource.branch
    && row.type === "read_write"
    && row.disabled !== true
  ));
  if (!endpoint) {
    throw new ProviderRequestError("neon", "Neon endpoint identity changed", 409);
  }
  const host = requiredString(endpoint.host, "endpoint host");
  if (!host.endsWith(".neon.tech")) {
    throw new ProviderRequestError("neon", "Neon returned an invalid endpoint", 502);
  }
  return {
    id: requiredString(endpoint.id, "endpoint id"),
    host,
  };
}

export async function ownerConnection(
  credential: NeonCredential,
  resource: NeonResource,
) {
  const [owner, endpoint] = await Promise.all([
    databaseOwner(credential, resource),
    readWriteEndpoint(credential, resource),
  ]);
  if (!owner) {
    throw new ProviderRequestError("neon", "Neon database was not found", 404);
  }
  const query = new URLSearchParams({
    branch_id: resource.branch,
    endpoint_id: endpoint.id,
    database_name: resource.database,
    role_name: owner,
    pooled: "false",
  });
  const body = object(await apiRequest(
    credential,
    `/projects/${apiSegment(resource.project)}/connection_uri?${query}`,
  ));
  try {
    return {
      owner,
      endpoint,
      ...parseNeonConnectionUri(body.uri, resource.database, owner),
    };
  } catch {
    throw new ProviderRequestError(
      "neon",
      "Neon could not provide the database owner credential",
      409,
    );
  }
}

export function sqlClient(connectionUri: string) {
  return neon(connectionUri, {
    fetchOptions: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  });
}

export type NeonSqlClient = ReturnType<typeof sqlClient>;
