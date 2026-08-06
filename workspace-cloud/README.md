# DopeDB Workspace Cloud

This is the authenticated web and API control plane for DopeDB workspaces. It is a
separate Next.js application intended for its own Vercel project at `app.dopedb.dev`;
the marketing `site/` deployment remains independent.

## Local setup

Copy `.env.example` to the ignored `workspace-cloud/.env.local` and provide the Neon
pooler/unpooled URLs, Google OAuth web client credentials, a Better Auth secret, the
exact Better Auth URL, and a random 32-byte base64url `WORKSPACE_CREDENTIAL_KEY`.
PlanetScale managed access additionally requires `PLANETSCALE_CLIENT_ID` and
`PLANETSCALE_CLIENT_SECRET`; Neon and GCP Cloud SQL do not add application
environment secrets. Set a separate random `CRON_SECRET` for the authenticated
credential-cleanup route. The committed one-minute schedule requires Vercel Pro or
Enterprise; do not deploy Neon managed access with a daily-only Hobby cron. Register
this PlanetScale callback:

```text
http://localhost:3000/api/v1/providers/planet-scale/callback
```

Configure the PlanetScale OAuth application with the minimum scopes used by the
managed-access flow: `read_organizations`, `read_databases`, `read_branches`,
`manage_passwords`, and `manage_production_branch_passwords`. The callback rejects a
grant missing any of them instead of leaving a partially working integration.

To deliver invitation email, also set `RESEND_API_KEY` and a
verified `WORKSPACE_INVITATION_FROM` sender; without them, the dashboard keeps the
email-bound copy-link fallback. Configure this Google redirect URI:

```text
http://localhost:3000/api/auth/callback/google
```

Then run `pnpm install` in this directory and `pnpm workspace:cloud:dev` from the repo
root. Generate/check migrations with `pnpm db:generate` and `pnpm db:check` here; apply
them through the unpooled URL with `pnpm workspace:migrate` from the repository root.
`pnpm build` intentionally succeeds without production secrets: database and auth
clients resolve configuration on the first request, where missing values fail closed.
Production Vercel builds run that migration before the Next.js build; a migration
failure stops the deployment instead of serving code against an older control-plane
schema.

## Neon managed access

1. Create a **project-scoped organization API key** in Neon when the project belongs
   to an organization. Neon does not currently publish a third-party OAuth client
   registration contract for this use case. A personal key also works, but the UI
   identifies its wider account blast radius and never calls this fallback one-click.
2. In Workspace settings, choose Neon, enter the key and optional organization ID,
   and select project → branch → database. Protected branches are always production;
   default or otherwise unclassified branches require an Admin/Owner classification.
3. Run the read-only preflight. It returns redacted finding codes and exact before/after
   descriptions for the selected database, other database `PUBLIC CONNECT`, allowed
   schema creation, ownership, current/future object grants, public
   `SECURITY DEFINER` functions, and DopeDB marker/lease-role drift. Raw ACL SQL and
   owner credentials never reach the browser.
4. Review and explicitly approve any `PUBLIC` ACL changes and, independently, any
   production target. DopeDB applies only the sealed plan hash. Approved statements
   run transactionally, their exact inverse is retained for rollback, and a changed
   target forces a new preflight instead of silently broadening the plan.
5. DopeDB independently revalidates the Provider target and database boundary. A
   temporary read role must read successfully and fail to write. A separate temporary
   write role operates only on an owner-created disposable probe table: INSERT, UPDATE,
   and DELETE must succeed while DDL and role management must fail. DopeDB removes both
   roles and the probe before it issues the short-lived import receipt. A failed
   verification rolls back approved ACL changes. Cleanup or rollback ambiguity becomes
   a redacted `bootstrap_needs_repair` audit event rather than Ready.

The automatic plan may revoke database `CREATE`/`TEMPORARY`, allowed-schema
`PUBLIC CREATE`, and other databases' `PUBLIC CONNECT`; these can affect existing
clients and therefore never run without the dedicated approval. Ownership conflicts,
ungrantable objects, public access outside the schema allowlist, public object writes,
and public `SECURITY DEFINER` functions remain blockers for a DBA or a dedicated
development branch. The UI deliberately provides no arbitrary SQL/setup terminal.
Reserved provider schemas (`neon`, `neon_auth`, `pg_*`, and
`information_schema`) cannot be selected.

