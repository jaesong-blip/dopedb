# DopeDB product analytics

Status: canonical tracking plan, effective 2026-08-14.

This document owns the purpose, consent boundary, event vocabulary, identity
rules, retention, and operating procedure for DopeDB product analytics. The
desktop, first-party relay, PostHog project, privacy policy, and analysis queries
must follow it. Product analytics is an operator capability; it does not create a
user-facing Funnel Analysis product domain. Product reporting may be presented
through the existing Analysis Article domain.

## Decision and purpose

DopeDB measures whether people can reach a useful outcome inside the product's
three boundaries:

1. connect to an exact database grant;
2. let a member or Agent complete bounded work inside that grant; and
3. make the access or result safely reusable by a workspace.

The data may be used only to improve onboarding, reliability, activation,
retention, and the shared-access workflow. It must not be used for advertising,
cross-site profiling, employee evaluation, credit or eligibility decisions,
general-purpose AI training, or reconstructing a customer's database or source
code.

Counts are diagnostic. They do not justify weakening an approval, grant,
credential, masking, or retention boundary.

## Three separate measurement systems

Do not join these systems by silently copying identifiers between them.

| System | Purpose | Current boundary |
| --- | --- | --- |
| Vercel Web Analytics on `dopedb.dev` | Aggregate public page, download, and workspace CTA flow | Automatic website measurement with `Download Clicked` and `Workspace Opened`; no Desktop installation identifier |
| Sentry Desktop diagnostics | Investigate sanitized production renderer failures and allowlisted Agent-plugin failures | Error diagnostics only; no product funnel events, replay, tracing, logs, breadcrumbs, default PII, request, user, free-form message, or customer payload |
| Desktop product analytics | Measure explicitly approved product outcomes | Explicit opt-in, closed schema, first-party relay, PostHog EU, no autocapture or person profiles |

Website activity and Desktop activation are reported as separate aggregate
stages. A download click must not carry a visitor identifier into an installer,
and the Desktop installation identifier must not be sent back to Vercel Web
Analytics.

## Consent contract

Desktop product analytics is optional and fail-closed.

- `pending` and `denied` mean no product event is created, queued, or sent and no
  analytics installation identifier exists.
- The app may create the random installation identifier and bounded retry queue
  only after the user explicitly selects `Allow product analytics`.
- Consent is local to that Desktop installation. Signing in, joining a workspace,
  accepting terms, or an administrator's choice does not grant it.
- Revoking consent stops collection immediately and deletes the queued events and
  local installation identifier. Opting in again creates a new installation and
  session identifier; neither identifier is reused. Team `actorKey` and
  `workspaceKey` are deliberately stable pseudonyms, however, so separately
  consented team events can still be grouped by account or workspace.
- A release-time feature flag and a configured relay are additional kill
  switches, not substitutes for user consent.
- Sentry error diagnostics and public-site Vercel Analytics are separate systems
  and must be described separately wherever the product analytics choice is
  shown.

The consent control must state the categories below, link to the privacy policy,
and be available again in Settings. There is no preselected checkbox, dark
pattern, or degraded core product when consent is refused.

## Identity and session rules

The wire envelope is schema version 1 and contains only:

- `installationId`: a random UUID created locally after opt-in; PostHog uses it as
  `distinct_id` with `$process_person_profile: false`;
- `sessionId`: a fresh random UUID for one app process/session;
- `eventId`: a 64-character domain-separated SHA-256 key derived from a stable
  receipt UUID when available, or from a fresh random nonce and event context;
  PostHog uses it as `$insert_id` for idempotency;
- `appVersion`, `platform` (`macos`, `windows`, `linux`, or `unknown`), and locale
  (`en` or `ko`);
- an optional 64-character pseudonymous `actorKey` and `workspaceKey`, plus
  `workspaceKind` (`personal` or `team`), only where the event dictionary allows
  them; and
- one event name with its exact closed property object.

Raw account, workspace, connection, session, article, or database identifiers
must not leave the Desktop in a product-analytics envelope. `actorKey` is a
one-way, domain-separated hash of the applicable account UUID. A team
`workspaceKey` is the equivalent projection of the workspace UUID; a Personal
Workspace key is instead derived from the random installation ID so different
people do not collapse onto the reserved Personal Workspace UUID. These values
are pseudonymous, not anonymous, and must never be exposed in product UI,
support tickets, or public reports.

