import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "../../../../lib/auth";
import {
  gcpCloudSetupCallbackResponse,
  isGcpCloudSetupCallback,
} from "../../../../lib/providers/gcp-cloud-oauth-callback";

export const runtime = "nodejs";
const handlers = toNextJsHandler(auth);

export async function GET(request: Request) {
  const path = new URL(request.url).pathname;
  if (
    path === "/api/auth/callback/google"
    && await isGcpCloudSetupCallback(request)
  ) {
    return gcpCloudSetupCallbackResponse(request);
  }
  return handlers.GET(request);
}

export const POST = handlers.POST;
