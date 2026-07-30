import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { auth } from "../../../lib/auth";
import { isUuid } from "../../../lib/http";
import { Brand } from "../../components/Brand";
import {
  IdentityBody,
  IdentityCard,
  IdentityEyebrow,
  IdentitySingleShell,
  IdentityTitle,
} from "../../components/Identity";
import { AcceptInvitation } from "./AcceptInvitation";

export const dynamic = "force-dynamic";

export default async function InvitationPage({
  params,
}: {
  params: Promise<{ invitationId: string }>;
}) {
  const { invitationId } = await params;
  if (!isUuid(invitationId)) notFound();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    redirect(`/auth/sign-in?returnTo=${encodeURIComponent(`/accept-invitation/${invitationId}`)}`);
  }
  return (
    <IdentitySingleShell>
      <Brand />
      <div className="tw:m-auto tw:w-[min(540px,100%)]">
        <IdentityCard>
          <IdentityEyebrow>VERIFIED INVITATION</IdentityEyebrow>
          <IdentityTitle>워크스페이스 초대</IdentityTitle>
          <IdentityBody>
            {session.user.email} 계정으로 초대를 수락합니다. 초대 이메일과 로그인
            이메일이 일치해야 합니다.
          </IdentityBody>
          <AcceptInvitation
            invitationId={invitationId}
            currentUserId={session.user.id}
          />
        </IdentityCard>
      </div>
    </IdentitySingleShell>
  );
}