Identity requirements are structural:

- `desktop_installation_ready` carries no actor or workspace key;
- unsuccessful authentication carries neither key; successful authentication
  carries only `actorKey`;
- Personal Workspace events carry `workspaceKey` and `workspaceKind=personal`,
  but no `actorKey`;
- team workspace events carry both keys and `workspaceKind=team`; and
- `workspace_member_joined` is valid only for a team workspace.

The first-party relay must reject an unknown field, raw UUID where a hash is
required, invalid identity combination, invalid enum, duplicate event ID inside a
batch, event older than seven days, or event more than five minutes in the future.

## Data that is never collected

The following values are prohibited in the event name, properties, identifier,
URL, log, retry key, or vendor context:

- SQL, query text or fragments, query hashes derived from content, parameters,
  DDL, filter or pipeline expressions;
- database results, rows, cells, documents, charts, article evidence, or result
  fragments;
- database, host, connection, schema, table, column, collection, project, or
  Environment names;
- credentials, passwords, tokens, cookies, certificates, connection URLs, secret
  references, provider response bodies, or keychain data;
- Agent prompts, messages, attachments, tool inputs or outputs, transcripts,
  provider error messages, or ACP payloads;
- repository owner/name/identifier, ref, commit, source code, graph content, local
  folder, file path, export path, or CLI path;
- email address, display name, workspace or organization name, invitation address,
  or raw product UUID;
- source IP, full user agent, hostname, OS account, device serial, MAC address, or
  hardware fingerprint; and
- raw errors, stack traces, request/response bodies, local tracing output, or
  product audit records.

Sentry may receive the separately documented sanitized exception type, stack
structure/code location, app release, runtime, component name chain, and closed
Agent-plugin failure tags. Sentry data must never be copied into product
analytics.

## Event dictionary

There are exactly 15 v1 product events. A caller cannot add properties beyond the
listed object. `completed` means one terminal outcome is emitted after the owning
operation finishes; it is not an event for every intermediate UI click.

| Event | Emit only when | Exact properties | Identity |
| --- | --- | --- | --- |
| `desktop_installation_ready` | After explicit opt-in and successful Desktop bootstrap; once per installation identity | No properties | Installation only |
| `workspace_authentication_completed` | A device authentication attempt reaches a terminal result; success only after the account credential is durably accepted | `outcome`: `success`, `denied`, `expired`, `failed` | Success: actor only; otherwise installation only |
| `workspace_scope_ready` | The selected Personal or team workspace has a usable local projection, including an explicitly deferred sync | `syncState`: `ok`, `deferred` | Workspace context |
| `knowledge_environment_created` | The Environment creation transaction commits | `creationKind`: `project_default`, `additional` | Workspace context |
| `connection_verification_completed` | Test Connection reaches a terminal result | `outcome`: `success`, `failed`; `engine`: `postgres`, `mysql`, `sqlite`, `mongodb`; `credentialMode`: `local`, `managed`, `none`; `ssh`: boolean | Workspace context |
| `environment_connection_bound` | A connection revision is durably bound to an Environment | `accessMode`: `local`, `managed`; `engine`: `postgres`, `mysql`, `sqlite`, `mongodb` | Workspace context |
| `query_execution_completed` | An exact-grant query operation reaches a terminal result | `outcome`: `success`, `failed`, `cancelled`, `unknown`; `statementClass`: `select`, `explain`, `show`, `other_read`, `write`, `script`; `rowCountBucket`: `zero`, `one`, `2_10`, `11_100`, `101_1000`, `over_1000`, `unknown`; `durationBucket`: shared duration enum; `approvalRequired`: boolean | Workspace context |
| `knowledge_source_sync_completed` | A GitHub or Local Folder Knowledge synchronization reaches a terminal result | `outcome`: `success`, `failed`; `sourceKind`: `github`, `local_folder`; `syncReason`: `initial`, `manual`, `webhook`, `scheduled` | Workspace context |
| `agent_session_initialization_completed` | The official ACP adapter initialization reaches a terminal result | `outcome`: `success`, `failed`; `provider`: `claude`, `codex` | Workspace context |
| `agent_turn_completed` | One ACP user turn reaches a terminal result | `outcome`: `success`, `failed`, `cancelled`; `provider`: `claude`, `codex`; `durationBucket`: shared duration enum | Workspace context |
| `analysis_article_proposal_completed` | An Agent-proposed Analysis Article draft either passes or fails the closed proposal validation | `outcome`: `success`, `failed` | Workspace context |
| `analysis_article_run_completed` | An exact-source article run reaches a terminal result | `outcome`: `success`, `failed`, `cancelled`, `stale`; `trigger`: `manual`, `scheduled`, `agent_test`; `durationBucket`: shared duration enum | Workspace context |
| `analysis_article_state_transitioned` | A durable lifecycle transaction changes an article to a different state | `fromState`, `toState`: `draft`, `review`, `live`, `archived`; values must differ | Workspace context |
| `workspace_member_joined` | A team membership is accepted and visible in the workspace | `role`: `viewer`, `analyst`, `editor`, `admin`, `owner` | Team workspace context |
| `shared_connection_access_ready` | A member successfully obtains an exact usable local binding or short-lived managed lease for a shared connection | `accessMode`: `local`, `managed`; `engine`: `postgres`, `mysql`, `sqlite`, `mongodb` | Workspace context |

