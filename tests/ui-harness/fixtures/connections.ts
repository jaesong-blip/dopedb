// 연결과 드라이버 fixture. host는 example.invalid, secretRef는 명백한 fixture 키다.
// 실제 connection URL, 비밀번호, provider token을 넣지 않는다.
import {
  connectionId,
  type ConnectionProfile,
  type DriverDescriptor,
} from "../../../src/features/connections/domain";

export const analyticsPostgres = {
  id: connectionId("fixture-connection-0000-0000-0000-000000000001"),
  name: "Analytics",
  engine: "postgres",
  provider: "generic",
  driverId: "postgres-bundled",
  host: "db.example.invalid",
  port: 5432,
  database: "analytics",
  username: "fixture_reader",
  sslmode: "require",
  extraParams: {},
  readonlyDefault: true,
  allowWrites: false,
  secretRef: "fixture-secret-analytics",
  env: "prod",
  schemaGroup: "analytics",
  workspaceAccess: "local",
  credentialMode: "local",
} satisfies ConnectionProfile;

/** 긴 이름의 ellipsis·bounds 계약을 검증하기 위한 두 번째 연결. */
export const stagingPostgres = {
  id: connectionId("fixture-connection-0000-0000-0000-000000000002"),
  name: "Staging replica with a deliberately long connection name",
  engine: "postgres",
  provider: "generic",
  driverId: "postgres-bundled",
  host: "staging.example.invalid",
  port: 5432,
  database: "analytics_staging",
  username: "fixture_reader",
  sslmode: "require",
  extraParams: {},
  readonlyDefault: true,
  allowWrites: false,
  secretRef: "fixture-secret-staging",
  env: "staging",
  schemaGroup: "analytics",
  workspaceAccess: "local",
  credentialMode: "local",
} satisfies ConnectionProfile;

export const postgresDriver = {
  id: "postgres-bundled",
  name: "PostgreSQL",
  engine: "postgres",
  version: "16.4",
  installMode: "bundled",
  installState: "installed",
  supportedProviders: ["auto", "generic", "neon", "gcpCloudSql"],
  capabilities: [
    "sql",
    "transactions",
    "introspection",
    "schemaDiff",
    "monitoring",
  ],
  recommended: true,
} satisfies DriverDescriptor;

export const bundledDrivers = [postgresDriver] satisfies DriverDescriptor[];