Imported Neon connections always begin read-only, including explicitly approved
production targets. Successful bootstrap records that a separately gated write
credential was verified, but neither import nor production approval enables writes.
A current Admin/Owner must later turn on the DB-specific write policy, and the member
must still have the workspace write capability and connection grant. Database numeric
ID and display name are stored separately, so a rename cannot silently redirect
authority to a different database. Every new lease rechecks that stable ID, branch
readiness, environment classification, owner boundary, current object ACL, and
future/default privileges.

DopeDB retrieves an owner connection only on the server and creates a unique login
role with a 15-minute password validity. The role receives only `CONNECT` plus
current/default table and sequence privileges in the explicit schema allowlist
(`public` by default). It does not use the Neon API role endpoint because API-created
roles inherit `neon_superuser`.

The API key is envelope-encrypted at rest and never returned. Disconnecting DopeDB
scrubs its encrypted copy; it intentionally does not delete a customer-owned Neon key
that another integration might use. The integration identity is derived from the
current Neon user/organization and a fingerprint of exactly the accessible project
IDs, so rotating a key with the same scope updates one integration while a narrower
project key remains separate. Revoke an unused key in Neon.

Role passwords are sent to PostgreSQL only as client-generated SCRAM-SHA-256
verifiers. The desktop uses the direct Neon endpoint, limits the two leased pools to
four combined connections, and closes them 30 seconds before expiry. The authenticated
Vercel cron independently commits `NOLOGIN`, terminates remaining sessions, and removes
expired roles. Vercel cron scheduling is not an exact timer, so the documentation does
not treat password `VALID UNTIL` alone as a hard session-expiry boundary.

## GCP Cloud SQL managed access

GCP uses keyless federation. Do not create or upload a JSON service-account key, and
do not copy a project number, WIF coordinate, or service-account identity into a
browser form.

1. A workspace Admin or Owner chooses **Google Cloud 연결** and approves the Google
   OAuth request. The short-lived setup grant is held only for this bootstrap session.
2. DopeDB lists the approved account's projects and runnable Cloud SQL instances. The
   admin selects one project and instance, classifies an unlabeled environment, and
   explicitly approves production access or a required database restart.
3. DopeDB checks the exact Google permissions needed for setup. If the account can
   grant them, the UI shows the missing roles and requires one explicit approval before
   applying them. Otherwise the UI reports the missing permissions without pretending
   the connection is ready.
4. The server enables the required APIs, creates the instance-scoped Workload Identity
   Pool/provider plus separate dedicated read and write service accounts, applies the
   narrow IAM bindings, enables Cloud SQL IAM authentication when approved, creates
   both IAM database users, and grants each its database-side least privilege. Imported
   connections still start with `allowWrites: false`; provisioning a dormant write
   principal does not authorize any workspace member to use it.
5. The completed integration stores only keyless trust coordinates and encrypted
   Provider authorization needed for rotation. Google login tokens, service-account
   keys, and database passwords are never copied into a shared connection or returned
   to the browser.

The OAuth account must be able to enumerate projects and Cloud SQL and, when one-click
setup is requested, enable services, manage the dedicated service account and IAM
policy, update the selected instance, and manage its IAM database user. The setup UI
shows the permission diff before making those changes. Existing resources are
revalidated and reused by deterministic identity; a partially completed setup can be
retried without adding duplicate principals.

At lease time Vercel OIDC is exchanged through GCP STS and IAM Credentials for
15-minute `sqlservice.login` and connector tokens. They reach only the native desktop
process. The app starts the pinned Google Cloud SQL Auth Proxy from its signed bundle,
binds it to a random loopback port for that pool, and gives the database driver the IAM
login token. The connector owns instance authorization and TLS, so Public IP no longer
requires each member machine to be added to Authorized Networks. Private services
access and Private Service Connect still require an existing resolvable network path
from that machine; the connector cannot create VPC reachability.

When an admin selects an existing member-local shared connection during a receipt-bound
provider import, the service converts that connection in place instead of creating a
second template. Its connection UUID, grants, dashboards, and history references remain
stable; the content and authority revisions advance atomically, and the next desktop
sync removes obsolete member-local credential references from that device. Personal
workspaces do not issue managed credentials. Local GCP ADC is created by Google tooling
and can only verify member-local access for an existing team-workspace integration.

Cloud SQL instances explicitly labeled `environment=prod` or
`environment=production` may be imported only by a current workspace Admin/Owner after
the production warning is accepted. The approval bit is bound to the idempotent import
hash and recorded in the redacted audit event. Missing or unrecognized environment
labels remain fail-closed and cannot be imported. Production approval and write policy
are independent: import never enables writes. A current Admin/Owner may later change
the DB's durable `allowWrites` policy; only members whose current role is Editor,
Admin, or Owner and whose connection grant is `use` or `manage` can receive a write
lease. Analyst and Viewer access remains read-only in both production and non-production.

