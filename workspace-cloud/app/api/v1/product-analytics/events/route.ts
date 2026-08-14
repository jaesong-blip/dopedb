// Anonymous first-party product outcome ingestion. The application service owns
// schema validation, rate limiting, and the allowlisted relay destination.
import { boundedJsonBody, jsonError, privateJson } from "../../../../../lib/http";
import {
  consumeProductAnalyticsBudget,
  parseProductAnalyticsEnvelope,
  relayProductAnalytics,
} from "../../../../../lib/product-analytics";

const MAX_BODY_BYTES = 32 * 1_024;
const RETRY_AFTER_SECONDS = 60;

function retryableUnavailable() {
  return privateJson(
    { error: "Product analytics relay unavailable", retryable: true },
    {
      status: 503,
      headers: { "retry-after": String(RETRY_AFTER_SECONDS) },
    },
  );
}

export async function POST(request: Request) {
  const mediaType = request.headers.get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    return jsonError("Content-Type must be application/json", 415);
  }
  const parsed = await boundedJsonBody(request, MAX_BODY_BYTES);
  if (!parsed.ok) {
    return jsonError(
      parsed.reason === "too_large"
        ? "Product analytics batch is too large"
        : "Invalid product analytics batch",
      parsed.reason === "too_large" ? 413 : 400,
    );
  }
  const envelope = parseProductAnalyticsEnvelope(parsed.value);
  if (!envelope) return jsonError("Invalid product analytics batch", 400);

  try {
    if (!await consumeProductAnalyticsBudget(request.headers, envelope.installationId)) {
      return privateJson(
        { error: "Too many requests", retryable: true },
        {
          status: 429,
          headers: { "retry-after": String(RETRY_AFTER_SECONDS) },
        },
      );
    }
  } catch {
    return retryableUnavailable();
  }

  const relay = await relayProductAnalytics(envelope);
  if (relay === "accepted") {
    return privateJson({ accepted: true }, { status: 202 });
  }
  if (relay === "not_configured" || relay === "retryable_failure") {
    return retryableUnavailable();
  }
  return privateJson(
    { error: "Product analytics relay rejected the batch", retryable: false },
    { status: 502 },
  );
}
