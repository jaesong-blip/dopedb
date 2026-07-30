"use client";

import { useState } from "react";
import {
  IdentityError,
  IdentityPrimaryButton,
} from "../../components/Identity";
import { authClient } from "../../../lib/auth-client";

export function SignInButton({ returnTo }: { returnTo: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function signIn() {
    setPending(true);
    setError("");
    const result = await authClient.signIn.social({
      provider: "google",
      callbackURL: returnTo,
      errorCallbackURL: `/auth/sign-in?error=oauth_failed&returnTo=${encodeURIComponent(returnTo)}`,
    });
    if (result.error) {
      setPending(false);
      setError(result.error.message ?? "Google 로그인을 시작하지 못했습니다.");
    }
  }

  return (
    <>
      <IdentityPrimaryButton onClick={signIn} disabled={pending}>
        <span className="tw:grid tw:size-6 tw:place-items-center tw:rounded-full tw:bg-[var(--ds-white)] tw:font-[Arial] tw:text-[13px] tw:font-bold tw:text-[var(--ds-google-blue)]">
          G
        </span>
        <span>{pending ? "Google로 이동 중…" : "Google로 계속"}</span>
        <span aria-hidden="true">↗</span>
      </IdentityPrimaryButton>
      {error ? <IdentityError>{error}</IdentityError> : null}
    </>
  );
}
