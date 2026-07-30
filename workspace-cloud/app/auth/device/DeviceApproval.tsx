"use client";

import { useState } from "react";
import {
  IdentityError,
  IdentityPrimaryButton,
  IdentitySecondaryButton,
} from "../../components/Identity";
import { authClient } from "../../../lib/auth-client";

export function DeviceApproval({ userCode }: { userCode: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function approve() {
    setPending(true);
    setError("");
    const result = await authClient.device.approve({ userCode });
    if (result.error) {
      setPending(false);
      setError(result.error.error_description ?? "기기를 승인하지 못했습니다.");
      return;
    }
    window.location.assign("/auth/device/complete");
  }

  async function deny() {
    setPending(true);
    const result = await authClient.device.deny({ userCode });
    if (result.error) {
      setPending(false);
      setError(result.error.error_description ?? "요청을 거절하지 못했습니다.");
      return;
    }
    window.location.assign("/auth/device/complete?denied=1");
  }

  return (
    <>
      <IdentityPrimaryButton onClick={approve} disabled={pending}>
        {pending ? "처리 중…" : "이 계정으로 기기 승인"}
        <span>→</span>
      </IdentityPrimaryButton>
      <IdentitySecondaryButton onClick={deny} disabled={pending}>
        거절
      </IdentitySecondaryButton>
      {error ? <IdentityError>{error}</IdentityError> : null}
    </>
  );
}
