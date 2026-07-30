// Account selector for RFC 8628 approval. It prevents “add account” on desktop from
// silently re-authorizing whichever browser identity happened to be active.
"use client";

import { useState } from "react";
import { authClient } from "../../../lib/auth-client";
import { useDeviceAccounts } from "../../../lib/useDeviceAccounts";

export function DeviceAccountActions({
  currentUserId,
  userCode,
}: {
  currentUserId: string;
  userCode: string;
}) {
  const { accounts, error: accountError } = useDeviceAccounts();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const returnTo = `/auth/device?user_code=${encodeURIComponent(userCode)}`;

  async function switchAccount(sessionToken: string) {
    setPending(true);
    setError("");
    const result = await authClient.multiSession.setActive({ sessionToken });
    if (result.error) {
      setPending(false);
      setError(result.error.message ?? "계정을 전환하지 못했습니다.");
      return;
    }
    location.assign(returnTo);
  }

  return (
    <div className="tw:mt-2 tw:grid tw:border-t tw:border-border">
      {accounts.filter((account) => account.user.id !== currentUserId).map((account) => (
        <button
          className="tw:flex tw:min-h-control-md tw:cursor-pointer tw:items-center tw:justify-between tw:gap-3 tw:border-0 tw:border-b tw:border-border tw:bg-transparent tw:px-3 tw:text-xs tw:text-foreground tw:hover:bg-surface-raised tw:disabled:cursor-wait tw:disabled:opacity-[var(--ds-disabled-opacity)]"
          type="button"
          key={account.user.id}
          onClick={() => void switchAccount(account.sessions[0].session.token)}
          disabled={pending}
        >
          <span>{account.user.name}</span>
          <small className="tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap tw:text-muted-foreground">
            {account.user.email}
          </small>
        </button>
      ))}
      <a
        className="tw:flex tw:min-h-control-md tw:items-center tw:border-b tw:border-border tw:px-3 tw:text-xs tw:text-muted-foreground tw:hover:bg-surface-raised tw:hover:text-foreground"
        href={`/auth/sign-in?returnTo=${encodeURIComponent(returnTo)}`}
      >
        ＋ 다른 Google 계정으로 승인
      </a>
      {error ? (
        <small className="tw:mt-2 tw:text-2xs tw:text-danger" role="alert">
          {error}
        </small>
      ) : null}
      {!error && accountError ? (
        <small className="tw:mt-2 tw:text-2xs tw:text-danger" role="alert">
          {accountError}
        </small>
      ) : null}
    </div>
  );
}
