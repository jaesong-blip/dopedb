// Neon managed-access adapter: database boundary verification and short-lived roles.
import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import {
  NEON_LEASE_SECONDS,
  NEON_PUBLIC_DATABASE_ESCAPE_SQL,
  NEON_PUBLIC_SCHEMA_CREATE_SQL,
  NEON_PUBLIC_SCHEMA_ESCAPE_SQL,
  NEON_ROLE_CONNECTION_LIMIT,
  createNeonScramVerifier,
  neonInheritedRoleRetirementStatement,
  neonLeaseRole,
  neonLeaseRoleName,
  neonOwnerRoleName,
  neonPublicDatabaseBoundaryError,
  neonRoleRevokeStatements,
  neonRoleStatements,
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
  NeonInheritedCredentialFenceConflictError,
  NeonLeaseCleanupRequiredError,
  listNeonDatabases,
  listNeonProjects,
  object,
  ownerConnection,
  sqlClient,
  type NeonSqlClient,
} from "./neon-api";
import { listNeonBranches } from "./neon-branch-inventory-api";

const MAX_INHERITED_NEON_LEASE_ROLES = 200;

function safeInheritedLeaseRoleRow(row: Record<string, unknown>) {
  return neonLeaseRoleName(row.role_name)
    && row.superuser === false
    && row.inherits === true
    && row.create_role === false
    && row.create_database === false
    && row.replication === false
    && row.bypass_rls === false
    && row.connection_limit === NEON_ROLE_CONNECTION_LIMIT
    && row.no_memberships === true
    && row.no_members === true;
}

export async function retireInheritedNeonLeaseRoles(input: {
  credential: NeonCredential;
  projectId: string;
  branchId: string;
  databases: readonly ProviderResourceItem[];
}) {
  const database = [...input.databases].sort((left, right) => (
    left.id.localeCompare(right.id)
  ))[0];
  if (!database) {
    throw new ProviderRequestError("neon", "Neon branch has no database", 409);
  }
  const resource: NeonResource = {
    project: input.projectId,
    branch: input.branchId,
    databaseId: database.id,
    database: database.value,
    engine: "postgres",
    schemas: ["public"],
  };
  const connection = await ownerConnection(input.credential, resource);
  const sql = sqlClient(connection.connectionUri);
  try {
    const rows = await sql.query(
      "SELECT r.rolname AS role_name, r.rolsuper AS superuser, "
        + "r.rolinherit AS inherits, r.rolcreaterole AS create_role, "
        + "r.rolcreatedb AS create_database, r.rolreplication AS replication, "
        + "r.rolbypassrls AS bypass_rls, r.rolconnlimit AS connection_limit, "
        + "NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid) "
        + "AS no_memberships, "
        + "NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = r.oid) "
        + "AS no_members FROM pg_roles r "
        + "WHERE r.rolname ~ '^dopedb_[a-z0-9]{1,8}_[a-z0-9]{1,32}$' "
        + "AND r.rolname !~ '^dopedb_policy_[0-9a-f]{16}$' "
        + "ORDER BY r.rolname LIMIT 201",
    );
    if (
      rows.length > MAX_INHERITED_NEON_LEASE_ROLES
      || rows.some((row) => !safeInheritedLeaseRoleRow(row))
    ) {
      throw new NeonInheritedCredentialFenceConflictError();
    }
    const roles = rows.map((row) => row.role_name as string);
    if (roles.length > 0) {
      await sql.transaction(
        roles.map((role) => sql.query(
          neonInheritedRoleRetirementStatement(role),
        )),
      );
      // Commit NOLOGIN/password removal before terminating sessions. Otherwise
      // a preserved password could open one last session between termination
      // and the transaction commit.
      await sql.query(
        "SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity "
          + "WHERE pid <> pg_backend_pid() AND usename = ANY($1::text[])",
        [roles],
      );
    }
    const verified = await sql.query(
      "SELECT r.rolname AS role_name, r.rolcanlogin AS can_login, "
        + "r.rolvaliduntil <= now() AS expired, r.rolsuper AS superuser, "
        + "r.rolinherit AS inherits, r.rolcreaterole AS create_role, "
        + "r.rolcreatedb AS create_database, r.rolreplication AS replication, "
        + "r.rolbypassrls AS bypass_rls, r.rolconnlimit AS connection_limit, "
        + "NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid) "
        + "AS no_memberships, "
        + "NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = r.oid) "
        + "AS no_members FROM pg_roles r "
        + "WHERE r.rolname ~ '^dopedb_[a-z0-9]{1,8}_[a-z0-9]{1,32}$' "
        + "AND r.rolname !~ '^dopedb_policy_[0-9a-f]{16}$' "
        + "ORDER BY r.rolname LIMIT 201",
    );
    const verifiedRoles = verified.map((row) => row.role_name);
    if (
      verified.length !== roles.length
      || verified.some((row) => (
        !safeInheritedLeaseRoleRow(row)
        || row.can_login !== false
        || row.expired !== true
      ))
      || verifiedRoles.some((role, index) => role !== roles[index])
    ) {
      throw new NeonInheritedCredentialFenceConflictError();
    }
    if (roles.length > 0) {
      const sessions = await sql.query(
        "SELECT 1 AS active FROM pg_stat_activity "
          + "WHERE pid <> pg_backend_pid() AND usename = ANY($1::text[]) LIMIT 1",
        [roles],
      );
      if (sessions.length > 0) {
        throw new ProviderRequestError(
          "neon",
          "Neon inherited credential sessions are still closing",
          503,
        );
      }
    }
    return {
      retiredInheritedRoleCount: roles.length,
      credentialFenceFingerprint: createHash("sha256")
        .update(JSON.stringify({
          projectId: input.projectId,
          branchId: input.branchId,
          retiredRoles: roles,
        }), "utf8")
        .digest("hex"),
    };
  } catch (error) {
    if (error instanceof NeonInheritedCredentialFenceConflictError) throw error;
    if (error instanceof ProviderRequestError) throw error;
    throw new ProviderRequestError(
      "neon",
      "Neon inherited credential fence could not be verified",
      502,
    );
  }
}

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
  const legacyDatabaseAuthority = resource.databaseId === resource.database
    && !/^[0-9]{1,19}$/.test(resource.databaseId);
  const database = databases.find((item) => (
    legacyDatabaseAuthority
      ? item.value === resource.database
      : item.id === resource.databaseId
  ));
  if (!database) {
    throw new ProviderRequestError("neon", "Neon database was not found", 404);
  }
  const liveResource: NeonResource = {
    ...resource,
    databaseId: database.id,
    database: database.name,
  };
  return {
    branch,
    database,
    resource: liveResource,
    connection: await ownerConnection(credential, liveResource),
  };
}

