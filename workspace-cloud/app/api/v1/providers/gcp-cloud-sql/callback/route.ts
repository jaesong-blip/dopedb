// Kept as a narrow compatibility endpoint; current OAuth uses the already
// registered Better Auth Google callback and dispatches by one-use setup state.
import { gcpCloudSetupCallbackResponse } from "../../../../../../lib/providers/gcp-cloud-oauth-callback";

export const GET = gcpCloudSetupCallbackResponse;
