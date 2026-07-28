// The only frontend owner of saved-connection Tauri command names. Screens depend on
// these typed functions and never invoke the connection transport directly.
import { invoke } from "@tauri-apps/api/core";

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
