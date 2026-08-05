"use client";

import { useState } from "react";
import {
  IdentityError,
  IdentityPrimaryButton,
  IdentitySecondaryButton,
} from "../../components/Identity";
import { authClient } from "../../../lib/auth-client";
import { localizedWorkspacePath } from "../../../lib/workspace-locale";
import { workspaceMessages } from "../../../lib/workspace-messages";
import { localizedProviderMessage } from "../../../lib/workspace-provider-copy";
import { useWorkspaceLocale } from "../../components/WorkspaceLocale";

export function DeviceApproval({ userCode }: { userCode: string }) {
  const locale = useWorkspaceLocale();
  const copy = workspaceMessages[locale].device;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function approve() {
    setPending(true);
    setError("");
    const result = await authClient.device.approve({ userCode });
    if (result.error) {
      setPending(false);
      setError(result.error.error_description
        ? localizedProviderMessage(
            result.error.error_description,
            locale,
            copy.approveError,
          )
        : copy.approveError);
      return;
    }
    window.location.assign(localizedWorkspacePath("/auth/device/complete", locale));
  }

  async function deny() {
    setPending(true);
    const result = await authClient.device.deny({ userCode });
    if (result.error) {
      setPending(false);
      setError(result.error.error_description
        ? localizedProviderMessage(
            result.error.error_description,
            locale,
            copy.denyError,
          )
        : copy.denyError);
      return;
    }
    window.location.assign(localizedWorkspacePath("/auth/device/complete?denied=1", locale));
  }

  return (
    <>
      <IdentityPrimaryButton onClick={approve} disabled={pending}>
        {pending ? copy.approving : copy.approve}
        <span>→</span>
      </IdentityPrimaryButton>
      <IdentitySecondaryButton onClick={deny} disabled={pending}>
        {copy.deny}
      </IdentitySecondaryButton>
      {error ? <IdentityError>{error}</IdentityError> : null}
    </>
  );
}
