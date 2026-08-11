# Analysis Articles

## Use the Environment-pinned ACP bridge

An Analysis Article is a versioned, declarative BI document: bounded read
queries, typed transforms, semantic metrics, narrative and visualization blocks,
review evidence, refresh policy, and optional Signals. It is not a saved CLI
query or an always-on database tool.

When DopeDB AI Chat supplies the `dopedb-desktop-session` MCP server, use its
typed Analysis Article tools. Do not run `dopedb status`, list connections, load
this Skill again, or invoke the public CLI inside that session.

1. Use `analysis_article_list` to inspect existing Articles in the exact pinned
   Project Environment when relevant.
2. Build a complete declarative definition with exact connection roles, bounded
   read-only queries, declared schemas, typed transforms, metrics, blocks, and
   warnings.
3. Call `analysis_article_draft_run` to validate and execute that definition
   through the same exact-grant read runtime.
4. After a successful draft run, use `analysis_article_propose` to create a new
   draft, or `analysis_article_update_draft` with the exact expected revision.

The Agent cannot submit review, make a revision live, approve an identity
mapping, enable a production schedule, transfer ownership, publish reviewed
result fragments, or publish/revoke an external snapshot. Those actions remain
explicit Desktop controls.

## Outside DopeDB AI Chat

The public `dopedb` CLI intentionally has no Analysis Article creation command.
Ask the user to open the target Project / Environment in DopeDB Desktop and use
its Agent or the structured Article editor. Never substitute a generic MCP
server, direct database credentials, or an old query-run identifier.
