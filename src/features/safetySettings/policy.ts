import type { ConnectionProfile } from "../connections/domain";
import type { SafetySettings } from "../../ipc/types";

export type ConnectionWriteAuthority = Pick<
  ConnectionProfile,
  "allowWrites" | "credentialMode" | "workspaceAccess"
>;

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
