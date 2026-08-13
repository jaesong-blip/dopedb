// Optional Resend transport for Better Auth organization invitations. Deployments
// without provider credentials retain the verified, email-bound copy-link workflow.
import "server-only";

import { env } from "./env";
import { singleLineText } from "./http";
import {
  localizedWorkspacePath,
  workspaceLocaleFromCookieHeader,
} from "./workspace-locale";

interface InvitationEmailData {
  id: string;
  email: string;
  inviter: { user: { name: string; email: string } };
  organization: { name: string };
}

/**
 * Deliver a plain-text invitation when Resend is configured. Link-copy remains an
 * intentional fallback for self-hosted deployments without an email provider.
 * Recipient addresses and action-capable invitation URLs are never logged.
 */
export async function sendWorkspaceInvitation(
  data: InvitationEmailData,
  appOrigin: string,
  request?: Request,
) {
  const apiKey = env.resendApiKey();
  const from = env.workspaceInvitationFrom();
  if (!apiKey || !from) return;

  const locale = workspaceLocaleFromCookieHeader(
    request?.headers.get("cookie") ?? null,
  );
  const inviteUrl = `${appOrigin}${localizedWorkspacePath(
    `/accept-invitation/${encodeURIComponent(data.id)}`,
    locale,
  )}`;
  const organizationName = singleLineText(data.organization.name) || "DopeDB";
  const inviterName = singleLineText(data.inviter.user.name)
    || (locale === "ko" ? "워크스페이스 관리자" : "Workspace administrator");
  const inviterEmail = singleLineText(data.inviter.user.email);
  const subject = locale === "ko"
    ? `${organizationName} 워크스페이스 초대`
    : `Invitation to the ${organizationName} workspace`;
  const text = locale === "ko"
    ? [
        `${inviterName} (${inviterEmail})님이`,
        `${organizationName} 워크스페이스에 초대했습니다.`,
        "",
        `초대 수락: ${inviteUrl}`,
        "",
        "이 링크는 초대받은 Google 이메일로 로그인한 경우에만 사용할 수 있습니다.",
      ]
    : [
        `${inviterName} (${inviterEmail}) invited you`,
        `to the ${organizationName} workspace.`,
        "",
        `Accept invitation: ${inviteUrl}`,
        "",
        "This link only works when you sign in with the invited Google email address.",
      ];
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "idempotency-key": `workspace-invitation-${data.id}`,
    },
    body: JSON.stringify({
      from,
      to: [data.email],
      subject,
      text: text.join("\n"),
    }),
  });
  if (!response.ok) {
    throw new Error(`Invitation email delivery failed with status ${response.status}`);
  }
}
