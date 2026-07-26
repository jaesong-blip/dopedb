import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { authorizeMock, orderByMock, whereMock } = vi.hoisted(() => ({
  authorizeMock: vi.fn(),
  orderByMock: vi.fn(),
  whereMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("../../../../../../lib/db", () => ({
  db: {
    select: vi.fn(() => {
      const builder = {
        from: vi.fn(),
        innerJoin: vi.fn(),
        where: whereMock,
        orderBy: orderByMock,
      };
      builder.from.mockReturnValue(builder);
      builder.innerJoin.mockReturnValue(builder);
      whereMock.mockReturnValue(builder);
      return builder;
    }),
  },
}));
vi.mock("../../../../../../lib/env", () => ({
  env: { appOrigin: () => "https://app.example" },
}));
vi.mock("../../../../../../lib/workspace-authorization", () => ({
  authorizeWorkspace: authorizeMock,
}));

import { GET } from "./route";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const context = { params: Promise.resolve({ workspaceId }) };
const base = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Analytics",
  engine: "postgres",
  provider: "neon",
  driverId: null,
  host: "db.example.test",
  port: 5432,
  databaseName: "analytics",
  sslmode: "verify-full",
  readonlyDefault: true,
  allowWrites: false,
  environment: null,
  schemaGroup: null,
  contentRevision: 4,
  updatedAt: new Date("2026-07-27T00:00:00.000Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  authorizeMock.mockResolvedValue({
    ok: true,
    role: "viewer",
    accessMode: "view",
    membership: { id: "member-id" },
  });
  orderByMock.mockResolvedValue([
    { connection: { ...base, credentialMode: "managed", allowWrites: true }, capability: "use" },
    { connection: { ...base, id: "33333333-3333-4333-8333-333333333333", credentialMode: "member_local" }, capability: "manage" },
  ]);
});

describe("workspace connection collection", () => {
  it("returns both granted managed and safe member-local templates as secretless read-only metadata", async () => {
    const response = await GET(new Request(`https://app.example/api/v1/workspaces/${workspaceId}/connections`), context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      workspaceId,
      connections: [
        {
          credentialMode: "managed",
          credentialsRequired: false,
          allowWrites: false,
          accessMode: "read",
        },
        {
          credentialMode: "member_local",
          credentialsRequired: true,
          allowWrites: false,
          accessMode: "manage",
        },
      ],
    });
  });

  it("filters local and unsafe member-local rows at the tenant grant query boundary", async () => {
    await GET(new Request(`https://app.example/api/v1/workspaces/${workspaceId}/connections`), context);

    const predicate = whereMock.mock.calls[0]?.[0];
    const query = new PgDialect().sqlToQuery(predicate);
    expect(query.params).toEqual(expect.arrayContaining([
      workspaceId,
      "member-id",
      "managed",
      "member_local",
      true,
      false,
    ]));
    expect(query.sql).toContain('"workspace_connection"."credential_mode" =');
    expect(query.sql).toContain('"workspace_connection"."readonly_default" =');
    expect(query.sql).toContain('"workspace_connection"."allow_writes" =');
  });
});
