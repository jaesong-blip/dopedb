# ADR 0007: Analysis Article is the canonical BI domain

- Status: accepted
- Date: 2026-08-12
- Owners: DopeDB product and workspace architecture

## Context

DopeDB currently exposes four overlapping collaboration resources:

- Dashboard stores one read query and a small fixed visualization definition.
- Funnel Analysis stores an Environment-scoped multi-connection analysis proposal.
- Agent Report stores narrative claims and immutable query evidence.
- Signal stores a deterministic condition over one published metric.

These resources describe different projections of one user job: keep a reusable
analysis current for a team, explain how every value was produced, and optionally
publish one reviewed point-in-time result. Keeping them separate duplicates
revision, ownership, evidence, authorization, navigation, and publication rules.
It also prevents a single analysis from combining narrative, metrics, retention,
tables, and several databases without leaving the artifact.

The product needs a flexible BI surface, but arbitrary executable components or
unbounded cross-database federation would bypass the exact-grant and local
execution boundaries that distinguish DopeDB.

## Decision

`AnalysisArticle` is the only first-class BI collaboration resource. It replaces
Dashboard, Funnel Analysis, Agent Report, and their separate navigation surfaces.
A Signal remains a rule, but it is owned by one published article metric rather
than by a separate dashboard domain.

An article is a versioned document plus a deterministic analysis graph:

```text
AnalysisArticle
|- current definition revision
|  |- exact Environment scope
|  |- source query nodes
|  |- typed transform graph
|  |- semantic metrics
|  `- ordered document/layout blocks
|- immutable runs and bounded result fragments
|- metric signal rules
|- review, ownership, and audit history
`- optional immutable public publications
```

The user-facing location is `Project -> Environment -> Analyses`. There is no
separate Dashboard, Report, Funnel, or Knowledge product launcher. Dense metric
grids are article sections, not a second Dashboard mode.

## Definition and revision contract

Every content mutation creates an immutable definition revision. The article row
only owns identity, lifecycle state, ownership, and pointers to the current draft
and current live revision. A revision pins all of the following:

- workspace, Project, Environment, and Environment revision;
- connection ids, connection revisions, roles, and required read grants;
- source KnowledgeGrant and graph revision ids when source evidence is used;
- read-only source SQL, its declared output schema, and a bounded parameter schema;
- an acyclic typed transform graph;
- semantic metric ids and units;
- ordered article blocks and their responsive layout;
- refresh policy, freshness target, and result-publication policy.

Viewers may change only parameters declared by the revision, such as date range,
comparison period, or an allowlisted segment. A parameterized run never mutates
the definition. Editing SQL, mappings, transforms, metrics, layout, or refresh
policy creates a draft revision that requires human review before it becomes
live.

Concurrent content changes never merge silently. A stale edit becomes a conflict
draft. Lifecycle, ownership, publication, and deletion mutations fail closed on
stale authority.

## Closed block and transform registries

Articles are extensible through versioned declarative registries, not through
arbitrary React, JavaScript, Python, HTML, SQL templating, or remote embeds.

The complete block registry is:

- narrative: heading, markdown, callout, divider;
- BI: metric, time series, bar, area, scatter, table, funnel, retention cohort,
  retention heatmap;
- controls: date range, comparison period, and allowlisted segment filter.

Each block references a declared source or metric and accepts only its schema's
bounded presentation properties. Unknown block kinds, versions, fields, remote
images, raw HTML, executable code, and oversized content fail validation.

The complete transform registry is:

- project, filter, sort, limit, union;
- group and aggregate;
- inner and left join;
- window, lag, ratio, difference, and rate;
- cohort assignment and retention.

Transforms are typed, deterministic, acyclic, and versioned. A join across
connections requires an approved Knowledge mapping for the exact source columns,
declared cardinality, and sensitivity class. DopeDB never infers an identity join
and silently publishes it. Cross-database SQL federation is still prohibited:
each database executes its own bounded read and only bounded intermediate results
enter the transform engine.

## Execution and freshness contract

Database traffic continues to originate from a Desktop runner. A run acquires one
article-run claim and opens each source independently through the exact current
workspace/account/connection revision and read grant. It revalidates Environment,
connection, Knowledge, schema, mapping, and local policy before execution.

