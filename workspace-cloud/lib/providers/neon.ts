// Neon control-plane adapter. The encrypted API key discovers one project hierarchy
// and obtains an owner session only long enough to create or revoke a constrained role.
import "server-only";

import { randomBytes } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { MAX_PROVIDER_RESULTS } from "./adapter-contract";
import {
  NEON_LEASE_SECONDS,
  NEON_PUBLIC_DATABASE_ESCAPE_SQL,
  NEON_PUBLIC_SCHEMA_CREATE_SQL,
  NEON_PUBLIC_SCHEMA_ESCAPE_SQL,
  NEON_ROLE_CONNECTION_LIMIT,
  createNeonScramVerifier,
  neonIntegrationIdentity,
  neonLeaseRole,
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

const API_ORIGIN = "https://console.neon.tech/api/v2";
const REQUEST_TIMEOUT_MS = 15_000;
const NEON_PAGE_LIMIT = 100;
const MAX_NEON_PAGES = 16;
type JsonObject = Record<string, unknown>;

export type NeonAuthInfo = {
  displayName: string;
  externalAccountId: string;
  projectCount: number;
  scopeFingerprint: string;
  authMethod: "api_key_user" | "api_key_org";
  broadScope: boolean;
};

export class NeonLeaseCleanupRequiredError extends ProviderRequestError {
  constructor(readonly externalCredentialId: string) {
    super("neon", "Neon database role cleanup is pending", 503);
    this.name = "NeonLeaseCleanupRequiredError";
  }
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderRequestError("neon", "Neon returned an invalid response", 502);
  }
  return value as JsonObject;
}

