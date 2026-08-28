import type { ConnectionProfile } from "../connections/domain";
import type { SafetySettings } from "../../ipc/types";

export type ConnectionWriteAuthority = Pick<
  ConnectionProfile,
  "allowWrites" | "credentialMode" | "workspaceAccess"
>;

export type WriteBlockRecoveryKind =
  | "deviceSafety"
  | "localSafety"
  | "managedCredential"
  | "managedDdl"
  | "workspaceGrant"
  | "workspacePolicy"
  | "workspacePolicyAndDevice";

type WriteBlockError = Readonly<{
  kind: string | null;
  message: string;
  sql?: string;
}>;

function isDdlStatement(sql: string | undefined): boolean {
  if (!sql) return false;
  return /^\s*(?:(?:--[^\r\n]*(?:\r?\n|$))|(?:\/\*[\s\S]*?\*\/\s*))*\s*(?:create|alter|drop|truncate|comment|reindex)\b/i.test(
    sql,
  );
}

function isManagedDdlError(error: WriteBlockError): boolean {
  const message = error.message.toLocaleLowerCase();
  return (
    message.includes("managed connections use dml-only short-lived credentials") ||
    (isDdlStatement(error.sql) &&
      (message.includes("permission denied for schema") ||
        message.includes("must be owner of")))
  );
}

function isWritesDisabledError(error: WriteBlockError): boolean {
  if (error.kind !== "blocked" && error.kind !== "safety") return false;
  const message = error.message.toLocaleLowerCase();
  return (
    message.includes("writes are disabled for this connection") ||
    message.includes("writing is disabled for this connection") ||
    message.includes("schema change (ddl) is disabled for this connection")
  );
}

/** Identifies the exact authority layer a write-disabled error must recover. */
export function writeBlockRecoveryKind(
  connection: ConnectionWriteAuthority,
  error: WriteBlockError,
): WriteBlockRecoveryKind | null {
  if (
    connection.credentialMode === "managed" &&
    isManagedDdlError(error)
  ) {
    return "managedDdl";
  }
  if (!isWritesDisabledError(error)) return null;
  if (connection.credentialMode === "memberLocal") {
    return "managedCredential";
  }
  if (
    connection.workspaceAccess === "view" ||
    connection.workspaceAccess === "read"
  ) {
    return "workspaceGrant";
  }
  if (!connection.allowWrites && connection.credentialMode === "managed") {
    return connection.workspaceAccess === "manage"
      ? "workspacePolicyAndDevice"
      : "workspacePolicy";
  }
  if (!connection.allowWrites) return "localSafety";
  return "deviceSafety";
}

/**
 * UI projection of the write authority the Rust runtime enforces.
 *
 * Safety is a narrowing gate. It must never make a connection look writable
 * when its durable policy, workspace grant, or credential mode forbids writes.
 */
export function connectionCanEnterWritePath(
  connection: ConnectionWriteAuthority,
): boolean {
  if (!connection.allowWrites || connection.credentialMode === "memberLocal") {
    return false;
  }
  return (
    connection.workspaceAccess === "local" ||
    connection.workspaceAccess === "write" ||
    connection.workspaceAccess === "manage"
  );
}

/** A manager may change the managed workspace ceiling from the Safety surface. */
export function canManageWorkspaceWritePolicy(
  connection: ConnectionWriteAuthority,
): boolean {
  return (
    connection.credentialMode === "managed" &&
    connection.workspaceAccess === "manage"
  );
}

/** The Safety page owns the local connection's write policy and local consent. */
export function safetyWriteControlAvailable(
  connection: ConnectionWriteAuthority,
): boolean {
  if (
    connection.credentialMode === "local" &&
    connection.workspaceAccess === "local"
  ) {
    return true;
  }
  return (
    canManageWorkspaceWritePolicy(connection) ||
    connectionCanEnterWritePath(connection)
  );
}

/**
 * Normalize the local form against current authority. A manager can request a
 * coordinated hosted-policy change, but this value alone never widens runtime
 * authority; the dedicated workspace command remains the server gate.
 */
export function requestedSafetySettings(
  connection: ConnectionWriteAuthority,
  settings: SafetySettings,
): SafetySettings {
  if (safetyWriteControlAvailable(connection) || !settings.allowWrites) {
    return settings;
  }
  return { ...settings, allowWrites: false };
}

export function effectiveSafetySettings(
  connection: ConnectionWriteAuthority,
  settings: SafetySettings,
): SafetySettings {
  if (connectionCanEnterWritePath(connection) || !settings.allowWrites) {
    return settings;
  }
  return { ...settings, allowWrites: false };
}
