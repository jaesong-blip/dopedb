/** Dialect-neutral structured schema-editor contracts. */

import type {
  CatalogConstraint,
  CatalogIndex,
  CatalogObjectRef,
  Engine,
} from "../../ipc/types";

declare const schemaOperationIdBrand: unique symbol;

export type SchemaOperationId = string & {
  readonly [schemaOperationIdBrand]: "SchemaOperationId";
};

export interface DdlColumnDefinition {
  name: string;
  nativeType: string;
  nullable: boolean;
  defaultExpression?: string | null;
  generatedExpression?: string | null;
  identity?: boolean;
  autoIncrement?: boolean;
  collation?: string | null;
  comment?: string | null;
}

export type DdlDefaultChange =
  | { action: "keep" }
  | { action: "drop" }
  | { action: "set"; expression: string };

export interface DdlColumnAlteration {
  newName?: string | null;
  nativeType?: string | null;
  nullable?: boolean | null;
  default: DdlDefaultChange;
}

export type SchemaChange =
  | {
      kind: "create_table";
      table: {
        relation: CatalogObjectRef;
        columns: DdlColumnDefinition[];
        constraints: CatalogConstraint[];
        indexes: CatalogIndex[];
        comment?: string | null;
      };
    }
  | { kind: "drop_table"; relation: CatalogObjectRef }
  | { kind: "rename_table"; relation: CatalogObjectRef; newName: string }
  | {
      kind: "add_column";
      relation: CatalogObjectRef;
      column: DdlColumnDefinition;
    }
  | {
      kind: "alter_column";
      relation: CatalogObjectRef;
      column: string;
      alteration: DdlColumnAlteration;
    }
  | { kind: "drop_column"; relation: CatalogObjectRef; column: string }
  | {
      kind: "add_constraint";
      relation: CatalogObjectRef;
      constraint: CatalogConstraint;
    }
  | { kind: "drop_constraint"; relation: CatalogObjectRef; name: string }
  | { kind: "create_index"; relation: CatalogObjectRef; index: CatalogIndex }
  | { kind: "drop_index"; relation: CatalogObjectRef; name: string };

export interface SchemaChangeRequest {
  schemaVersion: 1;
  catalogFingerprint: string;
  change: SchemaChange;
}

export interface DdlPlan {
  schemaVersion: number;
  engine: Engine;
  catalogFingerprint: string;
  statements: string[];
  transactional: boolean;
  requiresRebuild: boolean;
  warnings: string[];
}

export interface SchemaChangeProposal {
  operationId: SchemaOperationId;
  payloadHash: string;
  state: string;
  confirmationPhrase: string | null;
  statementCount: number;
  expiresAt: string;
  plan: DdlPlan;
}
