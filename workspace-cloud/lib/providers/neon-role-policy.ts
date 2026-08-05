// Runtime-neutral DopeDB role policy for Neon. Keep this module free of Node
// and server-only imports so browser-side contract tests can execute it.

export function neonLeaseRoleName(value: unknown): value is string {
  return typeof value === "string"
    && /^dopedb_[a-z0-9]{1,8}_[a-z0-9]{1,32}$/.test(value)
    && !/^dopedb_policy_[0-9a-f]{16}$/.test(value);
}

/**
 * A cloned Neon branch can preserve a lease role and its password. Retirement
 * removes every authentication path while keeping the role in place so copied
 * object ACLs can be inspected and repaired by the branch bootstrap.
 */
export function neonInheritedRoleRetirementStatement(role: string) {
  if (!neonLeaseRoleName(role)) throw new Error("Invalid Neon lease role");
  return `ALTER ROLE "${role}" NOLOGIN PASSWORD NULL VALID UNTIL 'epoch'`;
}
