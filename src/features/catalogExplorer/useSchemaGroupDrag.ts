import { useMemo, useRef, useState, type PointerEvent } from "react";

import type {
  ConnectionId,
  ConnectionProfile,
} from "../connections/domain";
import { setConnectionsSchemaGroup } from "../connections/tauriAdapter";
import { isDocumentEngine } from "../../lib/capabilities";
import { useI18n } from "../../lib/i18n";
import {
  buildConnectionSections,
  type SchemaConnectionGroup,
} from "../../lib/schemaDiff";
import { errMessage } from "../../ipc/types";
import { useToast } from "../../components/Toast";
import {
  fallbackSchemaGroupName,
  type DropTarget,
} from "./catalogDomain";

type DragStart = {
  id: string;
  pointerId: number;
  x: number;
  y: number;
};

export function useSchemaGroupDrag(
  connections: ConnectionProfile[],
  onConnectionUpdated: (connection: ConnectionProfile) => void,
) {
  const { t } = useI18n();
  const toast = useToast();
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [dragPreview, setDragPreview] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const dragStartRef = useRef<DragStart | null>(null);
  const activeDragIdRef = useRef<string | null>(null);
  const suppressClickRef = useRef(false);
  const sections = useMemo(
    () => buildConnectionSections(connections),
    [connections],
  );
  const groupByConnectionId = useMemo(() => {
    const map = new Map<string, SchemaConnectionGroup>();
    for (const section of sections) {
      if (section.kind !== "group") continue;
      for (const connection of section.group.connections) {
        map.set(connection.id, section.group);
      }
    }
    return map;
  }, [sections]);

  const connectionById = (id: string) =>
    connections.find((connection) => connection.id === id) ?? null;
  const schemaGroupByKey = (key: string) => {
    for (const section of sections) {
      if (section.kind === "group" && section.group.key === key) {
        return section.group;
      }
    }
    return null;
  };

  function canDropOnConnection(
    dragId: string | null,
    target: ConnectionProfile,
  ) {
    const dragged = dragId ? connectionById(dragId) : null;
    return (
      !!dragged &&
      dragged.id !== target.id &&
      dragged.engine === target.engine &&
      !isDocumentEngine(dragged.engine)
    );
  }

  function canDropOnGroup(
    dragId: string | null,
    group: SchemaConnectionGroup,
  ) {
    const dragged = dragId ? connectionById(dragId) : null;
    const engine = group.connections[0]?.engine;
    return (
      !!dragged &&
      !!engine &&
      dragged.engine === engine &&
      !isDocumentEngine(dragged.engine) &&
      !group.connections.some((connection) => connection.id === dragged.id)
    );
  }

  async function saveGroup(ids: ConnectionId[], schemaGroup: string) {
    const originals = ids
      .map((id) => connectionById(id))
      .filter((connection): connection is ConnectionProfile => !!connection);
    for (const id of ids) {
      const original = connectionById(id);
      if (original) onConnectionUpdated({ ...original, schemaGroup });
    }
    try {
      const saved = await setConnectionsSchemaGroup(ids, schemaGroup);
      saved.forEach(onConnectionUpdated);
    } catch (error) {
      originals.forEach(onConnectionUpdated);
      throw error;
    }
  }

  async function applyDrop(dragId: string, target: DropTarget) {
    const dragged = connectionById(dragId);
    if (!dragged) return;
    if (target.kind === "connection") {
      const destination = connectionById(target.id);
      if (!destination || !canDropOnConnection(dragged.id, destination)) return;
      const destinationGroup = destination.schemaGroup?.trim();
      const draggedGroup = dragged.schemaGroup?.trim();
      const group =
        destinationGroup ||
        draggedGroup ||
        fallbackSchemaGroupName(dragged, destination, connections);
      const ids = [
        ...(draggedGroup === group ? [] : [dragged.id]),
        ...(destinationGroup === group ? [] : [destination.id]),
      ];
      if (
        ids.length === 0 ||
        !window.confirm(
          t("connections.schemaGroupConfirmPair", {
            source: dragged.name || dragged.database || t("app.unnamed"),
            target:
              destination.name || destination.database || t("app.unnamed"),
            group,
          }),
        )
      ) {
        return;
      }
      try {
        await saveGroup(ids, group);
        toast(t("connections.schemaGroupUpdated"));
      } catch (error) {
        toast(errMessage(error), "error");
      }
      return;
    }

    const group = schemaGroupByKey(target.key);
    if (
      !group ||
      !canDropOnGroup(dragged.id, group) ||
      dragged.schemaGroup?.trim() === group.label ||
      !window.confirm(
        t("connections.schemaGroupConfirmGroup", {
          connection: dragged.name || dragged.database || t("app.unnamed"),
          group: group.label,
        }),
      )
    ) {
      return;
    }
    try {
      await saveGroup([dragged.id], group.label);
      toast(t("connections.schemaGroupUpdated"));
    } catch (error) {
      toast(errMessage(error), "error");
    }
  }

  function dropTargetFromPoint(
    dragId: string,
    x: number,
    y: number,
  ): DropTarget | null {
    const element = document.elementFromPoint(x, y);
    if (!(element instanceof HTMLElement)) return null;
    const targetConnectionId = element.closest<HTMLElement>(
      "[data-connection-id]",
    )?.dataset.connectionId;
    if (targetConnectionId) {
      const target = connectionById(targetConnectionId);
      if (target && canDropOnConnection(dragId, target)) {
        return { kind: "connection", id: target.id };
      }
    }
    const targetGroupKey = element.closest<HTMLElement>(
      "[data-schema-group-key]",
    )?.dataset.schemaGroupKey;
    if (targetGroupKey) {
      const group = schemaGroupByKey(targetGroupKey);
      if (group && canDropOnGroup(dragId, group)) {
        return { kind: "group", key: group.key };
      }
    }
    return null;
  }

  function clearDrag() {
    dragStartRef.current = null;
    activeDragIdRef.current = null;
    setDraggingId(null);
    setDropTarget(null);
    setDragPreview(null);
  }

  function pointerDown(
    event: PointerEvent<HTMLDivElement>,
    connection: ConnectionProfile,
  ) {
    if (
      event.button !== 0 ||
      (event.target instanceof HTMLElement &&
        !!event.target.closest(
          "button,input,select,textarea,a,summary,details,.db-menu",
        ))
    ) {
      return;
    }
    dragStartRef.current = {
      id: connection.id,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    const start = dragStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    if (
      !activeDragIdRef.current &&
      Math.hypot(event.clientX - start.x, event.clientY - start.y) < 6
    ) {
      return;
    }
    if (!activeDragIdRef.current) {
      activeDragIdRef.current = start.id;
      suppressClickRef.current = true;
      setDraggingId(start.id);
    }
    event.preventDefault();
    setDragPreview({ id: start.id, x: event.clientX, y: event.clientY });
    const next = dropTargetFromPoint(start.id, event.clientX, event.clientY);
    setDropTarget((current) =>
      sameDropTarget(current, next) ? current : next,
    );
  }

  function pointerUp(event: PointerEvent<HTMLDivElement>) {
    const activeId = activeDragIdRef.current;
    const target = activeId
      ? dropTargetFromPoint(activeId, event.clientX, event.clientY)
      : null;
    if (dragStartRef.current?.pointerId === event.pointerId) {
      try {
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      } catch {
        // Pointer capture may already be released.
      }
    }
    clearDrag();
    if (activeId) {
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    }
    if (activeId && target) void applyDrop(activeId, target);
  }

  function pointerCancel(event: PointerEvent<HTMLDivElement>) {
    if (dragStartRef.current?.pointerId === event.pointerId) {
      try {
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      } catch {
        // Pointer capture may already be released.
      }
    }
    clearDrag();
  }

  return {
    sections,
    groupByConnectionId,
    draggingId,
    dropTarget,
    dragPreview,
    suppressClickRef,
    pointerDown,
    pointerMove,
    pointerUp,
    pointerCancel,
  };
}

function sameDropTarget(
  left: DropTarget | null,
  right: DropTarget | null,
) {
  if (left === null || right === null) return left === right;
  if (left.kind !== right.kind) return false;
  return left.kind === "connection"
    ? left.id === (right as { kind: "connection"; id: string }).id
    : left.key === (right as { kind: "group"; key: string }).key;
}