The shared duration enum is `under_100ms`, `100ms_1s`, `1s_10s`, `10s_60s`,
`over_60s`, or `unknown`. Counts and durations remain bucketed; no raw SQL length,
exact row count, exact duration, or error text is allowed.

## North Star and funnels

The North Star follows `PRODUCT_POSITIONING.md`:

> **Weekly activated workspaces** — the number of distinct pseudonymous
> workspaces in a calendar week with a successful verified connection and at
> least one successful bounded member query, Agent turn, or Analysis Article
> run.

Count a workspace at most once per week. Segment only by `workspaceKind` and
other closed properties when the resulting cohort is large enough to avoid
singling out one customer. Total event volume is not the North Star.

The canonical aggregate funnels are:

1. **Public acquisition, reported separately:** Vercel page view -> `Download
   Clicked`. Do not person-join it to Desktop.
2. **First value:** `desktop_installation_ready` -> successful
   `workspace_authentication_completed` when sign-in is chosen ->
   `workspace_scope_ready` -> successful `connection_verification_completed` ->
   `environment_connection_bound` -> successful `query_execution_completed`.
   Personal/local use may omit authentication.
3. **Agent and knowledge value:** `workspace_scope_ready` -> successful
   `knowledge_source_sync_completed` -> successful
   `agent_session_initialization_completed` -> successful `agent_turn_completed`
   -> successful `analysis_article_proposal_completed` -> successful
   `analysis_article_run_completed` -> transition to `review` or `live`.
4. **Team sharing:** team `workspace_scope_ready` -> `workspace_member_joined` ->
   `shared_connection_access_ready` -> one successful bounded query, Agent turn,
   or article run.

Time-to-value is computed from event timestamps only in buckets or aggregates.
Seven-day return is a repeat weekly activated workspace, not a copy of query or
session content. Report opt-in coverage beside every rate; never present a
consenting subset as all users.

Guardrails are connection-verification failure rate, query cancellation/failure
rate, approval-required share, Agent initialization failure rate, Analysis Article
stale/failure rate, relay rejection rate, and consent revocation rate. A guardrail
may trigger investigation but must not expose the underlying customer payload.

## First-party relay and PostHog EU

The Desktop posts to the first-party
`/api/v1/product-analytics/events` control-plane route. The route does not require
authentication so pre-auth activation can be measured, but it accepts only the
v1 schema. It:

- accepts JSON bodies no larger than 32 KiB and batches of 1–20 events;
- rate-limits a hash of transport client key plus installation ID;
- keeps the original source IP out of the analytics envelope and PostHog payload;
- does not persist a raw analytics event in the workspace database;
- sends only the validated projection to `https://eu.i.posthog.com/batch/`;
- sets `$process_person_profile: false` and uses `eventId` as `$insert_id`;
- uses no browser or Desktop PostHog SDK, autocapture, cookies, session replay,
  heatmaps, surveys, feature flags, or remote configuration; and
- fails closed with a retryable response when the relay is unconfigured or
  unavailable.

Vercel may process the inbound request and its IP as hosting/security data. That
transport metadata remains outside the PostHog event and is governed by the
separate hosting-log boundary.

