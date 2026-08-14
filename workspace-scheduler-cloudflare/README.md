# DopeDB Workspace Background Scheduler

This Cloudflare Worker is a small wake-up coordinator for the Vercel workspace
control plane. Its D1 database stores exactly two rows (`knowledge` and
`maintenance`) containing a due time, a short execution lease, a generation,
and a closed error kind. It stores no workspace, member, repository, provider,
credential, graph, or Analysis data.

The Worker cron checks D1 every minute. It contacts `app.dopedb.dev` only when a
task is due; successful control-plane receipts move an idle task one hour into
the future, while durable job creation, managed lease issuance, and Signal
notification creation move the exact task earlier through `/v1/kick`. This
keeps PostgreSQL as the sole authority and lets Neon suspend between real work.

`/v1/kick` requires the exact contract header and the `KICK_TOKEN` Worker
secret. The token is a server-to-server capability, never a Desktop or browser
secret. The Worker calls the existing internal routes with the separate
`WORKSPACE_CRON_SECRET`. Both upstream responses and kick bodies are streamed
under fixed byte caps, redirects are refused, and logs contain only task and
closed failure enums.

## Operator commands

Run commands from this directory. Checked-in account and D1 IDs are non-secret
deployment coordinates. Wrangler must hold both required secrets before deploy.

```sh
pnpm install --frozen-lockfile
pnpm types
pnpm build
pnpm test
pnpm db:migrate:remote
pnpm deploy
```

Do not schedule the two Vercel routes independently. The Cloudflare cron is the
only recurring timer; the one-hour receipt is the missed-kick reconciliation
fallback.
