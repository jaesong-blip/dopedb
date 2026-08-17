// The only frontend owner of saved-connection Tauri command names. Screens depend on
// these typed functions and never invoke the connection transport directly.
import type { DatabaseSummary } from "../../ipc/types";
import { invoke } from "../../ipc/core";

import type {
  ConnectionId,
  ConnectionProfile,
  DriverDescriptor,
} from "./domain";

export function listConnections(): Promise<ConnectionProfile[]> {
  return invoke("list_connections");
}

export function listDrivers(): Promise<DriverDescriptor[]> {
  return invoke("list_drivers");
}

export function installDriver(id: string): Promise<DriverDescriptor> {
  return invoke("install_driver", { id });
}

export function createDemoSqlite(): Promise<string> {
  return invoke("create_demo_sqlite");
}

export function upsertConnection(
  profile: ConnectionProfile,
  password?: string,
): Promise<ConnectionProfile> {
  return invoke("upsert_connection", { profile, password });
}

export function setConnectionsSchemaGroup(
  ids: ConnectionId[],
  schemaGroup: string | null,
): Promise<ConnectionProfile[]> {
  return invoke("set_connections_schema_group", { ids, schemaGroup });
}

export function deleteConnection(id: ConnectionId): Promise<void> {
  return invoke("delete_connection", { id });
}

export function testConnection(id: ConnectionId): Promise<void> {
  return invoke("test_connection", { id });
}

export function testConnectionProfile(
  profile: ConnectionProfile,
  password?: string,
): Promise<void> {
  return invoke("test_connection_profile", { profile, password });
}

export function discoverConnectionProfileDatabases(
  profile: ConnectionProfile,
  password?: string,
): Promise<DatabaseSummary[]> {
  return invoke("discover_connection_profile_databases", {
    profile,
    password,
  });
}

/** Native picker for SQLite and certificate paths; null means user cancellation. */
export function pickConnectionFile(): Promise<string | null> {
  return invoke("pick_file");
}
