# Architecture refactor baseline

This file records the starting point for issue #70. It is an audit snapshot, not a
permanent exception list. `scripts/check-architecture.mjs` prevents every listed file
from growing and requires its entry to be removed once it reaches 900 lines.

## Initial findings

- The frontend had SQL document writes in both `App.tsx` and `screens/Sql/index.tsx`.
- Workbench document state had multiple `setDocuments` and `setActiveDocumentId` writers.
- The Rust path was `commands -> services/sql_document_service -> Store`.
- `SqlDocumentsV1` was always enabled, so its fallback branch was unreachable.
- Raw `Uuid` and `string` values represented workspace, connection, and SQL document ids.
- Large modules remain in query execution, the local store, jobs, broker dispatch, and
  several UI screens. Their exact starting limits live in
  `scripts/architecture-ratchet.json`.

## First migrated slice

SQL documents use:

```text
Tauri transport
  -> SqlDocumentUseCases
     -> authority port
     -> repository port
  -> connection and SQLite adapters
```

The frontend uses:

```text
App / SQL screen
  -> workbench reducer or autosave use case
     -> SqlDocumentGateway
        -> Tauri adapter
```

The former service file, central IPC wrappers, rollout flag, and direct workbench state
setters are deletion gates. The architecture check fails if any of them returns.

## Second migrated slice

Saved connections use:

```text
Tauri / broker transport
  -> ConnectionUseCases
     -> repository, authority, driver, credential, and ad-hoc test ports
  -> SQLite, scope-pinned runtime, driver registry, and keychain adapters
```

`ConnectionId` now crosses the use-case and Tauri boundaries as a distinct type, and
Terminal authority moved into the shared kernel with typed workspace, account-scope,
and connection identities. The former connection service, credential helper, central
frontend connection commands/types, and service-owned Terminal authority are deletion
gates. Credential rotation, rollback cleanup, view-only denial, schema-group atomicity,
and Terminal non-disclosure remain covered by adapter-level tests.

## Third migrated slice

Workspaces use:

```text
Tauri transport
  -> WorkspaceUseCases
     -> repository, runtime, control-plane, configuration, and credential ports
  -> SQLite/scope-gated runtime, hosted HTTP, keychain, and environment adapters
```

`AccountId`, `WorkspaceId`, and `ConnectionId` remain distinct across every workspace
use-case and transport boundary. Authentication, selection/synchronization, and
connection sharing have separate application modules. The connection pool receives a
remote authority port at the composition root; it cannot reach a global hosted-auth
module. The frontend workspace feature exclusively owns Tauri command names, public
wire types, Query options, and authentication-cache writes.

The former workspace service, global auth module, central frontend IPC
commands/types, generic components, and generic auth/account helpers are deletion
gates. The architecture check also prevents workspace core modules from importing
Tauri, SQLite, HTTP, keychain, environment, or concrete adapters.

## Fourth migrated slice

Metadata catalogs use:

```text
Tauri / broker / schema / script / job consumers
  -> CatalogUseCases<ConnectionId>
     -> catalog gateway port
  -> scope-pinned introspection and cache adapter
```

Catalog wire values and cache policy now belong to the catalog domain rather than the
introspection implementation. Every live or cache-first load, including approval-time
schema and staged-row revalidation, enters through the same typed use case. The former
catalog service, central Tauri commands, direct script-service introspection, and
introspection-owned model definitions are deletion gates. The persistent catalog cache
has one documented writer in the SQLite adapter. The feature imports only
`dopedb_protocol::catalog`, the versioned, transport-independent canonical metadata
contract shared with the CLI; command envelopes and other protocol modules remain
forbidden in the core.

## Fifth migrated slice: Job Engine

The start audit found four oversized legacy responsibilities in one service tree:
orchestration, the SQLite ledger, database execution, and file formats. Central Tauri
commands also owned the renderer boundary. The SQLite
repository is the only current writer for job, capability, checkpoint, artifact, and
event rows; the architecture check now proves every mutation SQL token has that one
owner.

The first migration checkpoint moved the wire-compatible job contracts into the
feature domain and replaced interchangeable UUIDs with `ConnectionId`, `JobId`,
`JobFileCapabilityId`, `JobArtifactId`, and `OperationId`. Job lookups cross the
application boundary as `ConnectionJobId`. Durable transitions and plan validation
are pure feature policies with characterization tests. The former service-owned
`model.rs` path is a deletion gate.

