# Query workflow

## Select a connection

Use:

```text
dopedb connection list --json
dopedb connection show id:<uuid> --json
dopedb connection test id:<uuid> --json
```

Do not select the first result. If the user has not identified a database and
there is no pinned `current` connection, ask them to choose.

## Inspect before querying

Prefer canonical catalog commands over assumptions:

```text
dopedb catalog show --connection id:<uuid> --json
dopedb schema list --connection id:<uuid> --json
dopedb table describe schema.table --connection id:<uuid> --json
```

Qualify relation names when the engine supports schemas or namespaces.

## Plan exactly one read

Pass SQL through stdin:

```text
printf '%s\n' 'SELECT id, email FROM public.users LIMIT 100' |
  dopedb query plan --connection id:<uuid> --file - --json
```

The planner rejects multiple statements and mutation shapes. Review:

- planning decision;
- notices and safer suggestions;
- estimated rows;
- aggregate database health and its coverage;
- plan expiration.

If the SQL changes, plan again and explain why. Do not run a plan created for
different text.

## Consume the plan

```text
dopedb query run --plan <plan-id> --json
```

Plans are exact, single-use, expiring, and Terminal-scoped. A conflict or expiry
is not permission to retry blindly. Re-plan only when the user still wants the
same read and the connection scope remains correct.

Results are row- and byte-capped. A truncated result is not the full table.
Summaries must say when truncation occurred.

## Cancellation and failure

Use the returned operation identifier:

```text
dopedb query cancel <operation-id> --json
```

Distinguish cancellation, timeout, target execution failure, scope denial, and
protocol mismatch. Never convert a failed or missing receipt into success.
