# Dashboard creation

## Save only when requested

Do not offer a dashboard after every successful SQL query. Save one only when
the user asks to share or preserve a recurring result, then confirm the exact
title and presentation before creation. Never create one merely because a
`queryRunId` exists.

## Use exact provenance

After explicit agreement, use the `queryRunId` returned by `dopedb query run`:

```text
dopedb dashboard create \
  --query-run <query-run-id> \
  --title 'Active users' \
  --description 'Current active-user view' \
  --kind auto \
  --json
```

Optional chart controls are `--x-column <name>` and repeatable
`--y-column <name>`. Valid kinds are `auto`, `metric`, `line`, `bar`, and
`table`.

The query run must be a successful read created in the same Terminal session
and pinned connection. DopeDB loads the SQL and connection from durable history;
the command cannot replace either one.

Dashboard creation writes only dashboard metadata to DopeDB's local app store.
It does not mutate the target database.
