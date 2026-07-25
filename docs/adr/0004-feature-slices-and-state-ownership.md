# ADR 0004: Feature slices and single-writer state ownership

## Status

Accepted

## Context

Layer-only folders made a feature flow span screens, IPC, commands, services, and the
store. Large files could grow while rules and state writes were duplicated across those
layers. A folder move alone would not prevent the same drift.

## Decision

- Organize new and migrated code by feature.
- Keep domain, application, and port modules free of Tauri, SQLx, keychain, network, and
  global-state dependencies.
- Wire concrete adapters only at a feature composition boundary.
- Use distinct identity types and composite resource identities.
- Give each mutable state one reducer or runtime owner.
- Model resumable or concurrent work with explicit state machines.
- Delete the previous runtime path in the same completed feature slice.
- Enforce boundaries, file-size ratchets, state owners, and removed symbols in CI.

## Consequences

The main feature flow is readable without opening platform code. Adapters can change
without changing policy. The compiler catches several identity mix-ups, and CI catches
new direct writers or resurrected paths. Existing large modules are migrated
incrementally, but cannot grow while waiting.
