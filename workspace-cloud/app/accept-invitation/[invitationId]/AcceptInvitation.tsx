// Verified invitation acceptance with a multi-account escape hatch. Users can switch
// to an already signed-in identity or add the Google account that received the invite.
"use client";

import { useState } from "react";
import {
  IdentityError,
  IdentityPrimaryButton,
  IdentitySecondaryLink,
} from "../../components/Identity";
import { authClient } from "../../../lib/auth-client";
import { useDeviceAccounts } from "../../../lib/useDeviceAccounts";

export function AcceptInvitation({
  invitationId,
  currentUserId,
}: {
  invitationId: string;
  currentUserId: string;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const { accounts, error: accountError } = useDeviceAccounts();

  async function accept() {
    setPending(true);
    setError("");
    const result = await authClient.organization.acceptInvitation({ invitationId });
    if (result.error) {
      setPending(false);
      setError(result.error.message ?? "초대를 수락하지 못했습니다.");
      return;
    }
    window.location.assign("/settings");
  }

  async function switchAccount(sessionToken: string) {
    setPending(true);
    const result = await authClient.multiSession.setActive({ sessionToken });
    if (result.error) {
      setPending(false);
      setError(result.error.message ?? "계정을 전환하지 못했습니다.");
      return;
    }
    window.location.reload();
  }

  return (
    <>
      <IdentityPrimaryButton onClick={accept} disabled={pending}>
        {pending ? "수락 중…" : "워크스페이스 참여"}
        <span>→</span>
      </IdentityPrimaryButton>
      {accounts.length > 1 ? (
        <div className="tw:mt-4 tw:grid tw:border-t tw:border-border">
          <small className="tw:px-0 tw:pt-3 tw:pb-2 tw:text-2xs tw:text-muted-foreground">
            다른 계정으로 받은 초대인가요?
          </small>
          {accounts.filter((account) => account.user.id !== currentUserId).map((account) => (
            <button
              className="tw:flex tw:min-h-control-field tw:cursor-pointer tw:items-center tw:justify-between tw:gap-3 tw:border-0 tw:border-b tw:border-border tw:bg-transparent tw:px-2 tw:text-foreground tw:hover:bg-surface-raised tw:disabled:cursor-wait tw:disabled:opacity-[var(--ds-disabled-opacity)]"
              type="button"
              key={account.user.id}
              onClick={() =>
                void switchAccount(account.sessions[0].session.token)
              }
              disabled={pending}
            >
              <span>{account.user.name}</span>
              <small className="tw:text-muted-foreground">
                {account.user.email}
              </small>
            </button>
          ))}
        </div>
      ) : null}
      <IdentitySecondaryLink
        href={`/auth/sign-in?returnTo=${encodeURIComponent(`/accept-invitation/${invitationId}`)}`}
      >
        다른 Google 계정 추가
      </IdentitySecondaryLink>
      {error ? <IdentityError>{error}</IdentityError> : null}
      {!error && accountError ? (
        <IdentityError>{accountError}</IdentityError>
      ) : null}
    </>
  );
}