function requiredString(value: unknown, field: string) {
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

function apiSegment(value: string) {
  if (!neonSegment(value)) {
    throw new ProviderRequestError("neon", "Invalid Neon resource identifier", 400);
  }
  return encodeURIComponent(value);
}

async function apiRequest(
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
  const body = response.status === 204
    ? null
    : await response.json().catch(() => null);
  if (!response.ok) {
    // A revoked provider key is a failed integration dependency, not an expired
    // DopeDB session. Never let a provider 401 sign the desktop user out.
    const status = response.status === 401
      ? 424
      : response.status >= 500
        ? 502
        : response.status;
    throw new ProviderRequestError("neon", "Neon rejected the request", status);
  }
  return body;
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

async function listNeonCollection(input: {
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
  // /auth works for personal, organization, and project-scoped organization
  // keys. Pairing that identity with the complete project set detects both
  // principal replacement and scope drift without requiring account-level APIs.
  const [projects, authBody] = await Promise.all([
    listNeonProjects(credential),
    apiRequest(credential, "/auth").then(object),
  ]);
  if (projects.length === 0) {
    throw new ProviderRequestError("neon", "Neon API key cannot access a project", 403);
  }
  const accountId = requiredString(authBody.account_id, "authenticated account id");
  const authMethod = authBody.auth_method;
  if (
    authMethod !== "api_key_user"
    && authMethod !== "api_key_org"
  ) {
    throw new ProviderRequestError(
      "neon",
      "Neon credential is not an API key",
      409,
    );
  }
  const identity = neonIntegrationIdentity(
    authMethod === "api_key_org"
      ? { kind: "organization", id: accountId }
      : { kind: "user", id: accountId },
    projects.map((project) => project.value),
  );
  return {
    displayName: projects.length === 1
      ? `Neon · ${projects[0].name}`
      : `Neon · 프로젝트 ${projects.length}개`,
    externalAccountId: identity.externalAccountId,
    projectCount: projects.length,
    scopeFingerprint: identity.scopeFingerprint,
    authMethod,
    // An org_id query narrows this integration's discovery, but does not narrow
    // the authority carried by a personal key itself.
    broadScope: authMethod === "api_key_user",
  };
}

export async function listNeonBranches(
  credential: NeonCredential,
  project: string,
): Promise<ProviderResourceItem[]> {
  const rows = await listNeonCollection({
    credential,
    path: `/projects/${apiSegment(project)}/branches`,
    collection: "branches",
    scopeLabel: "branch",
  });
  return rows.map((row) => {
    const id = requiredString(row.id, "branch id");
    return {
      id,
      value: id,
      name: requiredString(row.name, "branch name"),
      production: row.protected === true
        ? true
        : row.default === false && row.protected === false
          ? false
          : "unknown",
      ready: row.current_state === "ready",
    };
  });
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
    const name = requiredString(row.name, "database name");
    return {
      id: requiredResourceId(row.id, "database id"),
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
  const database = rows.find((row) => row.name === resource.database);
  return database ? requiredString(database.owner_name, "database owner") : null;
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
  const endpoint = rows.find((row) => row.type === "read_write" && row.disabled !== true);
  if (!endpoint) {
    throw new ProviderRequestError(
      "neon",
      "Neon branch has no available read-write endpoint",
      409,
    );
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

async function ownerConnection(
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

function sqlClient(connectionUri: string) {
  return neon(connectionUri, {
    fetchOptions: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  });
}

type NeonSqlClient = ReturnType<typeof sqlClient>;

class NeonBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NeonBoundaryError";
  }
}

function writeTableGrantCheck(accessMode: ManagedAccessMode) {
  return accessMode === "write"
    ? " OR NOT has_table_privilege(c.oid, 'INSERT WITH GRANT OPTION')"
      + " OR NOT has_table_privilege(c.oid, 'UPDATE WITH GRANT OPTION')"
      + " OR NOT has_table_privilege(c.oid, 'DELETE WITH GRANT OPTION')"
    : "";
}

function writeSequenceGrantCheck(accessMode: ManagedAccessMode) {
  return accessMode === "write"
    ? " OR NOT has_sequence_privilege(c.oid, 'USAGE WITH GRANT OPTION')"
      + " OR NOT has_sequence_privilege(c.oid, 'UPDATE WITH GRANT OPTION')"
    : "";
}

async function assertNeonManagedBoundary(
  sql: NeonSqlClient,
  resource: NeonResource,
  accessMode: ManagedAccessMode,
  expectedOwner: string,
) {
  const identityRows = await sql.query(
    "SELECT current_user AS current_user, "
      + "pg_get_userbyid(d.datdba) = current_user AS owns_database "
      + "FROM pg_database d WHERE d.datname = current_database()",
  );
  if (
    !neonOwnerRoleName(expectedOwner)
    || identityRows.length !== 1
    || identityRows[0]?.current_user !== expectedOwner
    || identityRows[0]?.owns_database !== true
  ) {
    throw new NeonBoundaryError(
      "Neon owner credential identity does not match the database owner",
    );
  }
  const databaseRows = await sql.query(
    "SELECT has_database_privilege("
      + "current_database(), 'CONNECT WITH GRANT OPTION') AS grantable",
  );
  if (databaseRows[0]?.grantable !== true) {
    throw new NeonBoundaryError(
      "Neon database CONNECT privilege cannot be delegated by the database owner",
    );
  }
  const publicDatabasePrivileges = await sql.query(
    NEON_PUBLIC_DATABASE_ESCAPE_SQL,
  );
  const publicDatabaseBoundaryError = neonPublicDatabaseBoundaryError(
    publicDatabasePrivileges.map((row) => row.privilege_type),
  );
  if (publicDatabaseBoundaryError) {
    throw new NeonBoundaryError(publicDatabaseBoundaryError);
  }
  const schemaRows = await sql.query(
    "SELECT n.nspname AS schema_name, "
      + "has_schema_privilege(n.oid, 'USAGE WITH GRANT OPTION') AS grantable "
      + "FROM pg_namespace n WHERE n.nspname = ANY($1::text[])",
    [resource.schemas],
  );
  if (
    schemaRows.length !== resource.schemas.length
    || schemaRows.some((row) => row.grantable !== true)
  ) {
    throw new NeonBoundaryError(
      "Neon schema allowlist is missing or cannot be granted by the database owner",
    );
  }

  // ALTER DEFAULT PRIVILEGES affects only objects created by its target role.
  // A single schema owner and no delegated CREATE capability make that future
  // object boundary both complete and independently auditable.
  const unsafeSchemaCreators = await sql.query(
    "SELECT n.nspname AS schema_name FROM pg_namespace n "
      + "WHERE n.nspname = ANY($1::text[]) AND ("
      + "(n.nspowner <> current_user::regrole AND NOT EXISTS ("
      + "SELECT 1 FROM pg_roles owner_role WHERE owner_role.oid = n.nspowner "
      + "AND owner_role.rolname = 'pg_database_owner')) OR EXISTS ("
      + "SELECT 1 FROM aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) acl "
      + "WHERE acl.privilege_type = 'CREATE' "
      + "AND acl.grantee <> current_user::regrole::oid "
      + "AND NOT EXISTS (SELECT 1 FROM pg_roles creator_role "
      + "WHERE creator_role.oid = acl.grantee "
      + "AND creator_role.rolname = 'pg_database_owner'))) LIMIT 1",
    [resource.schemas],
  );
  const foreignOwnedObjects = await sql.query(
    "SELECT n.nspname AS schema_name, c.relname AS object_name "
      + "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
      + "WHERE n.nspname = ANY($1::text[]) "
      + "AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S') "
      + "AND c.relowner <> current_user::regrole LIMIT 1",
    [resource.schemas],
  );
  if (unsafeSchemaCreators.length > 0 || foreignOwnedObjects.length > 0) {
    throw new NeonBoundaryError(
      "Neon managed access requires the database owner to exclusively create "
        + "and own objects in every managed schema",
    );
  }

  const publicSchemaEscape = await sql.query(
    NEON_PUBLIC_SCHEMA_ESCAPE_SQL,
    [resource.schemas],
  );
  const publicSchemaCreate = await sql.query(
    NEON_PUBLIC_SCHEMA_CREATE_SQL,
    [resource.schemas],
  );
  if (publicSchemaEscape.length > 0 || publicSchemaCreate.length > 0) {
    throw new NeonBoundaryError(
      "Neon PUBLIC schema privileges escape the managed schema allowlist",
    );
  }

  const disallowedPublicTablePrivileges = accessMode === "write"
    ? ["TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"]
    : [
      "INSERT",
      "UPDATE",
      "DELETE",
      "TRUNCATE",
      "REFERENCES",
      "TRIGGER",
      "MAINTAIN",
    ];
  const publicTableEscapes = await sql.query(
    "SELECT n.nspname AS schema_name, c.relname AS object_name "
      + "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
      + "CROSS JOIN LATERAL aclexplode("
      + "COALESCE(c.relacl, acldefault('r', c.relowner))) acl "
      + "WHERE n.nspname = ANY($1::text[]) "
      + "AND c.relkind IN ('r', 'p', 'v', 'm', 'f') "
      + "AND acl.grantee = 0 "
      + "AND acl.privilege_type = ANY($2::text[]) LIMIT 1",
    [resource.schemas, disallowedPublicTablePrivileges],
  );
  const publicSequenceEscapes = accessMode === "read"
    ? await sql.query(
      "SELECT n.nspname AS schema_name, c.relname AS object_name "
        + "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
        + "CROSS JOIN LATERAL aclexplode("
        + "COALESCE(c.relacl, acldefault('s', c.relowner))) acl "
        + "WHERE n.nspname = ANY($1::text[]) AND c.relkind = 'S' "
        + "AND acl.grantee = 0 "
        + "AND acl.privilege_type = ANY($2::text[]) LIMIT 1",
      [resource.schemas, ["USAGE", "UPDATE"]],
    )
    : [];
  if (publicTableEscapes.length > 0 || publicSequenceEscapes.length > 0) {
    throw new NeonBoundaryError(
      "Neon PUBLIC object privileges exceed the managed access mode",
    );
  }

  const ungrantableTables = await sql.query(
    "SELECT n.nspname AS schema_name, c.relname AS object_name "
      + "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
      + "WHERE n.nspname = ANY($1::text[]) "
      + "AND c.relkind IN ('r', 'p', 'v', 'm', 'f') "
      + "AND (NOT has_table_privilege(c.oid, 'SELECT WITH GRANT OPTION')"
      + writeTableGrantCheck(accessMode)
      + ") LIMIT 1",
    [resource.schemas],
  );
  const ungrantableSequences = await sql.query(
    "SELECT n.nspname AS schema_name, c.relname AS object_name "
      + "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
      + "WHERE n.nspname = ANY($1::text[]) AND c.relkind = 'S' "
      + "AND (NOT has_sequence_privilege(c.oid, 'SELECT WITH GRANT OPTION')"
      + writeSequenceGrantCheck(accessMode)
      + ") LIMIT 1",
    [resource.schemas],
  );
  if (ungrantableTables.length > 0 || ungrantableSequences.length > 0) {
    throw new NeonBoundaryError(
      "Neon schema contains an object whose privileges cannot be safely delegated",
    );
  }

  const unsafeFunctions = await sql.query(
    "SELECT n.nspname AS schema_name, p.proname AS function_name "
      + "FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
      + "CROSS JOIN LATERAL aclexplode("
      + "COALESCE(p.proacl, acldefault('f', p.proowner))) acl "
      + "WHERE n.nspname = ANY($1::text[]) AND p.prosecdef "
      + "AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE' LIMIT 1",
    [resource.schemas],
  );
  if (unsafeFunctions.length > 0) {
    throw new NeonBoundaryError(
      "Neon schema exposes a SECURITY DEFINER function to PUBLIC",
    );
  }

  const reachableDatabases = await sql.query(
    "SELECT d.datname AS database_name FROM pg_database d "
      + "CROSS JOIN LATERAL aclexplode("
      + "COALESCE(d.datacl, acldefault('d', d.datdba))) acl "
      + "WHERE d.datallowconn AND NOT d.datistemplate "
      + "AND d.datname <> current_database() "
      + "AND acl.grantee = 0 AND acl.privilege_type = 'CONNECT' LIMIT 1",
  );
  if (reachableDatabases.length > 0) {
    throw new NeonBoundaryError(
      "Neon managed access requires an isolated branch or PUBLIC CONNECT revoked "
        + "from every other database",
    );
  }
}

function missingWriteRoleChecks(accessMode: ManagedAccessMode) {
  return accessMode === "write"
    ? " OR NOT has_table_privilege($1::name, c.oid, 'INSERT')"
      + " OR NOT has_table_privilege($1::name, c.oid, 'UPDATE')"
      + " OR NOT has_table_privilege($1::name, c.oid, 'DELETE')"
    : "";
}

function missingWriteSequenceChecks(accessMode: ManagedAccessMode) {
  return accessMode === "write"
    ? " OR NOT has_sequence_privilege($1::name, c.oid, 'USAGE')"
      + " OR NOT has_sequence_privilege($1::name, c.oid, 'UPDATE')"
    : "";
}

async function assertNeonRolePrivileges(
  sql: NeonSqlClient,
  role: string,
  resource: NeonResource,
  accessMode: ManagedAccessMode,
) {
  const roleRows = await sql.query(
    "SELECT r.rolcanlogin AS can_login, r.rolsuper AS superuser, "
      + "r.rolinherit AS inherits, r.rolcreaterole AS create_role, "
      + "r.rolcreatedb AS create_database, r.rolreplication AS replication, "
      + "r.rolbypassrls AS bypass_rls, r.rolconnlimit AS connection_limit, "
      + "r.rolvaliduntil > now() AND "
      + "r.rolvaliduntil <= now() + interval '20 minutes' AS bounded_expiry, "
      + "NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid) "
      + "AS no_memberships, "
      + "NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = r.oid) "
      + "AS no_members FROM pg_roles r WHERE r.rolname = $1",
    [role],
  );
  const roleRow = roleRows[0];
  if (
    roleRows.length !== 1
    || roleRow?.can_login !== true
    || roleRow?.superuser !== false
    || roleRow?.inherits !== true
    || roleRow?.create_role !== false
    || roleRow?.create_database !== false
    || roleRow?.replication !== false
    || roleRow?.bypass_rls !== false
    || roleRow?.connection_limit !== NEON_ROLE_CONNECTION_LIMIT
    || roleRow?.bounded_expiry !== true
    || roleRow?.no_memberships !== true
    || roleRow?.no_members !== true
  ) {
    throw new NeonBoundaryError("Neon role safety attributes are invalid");
  }
  const rows = await sql.query(
    "SELECT "
      + "NOT has_database_privilege($1::name, current_database(), 'CONNECT') "
      + "AS missing_database, "
      + "EXISTS (SELECT 1 FROM pg_namespace n "
      + "WHERE n.nspname = ANY($2::text[]) "
      + "AND NOT has_schema_privilege($1::name, n.oid, 'USAGE')) AS missing_schema, "
      + "EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n "
      + "ON n.oid = c.relnamespace WHERE n.nspname = ANY($2::text[]) "
      + "AND c.relkind IN ('r', 'p', 'v', 'm', 'f') "
      + "AND (NOT has_table_privilege($1::name, c.oid, 'SELECT')"
      + missingWriteRoleChecks(accessMode)
      + ")) AS missing_table, "
      + "EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n "
      + "ON n.oid = c.relnamespace WHERE n.nspname = ANY($2::text[]) "
      + "AND c.relkind = 'S' "
      + "AND (NOT has_sequence_privilege($1::name, c.oid, 'SELECT')"
      + missingWriteSequenceChecks(accessMode)
      + ")) AS missing_sequence",
    [role, resource.schemas],
  );
  const row = rows[0];
  if (
    !row
    || row.missing_database !== false
    || row.missing_schema !== false
    || row.missing_table !== false
    || row.missing_sequence !== false
  ) {
    throw new NeonBoundaryError("Neon role privilege verification failed");
  }

  const defaultAclRows = await sql.query(
    "SELECT n.nspname AS schema_name, d.defaclobjtype AS object_type, "
      + "acl.privilege_type AS privilege_type, acl.is_grantable AS is_grantable "
      + "FROM pg_default_acl d "
      + "JOIN pg_namespace n ON n.oid = d.defaclnamespace "
      + "CROSS JOIN LATERAL aclexplode(d.defaclacl) acl "
      + "JOIN pg_roles grantee ON grantee.oid = acl.grantee "
      + "WHERE d.defaclrole = current_user::regrole "
      + "AND grantee.rolname = $1 AND n.nspname = ANY($2::text[]) "
      + "AND d.defaclobjtype IN ('r', 'S') "
      + "ORDER BY n.nspname, d.defaclobjtype, acl.privilege_type",
    [role, resource.schemas],
  );
  const expected = accessMode === "write"
    ? {
      r: ["DELETE", "INSERT", "SELECT", "UPDATE"],
      S: ["SELECT", "UPDATE", "USAGE"],
    }
    : { r: ["SELECT"], S: ["SELECT"] };
  for (const schema of resource.schemas) {
    for (const [objectType, privileges] of Object.entries(expected)) {
      const actual = defaultAclRows
        .filter((row) => (
          row.schema_name === schema && row.object_type === objectType
        ))
        .map((row) => row.privilege_type);
      if (
        actual.length !== privileges.length
        || actual.some((privilege, index) => privilege !== privileges[index])
        || defaultAclRows.some((row) => (
          row.schema_name === schema
          && row.object_type === objectType
          && row.is_grantable !== false
        ))
      ) {
        throw new NeonBoundaryError(
          "Neon future-object privilege verification failed",
        );
      }
    }
  }
}

function postgresErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const body = error as { code?: unknown; cause?: unknown };
  if (typeof body.code === "string") return body.code;
  if (body.cause && typeof body.cause === "object") {
    const cause = body.cause as { code?: unknown };
    if (typeof cause.code === "string") return cause.code;
  }
  return null;
}

async function revokeNeonRoleWithClient(
  sql: NeonSqlClient,
  role: string,
  resource: NeonResource,
  owner: string,
) {
  try {
    // Commit the safety latch independently so later cleanup failures cannot roll
    // LOGIN back on. Missing roles are the idempotent success case.
    await sql.query(`ALTER ROLE ${role} NOLOGIN`);
  } catch (error) {
    if (postgresErrorCode(error) === "42704") return;
    throw error;
  }
  await sql.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
      + "WHERE usename = $1 AND pid <> pg_backend_pid()",
    [role],
  );
  const schemaRows = await sql.query(
    "SELECT n.nspname AS schema_name FROM pg_namespace n "
      + "WHERE n.nspname = ANY($1::text[]) ORDER BY n.nspname",
    [resource.schemas],
  );
  const statements = neonRoleRevokeStatements({
    role,
    owner,
    database: resource.database,
    schemas: schemaRows.map((row) => row.schema_name),
  });
  try {
    await sql.transaction(
      statements.map((statement) => sql.query(statement)),
    );
  } catch (error) {
    if (postgresErrorCode(error) === "42704") return;
    throw error;
  }
}

async function resolveNeonResourceIdentity(
  credential: NeonCredential,
  resource: NeonResource,
) {
  const projects = await listNeonProjects(credential);
  if (!projects.some((item) => item.value === resource.project)) {
    throw new ProviderRequestError("neon", "Neon project was not found", 404);
  }
  const branches = await listNeonBranches(credential, resource.project);
  const branch = branches.find((item) => item.value === resource.branch);
  if (!branch) {
    throw new ProviderRequestError("neon", "Neon branch was not found", 404);
  }
  const databases = await listNeonDatabases(
    credential,
    resource.project,
    resource.branch,
  );
  if (!databases.some((item) => item.value === resource.database)) {
    throw new ProviderRequestError("neon", "Neon database was not found", 404);
  }
  return {
    branch,
    connection: await ownerConnection(credential, resource),
  };
}

export async function inspectNeonResourceIdentity(
  credential: NeonCredential,
  resource: NeonResource,
) {
  const identity = await resolveNeonResourceIdentity(credential, resource);
  return { providerAuditId: identity.branch.value };
}

export async function validateNeonResource(
  credential: NeonCredential,
  resource: NeonResource,
  accessMode: ManagedAccessMode = "read",
) {
  const { branch, connection } = await resolveNeonResourceIdentity(
    credential,
    resource,
  );
  if (
    branch.ready !== true
    // Neon marks default/protected branches as sensitive. Unknown is not a
    // development classification and must not create a database credential.
    || branch.production !== false
  ) {
    throw new ProviderRequestError(
      "neon",
      "Neon branch is not an explicitly ready non-production target",
      409,
    );
  }
  try {
    await assertNeonManagedBoundary(
      sqlClient(connection.connectionUri),
      resource,
      accessMode,
      connection.owner,
    );
  } catch (error) {
    if (error instanceof NeonBoundaryError) {
      throw new ProviderRequestError("neon", error.message, 409);
    }
    throw new ProviderRequestError(
      "neon",
      "Neon database security boundary could not be verified",
      502,
    );
  }
  return { providerAuditId: branch.value };
}

export async function issueNeonLease(input: {
  credential: NeonCredential;
  resource: NeonResource;
  accessMode: ManagedAccessMode;
  role: string;
}): Promise<ManagedProviderLease> {
  const password = randomBytes(32).toString("base64url");
  const passwordVerifier = createNeonScramVerifier(password);
  const expiresAt = new Date(Date.now() + NEON_LEASE_SECONDS * 1_000).toISOString();
  const connection = await ownerConnection(input.credential, input.resource);
  const sql = sqlClient(connection.connectionUri);
  let roleCreated = false;
  try {
    await assertNeonManagedBoundary(
      sql,
      input.resource,
      input.accessMode,
      connection.owner,
    );
    const statements = neonRoleStatements({
      role: input.role,
      owner: connection.owner,
      passwordVerifier,
      expiresAt,
      accessMode: input.accessMode,
      database: input.resource.database,
      schemas: input.resource.schemas,
    });
    await sql.transaction(
      statements.map((statement) => sql.query(statement)),
    );
    roleCreated = true;
    await assertNeonRolePrivileges(
      sql,
      input.role,
      input.resource,
      input.accessMode,
    );
  } catch (error) {
    if (roleCreated) {
      try {
        await revokeNeonRoleWithClient(
          sql,
          input.role,
          input.resource,
          connection.owner,
        );
      } catch {
        throw new NeonLeaseCleanupRequiredError(input.role);
      }
    }
    if (error instanceof NeonBoundaryError) {
      throw new ProviderRequestError("neon", error.message, 409);
    }
    throw new ProviderRequestError(
      "neon",
      "Neon database role could not be issued",
      502,
    );
  }
  return {
    externalCredentialId: input.role,
    externalCredentialKind: "role",
    host: connection.endpoint.host,
    port: 5432,
    database: input.resource.database,
    username: input.role,
    password,
    sslmode: "verify-full",
    expiresAt,
  };
}

export async function revokeNeonLease(
  credential: NeonCredential,
  resource: NeonResource,
  role: string,
) {
  if (!/^dopedb_[a-z0-9]{1,8}_[a-z0-9]{1,32}$/.test(role)) {
    throw new ProviderRequestError("neon", "Invalid Neon lease role", 400);
  }
  const connection = await ownerConnection(credential, resource);
  try {
    await revokeNeonRoleWithClient(
      sqlClient(connection.connectionUri),
      role,
      resource,
      connection.owner,
    );
  } catch {
    throw new ProviderRequestError("neon", "Neon database role could not be revoked", 502);
  }
}

export function neonRoleForLease(userId: string, leaseId: string) {
  return neonLeaseRole(userId, leaseId);
}
