import { describe, expect, it } from "vitest";
import type { CatalogTable } from "../ipc/types";
import { buildDelete, buildUpdate } from "./sqlBuild";

function table(
  columns: CatalogTable["columns"],
): CatalogTable {
  return {
    schema: "public",
    name: "users",
    kind: "table",
    columns,
    foreignKeys: [],
    indexes: [],
    rowEstimate: null,
  };
}

describe("optimistic row mutation SQL", () => {
  it("uses a version column instead of copying every original field", () => {
    const users = table([
      { name: "id", dataType: "integer", nullable: false, pk: true },
      { name: "email", dataType: "text", nullable: false, pk: false },
      { name: "version", dataType: "integer", nullable: false, pk: false },
    ]);

    expect(
      buildUpdate(
        "postgres",
        users,
        { id: "7" },
        { email: "next@example.com" },
        { id: "7", email: "before@example.com", version: "3" },
      ),
    ).toBe(
      'UPDATE "public"."users" SET "email" = \'next@example.com\' WHERE "id" = 7 AND "version" = 3',
    );
  });

  it("matches the original changed value when no version column exists", () => {
    const users = table([
      { name: "id", dataType: "integer", nullable: false, pk: true },
      { name: "display_name", dataType: "text", nullable: true, pk: false },
      { name: "email", dataType: "text", nullable: false, pk: false },
    ]);

    expect(
      buildUpdate(
        "postgres",
        users,
        { id: "7" },
        { display_name: "Ada" },
        { id: "7", display_name: null, email: "ada@example.com" },
      ),
    ).toBe(
      'UPDATE "public"."users" SET "display_name" = \'Ada\' WHERE "id" = 7 AND "display_name" IS NULL',
    );
  });

  it("pins a delete to every original non-primary-key value without a version column", () => {
    const users = table([
      { name: "id", dataType: "integer", nullable: false, pk: true },
      { name: "email", dataType: "text", nullable: false, pk: false },
      { name: "disabled_at", dataType: "timestamp", nullable: true, pk: false },
    ]);

    expect(
      buildDelete(
        "postgres",
        users,
        { id: "7" },
        { id: "7", email: "ada@example.com", disabled_at: null },
      ),
    ).toBe(
      'DELETE FROM "public"."users" WHERE "id" = 7 AND "email" = \'ada@example.com\' AND "disabled_at" IS NULL',
    );
  });
});