The tokens are not revocable, so access changes wait for bounded expiry and the desktop
drops both pool and connector 30 seconds early. Pool eviction prevents new app work but
is not a protocol-level kill switch for an already checked-out connection; the
database's own statement/session limits remain the final bound for a query already
running. Client-certificate-required instances are supported through the connector
rather than by issuing or storing a long-lived client certificate in DopeDB.

Reconnecting the same project and instance rotates the server-generated trust and
dedicated service account in place. The server first gates new leases, drains existing
credentials, then atomically replaces hash-only global principal claims so a service
account cannot be reused by another integration. Selecting a different dedicated
instance creates a separate integration; move its connections before disconnecting the
old one.
GCP managed connections saved before the explicit network-path field was introduced
are intentionally not leased. A workspace admin must reconnect and re-import the
instance so current discovery supplies the exact path; the server does not guess a path
for legacy records.

## Shared dashboard definitions

Team-workspace dashboards synchronize as secret-free definitions. The hosted contract
contains the workspace connection id, title, description, SQL, visualization, lifecycle
state, owner/updater membership ids, and an optimistic revision. It intentionally has
no result-row, parameter-value, credential, connection URL, or local query-history
field. Results are always obtained by DopeDB Desktop through the member's current local
credential binding or short-lived managed lease and stay on that device.

The collection endpoint is
`/api/v1/workspaces/:workspaceId/dashboards`; item and immutable revision endpoints are
under `/:dashboardId` and `/:dashboardId/revisions`. Creates require `If-Match: "0"`;
updates, publish/archive, restore, ownership transfer, and deletion require the exact
quoted current revision. Every mutation atomically rechecks the live session,
membership role, source-connection grant, tenant boundary, and revision before writing
the current projection, an immutable history row, and a redacted audit event. A stale
definition update creates a separately owned conflict-copy draft instead of overwriting
either version. Infrastructure failures remain server errors and are never reported as
ordinary revision conflicts.

The web management surface can inspect definitions and history, publish or archive,
restore a previous definition as a new draft revision, and transfer ownership to a
current Editor/Admin/Owner. It does not execute SQL. Desktop synchronizes connections
before dashboards, keeps local dirty/conflict state, refuses to run archived
definitions, and reuses the existing read-only dashboard safety boundary for execution.

## Trust boundary

- Better Auth owns Google login, sessions, organizations, invitations, rate limits, and
  RFC 8628 device authorization; the app does not maintain a parallel auth system.
- Database hooks clear Google access, refresh, and ID tokens before account persistence.
- Better Auth Multi Session keeps at most ten browser identities available without
  merging their users or organization memberships. The active identity is explicit.
- Desktop sign-in uses a ten-minute, single-use device code and a Better Auth Bearer
  session. Sessions expire after 30 days with a one-day refresh age, and the desktop
  stores each account in a separate operating-system credential item.
- All application queries use Drizzle ORM; all schema changes use committed Drizzle Kit
  migrations.
- Application-owned server logging has one categorical sink. The root build rejects
  direct runtime `console`/stdout/stderr and alternate exception sinks under
  `workspace-cloud/app` and `workspace-cloud/lib`. Provider setup and managed-lease
  failures retain only closed provider/stage/status/error-kind values; requests,
  responses, SQL, identifiers, result rows, credentials, certificates, and raw error
  messages never cross that sink.
- Member-local target-database credentials never enter this service. In optional
  managed mode, reusable PlanetScale OAuth or Neon API authorization is AES-256-GCM
  encrypted with record-bound AAD before database persistence; GCP stores only
  non-secret WIF coordinates and service-account identities. The envelope key is held
  separately in deployment configuration.
- Managed target-database credentials are generated per member with a 15-minute TTL,
  returned once to an authenticated native Bearer client, and never inserted into the
  service database, audit stream, browser UI, or desktop store. The TTL bounds leaked
  credential value; it does not expire the durable role/grant/write policy. The desktop
  retires the pool before expiry and automatically obtains a new credential while that
  live authority remains unchanged.
- Every new managed lease enters a fresh Provider-authority gate before any database
  credential creation call. The complete pre-issuance authority sequence has a
  45-second fail-closed deadline, so there is no application-side periodic polling
  window: once the Provider exposes unsafe drift to an uncached validation, the next
  lease request is denied within that gate or times out without invoking credential
  creation. Provider-internal propagation remains outside DopeDB's clock. Credentials
  already delivered remain bounded by their actual Provider expiry of at most 15
  minutes, while the desktop retires its pool earlier when workspace authority changes.
