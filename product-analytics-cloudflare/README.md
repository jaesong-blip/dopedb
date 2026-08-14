# DopeDB product analytics on Cloudflare

This private operator service receives only the already validated, consent-gated
product analytics v1 envelope from `workspace-cloud`. It stores raw events in the
dedicated `dopedb-product-analytics` D1 database, never in the workspace tenant
database.

The D1 database is restricted to Cloudflare's EU jurisdiction. The Worker does
not store source IPs or request headers. `event_id` is the primary key, so a
response-loss retry is idempotent. Raw events are retained for 30 days; the daily
scheduled job keeps non-identifying daily counts and deletes old raw rows in a
bounded batch.

The Worker independently enforces an exact D1-backed global budget of 16 events
per minute before storing a batch. This is defense in depth if the server-to-server
capability is ever exposed. Raw-event secondary indexes are deliberately absent:
Cloudflare charges every index update as another D1 row write, while the reviewed
operator queries fit inside the Free plan's read allowance by scanning the bounded
30-day table. At the maximum accepted rate, raw inserts, budget updates, retention
deletes, and aggregate refreshes remain below the Free plan's daily write envelope.

## Operator commands

Run commands from this directory. The checked-in account and database IDs are
non-secret deployment coordinates; `INGEST_TOKEN` is a Worker secret and must
never be committed. Wrangler refuses deployment when that required secret is absent.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm db:migrate:remote
pnpm deploy
```

Run a reviewed aggregate query without exporting raw events:

```sh
pnpm exec wrangler d1 execute dopedb-product-analytics --remote \
  --file queries/first-value-funnel.sql
```

The other reviewed queries cover team activation and weekly consenting-install
activity. Do not export raw identifiers to spreadsheets, tickets, logs, or
workspace Analysis Articles. Cloudflare account access is the operator access
boundary.