The second checkpoint moved every Rust Tauri command and every frontend command/type
to Job-owned transport and domain modules. Frontend IDs are branded by resource type,
and architecture checks require each Job command literal to have exactly one adapter
owner. Central command/type reintroduction is a deletion gate. Renderer camelCase plan
fields are accepted as deserialization aliases while stored plan JSON remains
snake_case, preserving existing plan hashes and resumable jobs.

The midpoint checkpoints deleted the entire former service tree and inverted the
remaining platform dependencies. Orchestration belongs to
`features/jobs/application.rs`; its authority, ledger, file, catalog, Operation,
execution, and generator dependencies are contracts in `features/jobs/ports.rs`.
SQLite, native file, runtime authority, catalog, Operation, and worker implementations
are visibly bounded under `features/jobs/adapters/`. Shared operation actor/policy
derivation lives in `operations/context.rs`, so the application never depends back on
a central service facade. `features/jobs/mod.rs` is the only composition boundary.

Architecture checks now reject concrete connection, store, SQLx, filesystem,
Operation runtime, catalog implementation, and adapter imports from every Job
application module and reject platform types in its ports. Recovery, file capability,
planning, and execution lifecycle use cases are separate modules below the feature
limit; the former monolithic `application.rs` is now a deletion gate. The SQLite
ledger is likewise split into capability, record, transition, recovery, event, and
mapping modules behind one `JobRepository`; the former `ledger.rs` is a deletion
gate and mutation SQL is rejected outside that adapter directory. Worker execution
has separate export, import, resume validation, statement, validation, and file
publication modules behind a small execution entrypoint; the former `worker.rs` is
also a deletion gate. Format writing, typed value encoding, import reading,
inspection/audit, and hardened file I/O have independent modules, and the former
`format.rs` is a deletion gate. The remaining deletion gates cover every old Job
service path and symbol.

Every Job feature and adapter file is now below the feature limit, so the Job entries
have been removed from the oversized-file ratchet rather than carried as permanent
exceptions.

## Sixth migrated slice: ERD persistence

The start audit found one service owning layout validation, connection authorization,
workspace scoping, optimistic concurrency, and SQLite writes. ERD layout and virtual
relation UUIDs were also interchangeable with connection and other resource UUIDs,
while Rust and renderer contracts were re-exported by central command/type facades.

ERD persistence now uses:

```text
Tauri transport
  -> ErdUseCases<ConnectionId, ErdLayoutId>
     -> authority, repository, and identity/time ports
  -> scope-pinned connection and single-writer SQLite adapters
```

`ConnectionErdLayoutId` is required for deletes, validation completes before the
authority boundary, and optimistic conflicts return the current durable layout instead
of overwriting it. The renderer owns branded ERD IDs and its Tauri adapter beside the
feature. The former service, central Rust commands/re-exports, and central frontend
commands/types are deletion gates. Architecture checks require every ERD mutation SQL
statement to remain in `SqliteErdRepository`, whose runtime state ownership is recorded
explicitly.

## Seventh migrated slice: structured schema editor

The start audit found a service that directly coordinated catalog refresh, DDL
rendering, and immutable Script proposals, while central Rust and renderer facades
owned every command and wire type. Raw UUIDs also crossed the schema command and
Operation boundaries.

The structured editor now uses:

```text
Tauri transport
  -> SchemaEditorUseCases<ConnectionId, OperationId>
     -> catalog, planner, and script-operation ports
  -> Catalog, DDL renderer, and immutable Script adapters
```

The use case refreshes one exact catalog snapshot before rendering and passes that
same request/plan pair to the immutable Operation path. A planning failure is proven
not to reach the Script boundary. The Script feature is injected through the
schema-owned port, so schema code cannot reach Script storage, pool, or Operation
adapters. The former schema service, central Tauri commands/re-exports, and central
frontend commands/types are deletion gates; the renderer owns branded schema
Operation IDs beside its Tauri adapter.

## Eighth migrated slice: saved dashboards

The start audit found metadata reads, scope-pinned deletion, read-only execution,
audit/history recording, terminal query provenance, validation, and persistence in
one service. A second global module owned the validation policy, dashboard contracts
lived in the generic model file, and central Rust and renderer facades owned the
transport names. Dashboard, connection, terminal-query-run, and live execution UUIDs
were also interchangeable.