- Managed lease POSTs must send
  `x-dopedb-managed-lease-contract: access-v2` and an explicit `read` or `write`
  access mode. The service returns HTTP 426 to legacy clients instead of guessing
  their authority. Deploy this control-plane change immediately before the matching
  desktop release; managed access is intentionally fail-closed during that window.
- Desktop pool retirement calls the exact tenant/user/connection/lease DELETE
  boundary for early provider revocation. Natural provider expiry and the durable
  cleanup worker remain the fallback when the desktop is offline.
- New lease rows retain the validated, redacted Provider resource audit id beside the
  opaque DopeDB lease id. Issue, early revoke, scheduled cleanup, and deferred cleanup
  events carry both identifiers plus the non-secret external credential id, so an
  operator can reconcile Provider and workspace audit trails without opening a token
  or password. Cleanup state changes and their system-authored audit events commit in
  one database statement. Legacy rows keep a null Provider audit id rather than using
  a guessed backfill.
- Shared connection rows contain endpoint metadata, safety defaults, credential mode,
  the administrator-owned write policy, and a redacted provider-resource selector. Usernames,
  passwords, tokens, certificates, connection URLs, SQLite paths, advanced parameters,
  and desktop `secret_ref` values are rejected or absent from the hosted schema.
- Workspace metadata backups are canonical secretless snapshots: they include workspace
  lifecycle metadata and shared connection templates only, never provider OAuth tokens,
  target-database credentials, local secret references, query/result rows, certificates,
  or URLs with embedded credentials. A random 256-bit workspace data-encryption key (DEK)
  seals each snapshot with AES-256-GCM and AAD bound to the workspace and opaque backup id.
  Only the Cloud KMS-wrapped DEK is durable. The plaintext DEK exists in request memory for
  the envelope operation and is zeroized before return. Backups created by the former
  backup-only HKDF v1 domain remain readable until an Owner rotation re-encrypts them.
- KMS authentication is keyless. A Vercel Function request receives an
  `x-vercel-oidc-token`, exchanges it through the configured GCP Workload Identity Federation
  provider, and impersonates a dedicated service account with encrypt/decrypt access scoped
  to the configured CryptoKey. JSON service-account keys and reusable Google credentials are
  not accepted by the application. A rotation creates a new wrapped DEK version, processes
  every live and tombstoned backup in resumable bounded batches, and erases the retired
  wrapped DEK only after no backup references it. PostgreSQL permits ciphertext mutation only
  under the active, unexpired Owner rotation claim.
- A backup restore is additive and conflict-preserving, not a silent rollback. Existing
  connection ids retain the current server projection while the restored candidate is
  recorded as an immutable conflict branch; a new opaque conflict id is the only client
  handle. Backup create/list/restore/delete require the server-side Admin/Owner `manage`
  capability and each action writes a redacted audit event.
- Shared connection writes require a quoted `If-Match` revision (`"0"` for a new row).
  A stale offline update or delete never overwrites the current projection: the server
  persists its redacted candidate plus parent/base revision and returns HTTP 409 with an
  opaque conflict id. Connection version history is append-only at the database boundary.
- Admin/Owner can create, resend, and cancel Better Auth invitations; remove members;
  and assign Viewer (metadata only), Analyst (read-only), Editor (read/write through
  local safety gates), or Admin roles. Resend delivers email when configured, while the
  settings page always exposes a copyable, email-bound invitation link.
- A signed-in user with a verified Google email automatically accepts every live
  invitation for that exact email on the next workspace read. Better Auth still
  performs the recipient, expiry, role, membership-limit, and state-transition checks.
- Shared database execution uses a fresh server authorization check. Cached desktop role
  data is for presentation and fail-closed prechecks, not the final permission decision.
- Role downgrade, member removal, provider disconnect, and managed-mode changes attempt
  immediate provider credential revocation where supported. Neon additionally uses
  lazy and scheduled role cleanup because PostgreSQL `VALID UNTIL` does not terminate
  existing sessions. GCP IAM login tokens cannot be revoked, so GCP access changes wait
  for token expiry while the desktop closes its leased pools early.
- Identity, membership, invitation, and connection API responses are private `no-store`
  payloads and are covered by restrictive browser security headers.

## Backup API contract