Source filtering and aggregation are pushed down to each database. The Rust-owned
result store bounds intermediate rows, bytes, duration, and in-flight memory.
The transform engine combines only the declared outputs. It supports cancellation
through the existing operation runtime and never broadens a grant during a run.

An article may be refreshed manually or by an explicit Desktop runner lease. The
lease is member- and device-specific, short-lived, renewable, and visible to the
workspace. A local credential can run only while that device is available; a
managed credential is still issued as a short-lived member-specific lease into
that runner's process memory. The hosted control plane never opens a database
connection and never claims an article is current when no eligible runner is
online.

Refresh policy declares a schedule and a maximum freshness lag. Team readers see
the latest successful compatible run, its source timestamps, next expected run,
and runner health. A failed or partial run never erases the last successful run.
Schema, grant, mapping, graph, or connection drift marks the article stale and
blocks unattended refresh until a new revision is reviewed.

## Shared result contract

The control plane may store only explicitly publishable, bounded article result
fragments. This is a narrow exception to the default local-result rule, not a
general query-result warehouse.

- A fragment is produced by a reviewed live revision and successful read-only run.
- Raw source artifacts, credentials, connection URLs, Agent transcripts, and local
  result handles never enter the workspace payload.
- Every column carries a semantic type and sensitivity decision. Secret, credential,
  direct identifier, or unreviewed free-text columns are rejected. Masking and
  aggregation are applied before upload.
- Per-block and per-run row, byte, cell, and retention limits are enforced by both
  Desktop and control plane.
- Fragments are encrypted separately, integrity hashed, authorized independently,
  and deleted by retention and revocation jobs.
- A run receipt binds fragment bytes to the article revision, exact sources,
  transform version, runner, timestamps, and audit event.

Workspace article URLs resolve to the current live revision and its latest
successful compatible run. Refresh failure leaves the previous compatible result
visible with an explicit stale or failed status.

## Public publication contract

A public web article is never a live database surface. An Editor, Admin, or Owner
selects one successful run, chooses publishable blocks, confirms masking and
sensitivity, previews the exact payload, and explicitly publishes an immutable
snapshot.

The public route reads only the publication snapshot. It has no workspace session,
database grant, query command, credential path, refresh action, hidden source SQL,
or link to private evidence. Updating public values creates a new publication
version and requires another approval. Revocation disables the public slug without
mutating historical audit receipts.

Public publication is rate limited, cacheable, accessibility checked, and excluded
from search indexing by default until the publisher explicitly opts in.

## Agent and human ownership

An Environment-pinned ACP Agent may propose a complete draft, source queries,
transforms, metrics, narrative, blocks, and signal rules. It may execute bounded
read-only draft runs when the current grant permits them. It cannot make a draft
live, approve an identity mapping, enable a production schedule, publish result
fragments, publish a public snapshot, transfer ownership, or revoke history.

The screen owns those approvals, current-result inspection, lineage inspection,
runner health, cancellation, conflict recovery, publication, rollback, and audit.
Every visible metric can open its exact source-query, transform, mapping, and run
lineage.

## Migration and removal

The migration is one-way and leaves no legacy product surface:

- Dashboard becomes an article containing its query and visualization block.
- Funnel Analysis becomes an Environment article with its sources, typed composed
  metrics, funnel blocks, warnings, and mappings.
- Agent Report becomes an article revision with narrative and evidence blocks.
- Signal rules are rebound to article id, article revision, and metric semantic id.

After local and hosted migrations succeed, old Dashboard, Funnel Analysis, and
Report commands, APIs, tables, routes, menus, screens, CSS ownership, translations,
and compatibility readers are removed in the same release. Unknown or invalid old
records are preserved as non-executable migration failures for explicit recovery;
they are never silently widened or dropped.

## Consequences

- Teams get one searchable, revisioned BI archive rather than four disconnected
  resources.
- Current internal results and fixed external stories share one definition and
  rendering grammar without sharing execution authority.
- Flexibility is limited to declared blocks and transforms, which makes validation,
  lineage, masking, cancellation, and deterministic reruns possible.
- Always-current behavior depends honestly on a healthy eligible Desktop runner;
  DopeDB does not become a hosted database proxy.
- The migration is larger than adding another dashboard kind, but it removes the
  duplicated models and prevents a second incompatible BI system from accumulating.
