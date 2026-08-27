# Analysis Articles

## Use the Environment-pinned ACP bridge

An Analysis Article is ordinary sanitized HTML plus one bounded read-only saved
query. The HTML is the document; the query can be run again manually when the
user needs current data. It is not an always-on database tool.

When DopeDB AI Chat supplies the `dopedb-desktop-session` MCP server, use its
typed Analysis Article tools. Do not run `dopedb status`, list connections, load
this Skill again, or invoke the public CLI inside that session.

1. Use `analysis_article_list` to inspect existing Articles in the exact pinned
   Project Environment when relevant.
2. Supply a short title, safe semantic HTML, and exactly one bounded read-only
   query with its declared result columns. Use the selected database role.
3. Call `analysis_article_draft_run` to validate and execute that definition
   through the same exact-grant read runtime.
4. After a successful draft run, use `analysis_article_propose` to create a new
   draft, or `analysis_article_update_draft` with the exact expected revision.

The Agent cannot schedule refreshes, share query rows, or publish/revoke the
external HTML page. Those actions remain outside the Agent; reruns and publishing
are explicit Desktop controls.

## Outside DopeDB AI Chat

The public `dopedb` CLI intentionally has no Analysis Article creation command.
Ask the user to open the target Project / Environment in DopeDB Desktop and use
its Agent or the structured Article editor. Never substitute a generic MCP
server, direct database credentials, or an old query-run identifier.
