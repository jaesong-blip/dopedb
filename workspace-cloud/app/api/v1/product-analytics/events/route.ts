// Anonymous first-party product outcome ingestion. The application service owns
// schema validation, rate limiting, and the allowlisted relay destination.
import { boundedJsonBody, privateJson } from "../../../../../lib/http";
import { env } from "../../../../../lib/env";
import {
  acceptsProductAnalyticsContract,
  consumeProductAnalyticsEnvelopeBudget,
  consumeProductAnalyticsIngressBudget,
  parseProductAnalyticsEnvelope,
  relayProductAnalytics,
} from "../../../../../lib/product-analytics";

const MAX_BODY_BYTES = 32 * 1_024;
const RETRY_AFTER_SECONDS = 60;
const RETRY_AFTER_MS = RETRY_AFTER_SECONDS * 1_000;

function terminalError(error: string, status: number) {
  return privateJson(
    { accepted: false, error, retryable: false },
    { status },
  );
}

function retryableError(error: string, status: 429 | 503) {
  return privateJson(
    { accepted: false, error, retryable: true, retryAfterMs: RETRY_AFTER_MS },
    {
      status,
      headers: { "retry-after": String(RETRY_AFTER_SECONDS) },
    },
  );
}

export async function POST(request: Request) {
  try {
    if (!env.productAnalyticsRelayEnabled()) {
      return retryableError("Product analytics relay unavailable", 503);
    }
  } catch {
    return retryableError("Product analytics relay unavailable", 503);
  }
  try {
    if (!await consumeProductAnalyticsIngressBudget(request.headers)) {
      return retryableError("Too many requests", 429);
    }
  } catch {
    return retryableError("Product analytics relay unavailable", 503);
  }
  if (!acceptsProductAnalyticsContract(request.headers)) {
    return terminalError("Unsupported product analytics contract", 400);
  }
  const mediaType = request.headers.get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    return terminalError("Content-Type must be application/json", 415);
  }
  const parsed = await boundedJsonBody(request, MAX_BODY_BYTES);
  if (!parsed.ok) {
    return terminalError(
      parsed.reason === "too_large"
        ? "Product analytics batch is too large"
        : "Invalid product analytics batch",
      parsed.reason === "too_large" ? 413 : 400,
    );
  }
  const envelope = parseProductAnalyticsEnvelope(parsed.value);
  if (!envelope) return terminalError("Invalid product analytics batch", 400);

  try {
    if (!await consumeProductAnalyticsEnvelopeBudget(
      envelope.installationId,
      envelope.events.length,
    )) {
      return retryableError("Too many requests", 429);
    }
  } catch {
    return retryableError("Product analytics relay unavailable", 503);
  }

  const relay = await relayProductAnalytics(envelope);
  if (relay === "accepted") {
    return privateJson({ accepted: true, retryable: false }, { status: 202 });
  }
  if (relay === "not_configured" || relay === "retryable_failure") {
    return retryableError("Product analytics relay unavailable", 503);
  }
  // A deliberate upstream contract rejection is distinct from a transient
  // gateway-generated 502. Desktop may permanently discard only this 422.
  return terminalError("Product analytics relay rejected the batch", 422);
}
