// Memoized React Flow node for one Catalog V2 relation. Compact mode avoids mounting
// thousands of column rows for large schemas while the inspector keeps full metadata.
import { memo } from "react";
import {
  Handle,
  Position,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import type { CatalogRelationV2 } from "../ipc/types";
import { Icon } from "./Icon";
import { relationDisplayName } from "../lib/erdGraph";
import "./ErdRelationNode.css";

export type ErdRelationNodeData = {
  relation: CatalogRelationV2;
  compact: boolean;
};

export type ErdFlowNode = Node<ErdRelationNodeData, "relation">;

function ErdRelationNode({ data, selected }: NodeProps<ErdFlowNode>) {
  const { relation, compact } = data;
  const primaryColumns = new Set(
    relation.constraints
      .filter((constraint) => constraint.kind === "primary")
      .flatMap((constraint) => constraint.columns),
  );
  const foreignColumns = new Set(
    relation.constraints
      .filter((constraint) => constraint.kind === "foreign")
      .flatMap((constraint) => constraint.columns),
  );
  return (
    <article
      className={`erd-relation-node${selected ? " selected" : ""}${compact ? " compact" : ""}`}
      title={relationDisplayName(relation.object)}
    >
      <Handle
        className="erd-node-handle"
        type="target"
        position={Position.Left}
      />
      <header>
        <Icon
          name={
            relation.object.kind === "view" ||
            relation.object.kind === "materialized_view"
              ? "view"
              : "table"
          }
        />
        <strong>{relationDisplayName(relation.object)}</strong>
        {!compact && (
          <span className="muted">{relation.columns.length}</span>
        )}
      </header>
      {!compact && (
        <div className="erd-node-columns">
          {relation.columns.slice(0, 11).map((column) => (
            <div key={column.name}>
              <span>
                {primaryColumns.has(column.name) && <b>PK</b>}
                {foreignColumns.has(column.name) && <b>FK</b>}
                <code>{column.name}</code>
              </span>
              <em>{column.nativeType}</em>
            </div>
          ))}
          {relation.columns.length > 11 && (
            <small className="muted">+{relation.columns.length - 11}</small>
          )}
        </div>
      )}
      <Handle
        className="erd-node-handle"
        type="source"
        position={Position.Right}
      />
    </article>
  );
}

export default memo(ErdRelationNode);