Saved dashboards now use:

```text
Tauri / broker transport
  -> DashboardUseCases<DashboardId, ConnectionId, QueryRunId, QueryExecutionId>
     -> metadata, read-only runner, and provenance creation ports
  -> scope-pinned runtime, audit/history, Terminal capability, and SQLite adapters
```

Creation accepts presentation only; connection identity and SQL are resolved from the
exact authorized Terminal run and re-read under the same operation scope. Execution
revalidates stored SQL against the current engine before touching the target database,
always uses a read lease, records both audit and history outcomes, and retains the
lease or failed operation scope until the transport maps the result. Durable dashboard
mutation SQL still has one explicit Store writer pending the Store decomposition, and
the architecture contract rejects a second writer.

The former dashboard service, global policy module, generic model contracts, central
Rust commands/re-exports, and central renderer commands/types are deletion gates.
The renderer owns branded dashboard and execution IDs beside its Tauri adapter.

## Ninth migrated slice: Terminal Dock

The start audit found a process-owning Terminal module and a component-local reducer,
while the shared frontend IPC files also owned Terminal commands and wire contracts.
That split allowed a second state owner or a legacy adapter to return without a clear
CI failure.

Terminal Dock now uses:

```text
Tauri transport
  -> TerminalUseCases
     -> TerminalSessionPort
  -> desktop adapter -> PTY runtime, Broker capability, SQLite connection pin
```

The immutable Terminal domain, port, and application layers do not import Tauri,
Store, or Broker code. The transport only maps Tauri inputs to the feature facade;
the desktop adapter alone composes Store, Broker, CLI resolution, and the PTY runtime.
`PtyTerminalRuntime` is the single writer for the in-memory session registry, recorded
in the state-owner inventory. The former `src-tauri/src/terminal/**` tree and
`src/components/TerminalDock/terminalState*` paths are deletion gates. Terminal command
literals, public wire types, and adapter functions are owned only by
`src/features/terminals/`, so the shared IPC facades cannot regain a parallel API.

## Tenth migrated slice: Agent tools and retired chat archive

The start audit found local CLI probing, retired-chat wire contracts, Tauri commands,
SQLite archive reads, and renderer query options spread across global modules. Archive
thread and message UUIDs were interchangeable, and temporary central query aliases
could keep the old ownership path alive after a folder move.

The Agent slice now uses:

```text
Tauri transport
  -> AgentsUseCases<RetiredChatThreadId>
     -> CLI probe and read-only archive ports
  -> bounded process probe and scoped SQLite read adapters
```

The CLI probe exposes status only and never transfers provider credentials. It clears
the inherited child environment, restores only location and locale variables, bounds
every status process, and never returns provider stderr contents. Retired chat threads
and messages have separate typed identities, no mutation port, feature-owned renderer
contracts, command literals, and query keys. The old top-level CLI,
chat, service, central command/type, and central query paths are deletion gates. The
historical SQLite tables and migrations remain intact so existing archives stay
readable, while their SELECT projection is isolated from the already-large Store file.

## Broker platform boundary decomposition

The 1,822-line Broker dispatcher mixed envelope validation, session authentication,
command routing, feature calls, wire projection, error mapping, and desktop activity
events. It is now a small envelope router plus bounded Public/Skill,
Connection/Catalog, Query/Document, Dashboard/Operation, and projection modules.
Protocol compatibility and authentication sequencing remain owned by the router, and
handlers cannot authenticate directly against the session registry.

Terminal capability storage is keyed by `TerminalSessionId`; revocation requires
typed Terminal and connection identities, and raw session UUID conversion occurs
only at authentication boundaries. Broker runtime ownership is carried internally by
`RuntimeId` through the runtime, session registry, dispatcher, discovery cleanup, and
server composition. Conversion back to UUID is limited to versioned protocol
discovery, status, and app-open projections. Capability and Broker runtime status
writers are recorded in the state-owner inventory. The old monolithic dispatcher is
both a deletion gate and removed from the oversized-file ratchet.

## SQL Query feature boundary