## Retention and access

- The local retry queue holds at most 100 events and discards events older than
  seven days. It exists only while consent is granted.
- The first-party relay does not persist raw analytics.
- Raw events in PostHog EU must be configured to expire no later than 12 months
  after collection. A shorter period is preferred while the product is alpha.
- Only aggregate, non-identifying weekly/monthly counts may be retained beyond
  the raw-event period. Long-term aggregates must contain no installation,
  session, event, actor, or workspace key and no cohort small enough to identify
  a customer.
- Access to PostHog is limited to the operator and specifically authorized
  maintainers. Exporting raw events into spreadsheets, issue trackers, support
  tools, or Analysis Articles is prohibited.
- PostHog data is not merged into the workspace audit log, Neon account records,
  Sentry issues, Vercel visitor profiles, or Agent memory.

## Operations and deletion runbook

Before enabling production collection:

1. Create or verify an EU-region PostHog project and set raw retention to 365 days
   or less.
2. Disable person profiles, autocapture, replay, surveys, remote flags, and every
   capture source except the first-party server batch endpoint.
3. Set `PRODUCT_ANALYTICS_POSTHOG_HOST` to exactly
   `https://eu.i.posthog.com` and store `PRODUCT_ANALYTICS_POSTHOG_KEY` only in the
   protected workspace-cloud environment.
4. Enable the Desktop release flag only after the consent UI, local reset, schema
   checks, privacy policy, and QA gates below pass.
5. Send one synthetic event, inspect its complete PostHog payload, delete it, and
   record the project region and retention review in the release evidence.

Emergency stop: unset either PostHog relay variable or disable the Desktop release
flag. The relay must return a retryable failure rather than acknowledge and drop a
batch. Do not loosen validation to restore analytics availability.

Consent revocation is the user-facing local deletion path: it deletes the pending
queue and installation identity immediately. A later opt-in starts new
installation and session identifiers. For team events, stable pseudonymous actor
and workspace keys remain groupable unless matching vendor data is also deleted
through the process below.

For an access or deletion request:

1. Verify the requester's authority. For pseudonymous Desktop data, ask the
   requester to contact support before resetting the current installation
   identifier. DopeDB keeps no account-to-installation mapping and may be unable
   to locate old events after the local identifier is deleted.
2. Search only the EU PostHog project for that installation identifier and, where
   applicable and authorized, its pseudonymous actor/workspace keys.
3. Use PostHog's deletion workflow for matching raw events and identifiers, then
   verify completion. There is no product-analytics row to delete from Neon.
4. Handle Vercel website analytics and Sentry diagnostics as separate provider
   requests; never infer their identities from the PostHog installation ID.
5. Record only the request, verification, provider job reference, completion, and
   any legally required retention exception. Do not copy deleted event payloads
   into the request record.

## QA and change control

Every release that changes analytics must verify:

- pending/denied consent creates no installation ID, queue entry, or network
  request;
- granting consent creates an ID only after the action, and revoking deletes the
  ID and queue immediately;
- re-granting creates an unlinkable ID;
- each of the 15 events accepts only its exact properties and identity shape;
- unknown events/properties, raw UUID identity keys, forbidden fields, stale
  timestamps, duplicate event IDs, oversized bodies/batches, and invalid enums are
  rejected at Desktop and server boundaries;
- Personal, team, authentication, and member identity rules fail closed;
- a relay configuration other than the PostHog EU origin is rejected;
- the captured PostHog payload contains no IP, raw account, workspace, or
  customer identifier, free-form string, error, URL, SQL, prompt, path, customer
  name, or vendor autocaptured property;
- retry is bounded, opt-out clears retries, and product work continues when
  analytics is unavailable;
- Sentry, Vercel site analytics, workspace audit, and local tracing cannot enter
  the PostHog projection;
- the EN and KO privacy text describe the same implemented paths; and
- Site TypeScript/build checks reject event names or properties outside the
  current `Download Clicked` and `Workspace Opened` catalog.

Adding or changing an event requires updating this document first, then keeping
the frontend type, Rust decoder, server validator, privacy impact review, tests,
and operator queries synchronized in one change. A free-form `properties` escape
hatch, raw-log forwarding, generic event endpoint, or vendor autocapture is a
breaking privacy regression and must not ship.
