// Memoized React Flow node for one Catalog V2 relation. Compact mode avoids mounting
// thousands of column rows for large schemas while the inspector keeps full metadata.
import { memo } from "react";
import {
  Handle,
  Position,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import type { CatalogRelationV2 } from "../../ipc/types";
import { Icon } from "../../components/Icon";
import { relationDisplayName } from "../../lib/erdGraph";

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
      data-selected={selected}
      data-compact={compact}
      className="tw:w-[272px] tw:overflow-hidden tw:rounded-sm tw:border tw:border-border-subtle tw:bg-card tw:text-foreground tw:shadow-panel tw:data-[selected=true]:border-primary tw:data-[selected=true]:ring-2 tw:data-[selected=true]:ring-primary/20"
      title={relationDisplayName(relation.object)}
    >
      <Handle
        className="erd-node-handle"
        type="target"
        position={Position.Left}
      />
      <header
        data-compact={compact}
        className="tw:flex tw:min-h-[56px] tw:items-center tw:gap-2 tw:border-b tw:border-border-subtle tw:px-3 tw:data-[compact=true]:border-b-0"
      >
        <Icon
          className="tw:shrink-0 tw:text-muted-foreground"
          name={
            relation.object.kind === "view" ||
            relation.object.kind === "materialized_view"
              ? "view"
              : "table"
          }
        />
        <strong className="tw:min-w-0 tw:flex-1 tw:overflow-hidden tw:text-ui tw:text-ellipsis tw:whitespace-nowrap">
          {relationDisplayName(relation.object)}
        </strong>
        {!compact && (
          <span className="tw:text-muted-foreground">
            {relation.columns.length}
          </span>
        )}
      </header>
      {!compact && (
        <div className="tw:grid tw:px-3 tw:py-2">
          {relation.columns.slice(0, 11).map((column) => (
            <div
              key={column.name}
              className="tw:flex tw:h-6 tw:min-w-0 tw:items-center tw:justify-between tw:gap-2 tw:text-xs"
            >
              <span className="tw:flex tw:min-w-0 tw:items-center tw:gap-1">
                {primaryColumns.has(column.name) && (
                  <b className="tw:text-2xs tw:text-primary">PK</b>
                )}
                {foreignColumns.has(column.name) && (
                  <b className="tw:text-2xs tw:text-primary">FK</b>
                )}
                <code className="tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap">
                  {column.name}
                </code>
              </span>
              <em className="tw:max-w-[44%] tw:min-w-0 tw:shrink tw:overflow-hidden tw:text-muted-foreground tw:not-italic tw:text-ellipsis tw:whitespace-nowrap">
                {column.nativeType}
              </em>
            </div>
          ))}
          {relation.columns.length > 11 && (
            <small className="tw:h-6 tw:leading-6 tw:text-muted-foreground">
              +{relation.columns.length - 11}
            </small>
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
