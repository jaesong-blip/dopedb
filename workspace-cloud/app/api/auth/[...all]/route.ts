import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "../../../../lib/auth";
import {
  gcpCloudSetupCallbackResponse,
  isGcpCloudSetupCallback,
} from "../../../../lib/providers/gcp-cloud-oauth-callback";

export const runtime = "nodejs";
let resolvedHandlers: ReturnType<typeof toNextJsHandler> | undefined;

function handlers() {
  resolvedHandlers ??= toNextJsHandler(getAuth());
  return resolvedHandlers;
}

export async function GET(request: Request) {
  const path = new URL(request.url).pathname;
  if (
    path === "/api/auth/callback/google"
    && await isGcpCloudSetupCallback(request)
  ) {
    return gcpCloudSetupCallbackResponse(request);
  }
  return handlers().GET(request);
}

export function POST(request: Request) {
  return handlers().POST(request);
}