Terminal read planning, single-use claiming, cancellable read-only execution,
history provenance, query-run dashboard authorization, Desktop SQL
classification/preview/proposal/execution, and authenticated Terminal SQL proposals
now form the `features/queries` slice. Tauri and Broker transports call one
composition facade with typed Terminal, connection, operation, and query-run
identities. Store, pool, Operation Runtime, audit, history, cache invalidation, and
ephemeral capability storage remain adapter concerns. The application layer depends
on feature ports rather than concrete adapters, and each production module remains
below the feature-size limit.

Dashboard composition receives only an authorization port; successful query
producers retain the separate registration capability. Renderer SQL contracts and
static Tauri command literals live beside the Query feature instead of the central
IPC facade.

The former central Terminal run registry, `QueryService`, central Rust SQL commands,
and central renderer SQL wrappers/contracts are deletion gates. Characterization
tests stay with the feature and cover row caps, rejection audit, cancellation
registration, atomic single-use claims, authority and expiry failures, failure
history, approval and payload-hash semantics, outcome-unknown recovery, cache
invalidation, provenance fail-closed behavior, and scope/lease lifetime. The former
service is deleted and removed from the oversized-file ratchet; no compatibility
facade remains.

## Execution service feature boundaries

Script, typed Document reads, Monitoring, Safety settings, Activity history, and
Operation control now expose one feature facade each:

```text
Tauri / Broker / collaborating feature
  -> feature application use cases
     -> feature-owned port
  -> private local platform adapter
     -> Store, ConnectionManager, OperationRuntime, executor, audit/history
```

Script and Document execution are split into bounded proposal, execution, recording,
and read/write modules. Their application layers do not import persistence, pool, SQLx,
Tauri, or Operation runtime implementations. Monitoring, Safety, Activity, and
Operation control follow the same application/port boundary while retaining their
scope leases, exact approval rules, and redacted receipts. The central `services`
module is composition-only; every former service file and service symbol is a CI
deletion gate, and both former oversized entries are removed from the ratchet.

## Bounded Skill inventory

The former Skill inventory file is replaced by domain, port, application, status, and
filesystem modules. The application use case receives domain-only filesystem
observations through its port; only the adapter performs path and file I/O. Marker
schema v1, official snapshot matching, deterministic fingerprints, fail-closed
symlink and Windows reparse handling, no-follow reads, and the existing
file/depth/byte limits remain characterized. The old file is a deletion gate and no
replacement production module may exceed the feature-size limit.

## Static localization catalogue

The former localization monolith is replaced by a browser runtime, exact catalogue
types, one collision-checking composer, and bounded namespace catalogues. The public
provider and hook API is unchanged. English and Korean retain the same fixed 870-key
and value contract, placeholder parity, deterministic ordering, and English fallback.
The old file is a deletion gate, and tests pin both the complete catalogue digest and
the language preference lifecycle.

## Member-local provider credentials

Hosted integration authority and member-local credential material use:

```text
Tauri transport
  -> Provider use cases
     -> hosted authority, verifier, receipt, binding, and credential-vault ports
  -> redacted control-plane, bounded provider process/HTTP, SQLite, and OS-keyring adapters
```

The renderer can select only a hosted integration and a tagged credential method. It
cannot choose workspace, account, provider, generation, device, or the verified
provider scope. Receipts are process-owned, short-lived, and single-use; the hosted
authority is checked again before a credential becomes usable. SQLite stores only
redacted binding metadata and opaque keyring references, while secret-bearing inputs
are neither serializable nor debug-printable.

The Provider slice owns its Tauri commands, renderer contracts, reducer, receipt
registry, binding mutations, and cleanup lifecycle. Revocation tombstones local
authority before deleting an OS-keyring item, and failed deletion remains durable for
bounded retry. A removed remote integration never prevents local cleanup. The former
Store-owned provider binding module, central command/type aliases, duplicate Provider
command literals, platform dependencies in feature core, and mutation SQL outside
the Provider SQLite adapter are deletion gates.

## Audit checkpoints

1. Before each slice, add characterization tests and list its writers and old paths.
2. During the slice, migrate every caller before deleting the old implementation.
3. Before commit, prove old symbols and paths are absent and run the full contract.
4. At the midpoint, regenerate the large-file and state-owner inventory.
5. At the end, the oversized-file map and compatibility exceptions must be empty except
   for immutable migrations and tested versioned data decoders.
