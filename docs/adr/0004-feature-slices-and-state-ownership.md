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
- Keep process-backed feature state behind one runtime writer; its Tauri transport,
  frontend command literals, and wire contracts stay feature-owned.
- Keep cross-feature platform dispatchers thin: envelope validation and authentication
  stay in one router, while bounded handlers delegate to feature use cases and share
  only explicit wire projections.
- Express cross-feature authorization through a least-authority read port; producers
  retain a separate write port instead of exposing another feature's store or runtime.
- Split security-sensitive filesystem inspection behind a domain-only port and
  application use case; keep status policy pure and the concrete adapter bounded and
  fail-closed while preserving one public feature facade.
- Compose large static catalogues from bounded namespace owners and enforce exact
  language parity, collision freedom, and a fixed compatibility contract in tests.
- Preserve retired persisted data through read-only adapters and immutable migrations;
  delete its former runtime, command, service, and compatibility-facade paths.
- Model resumable or concurrent work with explicit state machines.
- Delete the previous runtime path in the same completed feature slice.
- Enforce boundaries, file-size ratchets, state owners, and removed symbols in CI.

## Consequences

The main feature flow is readable without opening platform code. Adapters can change
without changing policy. The compiler catches several identity mix-ups, and CI catches
new direct writers or resurrected paths. Existing large modules are migrated
incrementally, but cannot grow while waiting.