All endpoints are under `/api/v1/workspaces/:workspaceId/backups`, require an active
server-verified Admin/Owner membership, and return `private, no-store` responses. `GET /`
lists only backup metadata (`id`, source revision, key reference/version, hash, timestamp);
`POST /` creates a ciphertext-only snapshot; `DELETE /:backupId` creates a retention
tombstone; and `POST /:backupId/restore` requires a quoted `If-Match` workspace revision.
`GET /key-rotation` returns only version/count/progress metadata. Owner-only
`POST /key-rotation` requires an opaque UUID `requestId`, resumes an interrupted rotation,
and is idempotent after a lost response. Repeated POSTs advance bounded batches until the
response reports `completed`; key material and ciphertext are never returned.
Neither successful nor failed responses contain provider grants, target credentials,
envelope ciphertext, decrypted snapshot data, or database result rows.

## Workspace lifecycle contract

Only the current Owner can inspect or mutate
`/api/v1/workspaces/:workspaceId/lifecycle`. Scheduling requires the exact current
workspace name and an opaque UUID that also becomes the durable deletion receipt.
The final locked mutation refuses to schedule while a provider integration, live
credential lease, unfinished or repair-required provider operation, key rotation, or
member revocation claim remains. A successful schedule immediately suspends every
member and clears that workspace from active sessions; all ordinary workspace APIs
then fail closed. The matching Owner may still open the lifecycle boundary and cancel
before the fixed seven-day deadline. Cancellation resumes only member markers written
by that exact schedule and is idempotent after a lost response.

The authenticated cron hard-purges deleted backup tombstones after seven days and
processes due workspace deletions in bounded batches. Final workspace purge is one
database transaction that rechecks the receipt, deadline, live credentials, Provider
state, rotations, and revocation claims before removing backups, wrapped data keys,
and the organization. It leaves only a payload-free receipt containing opaque ids,
timestamps, actor id when the account still exists, and terminal status. The SQL purge
function is not executable by `PUBLIC`; there is no browser endpoint for immediate
hard deletion.

Production must define `WORKSPACE_KMS_KEY_NAME`, `WORKSPACE_KMS_WIF_AUDIENCE`, and
`WORKSPACE_KMS_SERVICE_ACCOUNT_EMAIL`. The WIF provider must accept only the immutable
Vercel project/team/environment claims for this production deployment. Grant its principal
`roles/iam.workloadIdentityUser` on the dedicated service account, and grant that service
account `roles/cloudkms.cryptoKeyEncrypterDecrypter` on the single backup CryptoKey rather
than at project scope.

## Security references

- [Better Auth Organization](https://better-auth.com/docs/plugins/organization) for
  invitations, verified-email acceptance, custom roles, and server-side membership.
- [OWASP Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)
  for least privilege, deny-by-default, per-request checks, and authorization tests.
- [OWASP Secrets Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)
  for credential minimization, fine-grained access, non-logging, rotation, and revocation.
- [PostgreSQL role membership](https://www.postgresql.org/docs/current/role-membership.html)
  for the independent target-database privilege boundary.
- [Neon API authentication](https://api-docs.neon.tech/reference/authentication) for
  key types and project-scoped organization keys.
- [Neon current-user organizations](https://api-docs.neon.tech/reference/getcurrentuserorganizations)
  for identity resolution that also supports organization and project-scoped keys.
- [PostgreSQL CREATE ROLE](https://www.postgresql.org/docs/current/sql-createrole.html)
  for SCRAM verifiers and the password-only semantics of `VALID UNTIL`.
- [Vercel Cron security](https://vercel.com/docs/cron-jobs/manage-cron-jobs) for
  `CRON_SECRET` Bearer authentication and scheduling limitations.
- [Vercel OIDC for GCP](https://vercel.com/docs/oidc/gcp) and
  [Vercel OIDC claims](https://vercel.com/docs/oidc/reference) for the exact
  production-project trust condition, and
  [GCP Workload Identity Federation](https://docs.cloud.google.com/iam/docs/workload-identity-federation)
  for keyless service-account impersonation.
- [Cloud SQL IAM database authentication](https://docs.cloud.google.com/sql/docs/postgres/iam-authentication)
  for login roles, instance flags, database users, and database-level grants.
- [Cloud SQL IAM Conditions](https://docs.cloud.google.com/sql/docs/postgres/iam-conditions)
  for instance-scoped role bindings, and
  [Cloud SQL TLS identity verification](https://docs.cloud.google.com/sql/docs/postgres/configure-ssl-instance)
  for CA-mode and DNS requirements.
