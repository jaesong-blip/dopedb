// Exact command envelope accepted by the Neon branch-operation HTTP boundary.
// Keeping this parser separate lets the application service consume a closed
// command union without knowing about Request or response primitives.
import { isUuid } from "../http";

export type NeonBranchOperationCommand =
  | Readonly<{ action: "planCreate"; request: unknown }>
  | Readonly<{
    action: "decideCreate";
    operationId: string;
    planHash: string;
    decision: "approved" | "rejected";
  }>
  | Readonly<{
    action: "executeCreate";
    operationId: string;
    planHash: string;
  }>
  | Readonly<{ action: "planDelete"; request: unknown }>
  | Readonly<{
    action: "decideDelete";
    operationId: string;
    planHash: string;
    decision: "approved" | "rejected";
  }>
  | Readonly<{
    action: "executeDelete";
    operationId: string;
    planHash: string;
  }>
  | Readonly<{ action: "planSwitch"; request: unknown }>
  | Readonly<{
    action: "decideSwitch";
    operationId: string;
    planHash: string;
    decision: "approved" | "rejected";
  }>
  | Readonly<{
    action: "executeSwitch";
    operationId: string;
    planHash: string;
  }>;

export function parseNeonBranchOperationCommand(
  value: unknown,
): NeonBranchOperationCommand | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (
    (body.action === "planCreate"
      || body.action === "planDelete"
      || body.action === "planSwitch")
    && Object.keys(body).length === 2
    && Object.prototype.hasOwnProperty.call(body, "request")
  ) {
    return { action: body.action, request: body.request };
  }
  if (
    (body.action === "decideCreate"
      || body.action === "decideDelete"
      || body.action === "decideSwitch")
    && Object.keys(body).length === 4
    && Object.prototype.hasOwnProperty.call(body, "operationId")
    && Object.prototype.hasOwnProperty.call(body, "planHash")
    && Object.prototype.hasOwnProperty.call(body, "decision")
    && typeof body.operationId === "string"
    && isUuid(body.operationId)
    && typeof body.planHash === "string"
    && /^[0-9a-f]{64}$/.test(body.planHash)
    && (body.decision === "approved" || body.decision === "rejected")
  ) {
    return {
      action: body.action,
      operationId: body.operationId,
      planHash: body.planHash,
      decision: body.decision,
    };
  }
  if (
    (body.action === "executeCreate"
      || body.action === "executeDelete"
      || body.action === "executeSwitch")
    && Object.keys(body).length === 3
    && Object.prototype.hasOwnProperty.call(body, "operationId")
    && Object.prototype.hasOwnProperty.call(body, "planHash")
    && typeof body.operationId === "string"
    && isUuid(body.operationId)
    && typeof body.planHash === "string"
    && /^[0-9a-f]{64}$/.test(body.planHash)
  ) {
    return {
      action: body.action,
      operationId: body.operationId,
      planHash: body.planHash,
    };
  }
  return null;
}
