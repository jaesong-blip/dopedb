import "server-only";

import {
  createHmac,
  hkdfSync,
  timingSafeEqual,
} from "node:crypto";

import { env } from "./env";
import { decodeEnvelopeKey } from "./secret-envelope-core";

const MARKER_VERSION = "v1";

function markerKey() {
  return Buffer.from(hkdfSync(
    "sha256",
    decodeEnvelopeKey(env.credentialKey()),
    Buffer.alloc(0),
    Buffer.from("dopedb:provider-operation-ownership:v1", "utf8"),
    32,
  ));
}

function markerPayload(input: {
  organizationId: string;
  integrationId: string;
  integrationGeneration: bigint;
  operationId: string;
  planHash: string;
}) {
  return [
    MARKER_VERSION,
    input.organizationId,
    input.integrationId,
    input.integrationGeneration.toString(),
    input.operationId,
    input.planHash,
  ].join("\n");
}

export function providerOperationOwnershipMarker(input: {
  organizationId: string;
  integrationId: string;
  integrationGeneration: bigint;
  operationId: string;
  planHash: string;
}) {
  if (
    input.integrationGeneration < 1n
    || !/^[0-9a-f]{64}$/.test(input.planHash)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(input.operationId)
  ) {
    throw new Error("Invalid provider operation marker context");
  }
  const key = markerKey();
  try {
    const signature = createHmac("sha256", key)
      .update(markerPayload(input), "utf8")
      .digest("base64url");
    return `${MARKER_VERSION}.${signature}`;
  } finally {
    key.fill(0);
  }
}

export function verifyProviderOperationOwnershipMarker(
  input: Parameters<typeof providerOperationOwnershipMarker>[0] & { marker: string },
) {
  if (!/^v1\.[A-Za-z0-9_-]{43}$/.test(input.marker)) return false;
  const expected = providerOperationOwnershipMarker(input);
  const left = Buffer.from(input.marker, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
