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

## Audit checkpoints

1. Before each slice, add characterization tests and list its writers and old paths.
2. During the slice, migrate every caller before deleting the old implementation.
3. Before commit, prove old symbols and paths are absent and run the full contract.
4. At the midpoint, regenerate the large-file and state-owner inventory.
5. At the end, the oversized-file map and compatibility exceptions must be empty except
   for immutable migrations and tested versioned data decoders.
