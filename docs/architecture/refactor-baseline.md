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

## Audit checkpoints

1. Before each slice, add characterization tests and list its writers and old paths.
2. During the slice, migrate every caller before deleting the old implementation.
3. Before commit, prove old symbols and paths are absent and run the full contract.
4. At the midpoint, regenerate the large-file and state-owner inventory.
5. At the end, the oversized-file map and compatibility exceptions must be empty except
   for immutable migrations and tested versioned data decoders.
