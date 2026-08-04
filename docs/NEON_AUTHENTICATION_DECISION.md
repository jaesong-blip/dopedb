# Neon management authentication decision

Decision date: 2026-08-05

## Decision

DopeDB does not present Neon Management API access as OAuth or as a one-click
connection. The production fallback is a Neon API key, preferably a
project-scoped organization key. DopeDB encrypts that integration credential;
shared connection records, discovery receipts, browser responses, audit events,
and desktop target authority never contain it.

New encrypted Neon credential envelopes use this explicit contract:

```text
kind = apiKey
schemaVersion = 1
apiKey = secret
organizationId = optional organization selector
```

The server can still read the original unversioned API-key envelope, but always
normalizes it to version 1 before use. An OAuth credential kind must not be added
until Neon supplies DopeDB with a production third-party client contract.

## Official evidence

- The [Neon API authentication reference](https://api-docs.neon.tech/reference/authentication)
  defines Bearer API keys for the public Management API and documents personal,
  organization, and project-scoped organization keys.
- The current [Neon OpenAPI specification](https://neon.com/api_spec/release/v2.json)
  describes `BearerAuth` as an API key. It publishes no OAuth authorization-code
  security scheme or self-service client-registration endpoint.
- `GET /auth` is the documented
  [request-authentication details endpoint](https://api-docs.neon.tech/reference/getauthdetails).
  It returns `account_id` and an `auth_method` that distinguishes user API keys,
  organization API keys, OAuth sessions, and Neon-owned sessions.
- Neon documents OAuth for its hosted
  [MCP server](https://neon.com/docs/ai/neon-mcp-server). That authorization is
  owned by Neon's MCP product and is not a documented credential-broker contract
  for a third-party shared database service.

The absence of a public client-registration contract is an inference from the
published API and documentation, not a claim that Neon has no private partner
program. Revisit this decision only when Neon provides all of the following:

- production client registration and redirect URI ownership;
- authorization, token, and revocation endpoints;
- PKCE requirements;
- minimum read scopes for project, branch, database, endpoint, role, and
  connection URI discovery;
- access/refresh TTL and rotation behavior;
- project and organization consent semantics.

## Runtime verification

Every connect or reconnect verifies both the `/auth` principal and the complete,
bounded project set. Their fingerprints form the durable external account
identity. Discovery and new lease issuance repeat that comparison, so a key
replacement or project-scope drift fails closed and asks the administrator to
reconnect.

Personal keys without an organization selector are recorded as broad scope.
The UI must warn about that scope and continue to recommend a project-scoped
organization key; it must not label the fallback as one-click.

Project and branch discovery follows Neon cursors until exhaustion, within the
shared 200-resource and 16-page safety bounds. The database endpoint is currently
unpaginated; the collector accepts and follows a future cursor response while
avoiding undocumented query parameters on the first request. Any repeated,
invalid, or over-limit cursor fails closed instead of silently truncating.

The final database selection is pinned by Neon database ID, with its current
name retained only as display/connection metadata. A protected branch is always
production; a default or otherwise unclassified branch requires an Admin/Owner
classification. No final discovery leaf can be imported directly. It must pass
the sealed Neon bootstrap plan, explicit PUBLIC/production approvals, independent
ACL validation, and read-positive/write-negative credential smoke test before a
short-lived import receipt is issued. The resulting capability remains read-only.