/** Server-only owner session used by the approval-gated bootstrap executor. */
export async function openNeonBootstrapTarget(
  credential: NeonCredential,
  resource: NeonResource,
) {
  const identity = await resolveNeonResourceIdentity(credential, resource);
  return {
    branch: identity.branch,
    database: identity.database,
    resource: identity.resource,
    owner: identity.connection.owner,
    endpointHost: identity.connection.endpoint.host,
    sql: sqlClient(identity.connection.connectionUri),
    providerAuditId: `${identity.branch.value}:${identity.database.id}`,
  };
}

export async function inspectNeonResourceIdentity(
  credential: NeonCredential,
  resource: NeonResource,
) {
  const identity = await resolveNeonResourceIdentity(credential, resource);
  return {
    providerAuditId: `${identity.branch.value}:${identity.database.id}`,
  };
}

export async function validateNeonResource(
  credential: NeonCredential,
  resource: NeonResource,
  accessMode: ManagedAccessMode = "read",
  expectedProduction?: boolean,
) {
  const {
    branch,
    connection,
    database,
    resource: liveResource,
  } = await resolveNeonResourceIdentity(credential, resource);
  if (
    branch.ready !== true
    || (branch.production === true && expectedProduction !== true)
    || (branch.production === "unknown" && expectedProduction === undefined)
  ) {
    throw new ProviderRequestError(
      "neon",
      "Neon branch readiness or production classification changed",
      409,
    );
  }
  try {
    await assertNeonManagedBoundary(
      sqlClient(connection.connectionUri),
      liveResource,
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
  return {
    providerAuditId: `${branch.value}:${database.id}`,
    endpointId: connection.endpoint.id,
  };
}

export async function issueNeonLease(input: {
  credential: NeonCredential;
  resource: NeonResource;
  accessMode: ManagedAccessMode;
  production: boolean;
  role: string;
}): Promise<ManagedProviderLease> {
  const password = randomBytes(32).toString("base64url");
  const passwordVerifier = createNeonScramVerifier(password);
  const expiresAt = new Date(Date.now() + NEON_LEASE_SECONDS * 1_000).toISOString();
  const {
    branch,
    connection,
    resource,
  } = await resolveNeonResourceIdentity(input.credential, input.resource);
  if (
    branch.ready !== true
    || (branch.production === true && input.production !== true)
  ) {
    throw new ProviderRequestError(
      "neon",
      "Neon branch readiness or production classification changed",
      409,
    );
  }
  const sql = sqlClient(connection.connectionUri);
  let roleCreated = false;
  try {
    await assertNeonManagedBoundary(
      sql,
      resource,
      input.accessMode,
      connection.owner,
    );
    const statements = neonRoleStatements({
      role: input.role,
      owner: connection.owner,
      passwordVerifier,
      expiresAt,
      accessMode: input.accessMode,
      database: resource.database,
      schemas: resource.schemas,
    });
    await sql.transaction(
      statements.map((statement) => sql.query(statement)),
    );
    roleCreated = true;
    await assertNeonRolePrivileges(
      sql,
      input.role,
      resource,
      input.accessMode,
    );
  } catch (error) {
    if (roleCreated) {
      try {
        await revokeNeonRoleWithClient(
          sql,
          input.role,
          resource,
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
    database: resource.database,
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
  if (!neonLeaseRoleName(role)) {
    throw new ProviderRequestError("neon", "Invalid Neon lease role", 400);
  }
  const identity = await resolveNeonResourceIdentity(credential, resource);
  try {
    await revokeNeonRoleWithClient(
      sqlClient(identity.connection.connectionUri),
      role,
      identity.resource,
      identity.connection.owner,
    );
  } catch {
    throw new ProviderRequestError("neon", "Neon database role could not be revoked", 502);
  }
}

export function neonRoleForLease(userId: string, leaseId: string) {
  return neonLeaseRole(userId, leaseId);
}
