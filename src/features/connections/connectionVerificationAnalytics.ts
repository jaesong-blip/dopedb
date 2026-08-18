// Captures one privacy-bounded connection verification terminal without exposing
// host, database, user, error detail, or credentials to product analytics.
import type { useCatalogScope } from "../../lib/queries";

import { captureProductEvent } from "../productAnalytics/client";
import {
  productAnalyticsConnectionEngine,
  productAnalyticsCredentialMode,
  productAnalyticsWorkspaceContext,
} from "../productAnalytics/outcomes";
import type { ConnectionProfile } from "./domain";
import { CONNECTION_SSH_ALIAS_PARAMETER } from "./options";

export function connectionVerificationRecorder(
  scope: ReturnType<typeof useCatalogScope>,
  profile: ConnectionProfile,
): (outcome: "success" | "failed") => void {
  const context = productAnalyticsWorkspaceContext(scope);
  const dedupeId = crypto.randomUUID();
  const engine = productAnalyticsConnectionEngine(profile.engine);
  const credentialMode = profile.engine === "sqlite"
    ? "none"
    : productAnalyticsCredentialMode(profile.credentialMode);
  const ssh = profile.engine !== "sqlite"
    && Boolean(profile.extraParams[CONNECTION_SSH_ALIAS_PARAMETER]?.trim());
  return (outcome) => {
    if (!context) return;
    void captureProductEvent({
      name: "connection_verification_completed",
      dedupeId,
      context,
      properties: { outcome, engine, credentialMode, ssh },
    });
  };
}
