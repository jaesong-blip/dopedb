/** Prevent browsers and intermediary caches from retaining identity-scoped payloads. */
export function privateJson(data: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "private, no-store");
  return Response.json(data, { ...init, headers });
}

export function jsonError(message: string, status: number) {
  return privateJson({ error: message }, { status });
}

export function mutationAllowed(request: Request, appOrigin: string) {
  if (request.headers.get("authorization")?.startsWith("Bearer ")) return true;
  return request.headers.get("origin") === appOrigin;
}

/** Reads one JSON request without trusting Content-Length or buffering forever. */
export async function boundedJsonBody(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !request.body) {
    return { ok: false };
  }
  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader !== null) {
    if (!/^\d+$/.test(lengthHeader) || Number(lengthHeader) > maxBytes) {
      await request.body.cancel().catch(() => undefined);
      return { ok: false };
    }
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      ok: true,
      value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    };
  } catch {
    await reader.cancel().catch(() => undefined);
    return { ok: false };
  }
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);
}

export function isSafeDisplayText(value: string, maxLength: number): boolean {
  return value.length > 0
    && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(value);
}

export function singleLineText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function safeReturnTo(value: string | null, fallback = "/settings"): string {
  if (!value?.startsWith("/") || value.startsWith("//")) return fallback;
  try {
    const decoded = decodeURIComponent(value);
    if (
      decoded.startsWith("//") ||
      decoded.includes("\\") ||
      /[\u0000-\u001f\u007f]/.test(decoded)
    ) {
      return fallback;
    }
    const base = "https://return.dopedb.invalid";
    const target = new URL(value, base);
    if (target.origin !== base) return fallback;
    // OAuth callbacks are server requests, so browser-only fragments cannot be
    // round-tripped and Better Auth rejects them as callback URLs.
    return `${target.pathname}${target.search}`;
  } catch {
    return fallback;
  }
}
