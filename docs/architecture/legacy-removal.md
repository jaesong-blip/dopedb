# Legacy removal gate

Every feature migration is one complete vertical slice. A slice is not complete when
the new code merely exists; it is complete only after the old runtime path is gone.

## Required order

1. Capture current behavior with tests.
2. Define typed identities, commands, results, and ports.
3. Implement the use case and concrete adapters.
4. Move every transport and UI caller.
5. Delete the old service, fallback, re-export, rollout flag, tests, and dependency.
6. Search for the old paths and symbols and require zero matches.
7. Run architecture, frontend, Rust, site, cloud, and cross-platform CI checks.

Temporary coexistence is allowed only in the uncommitted working tree while callers are
being moved. An issue-linked `main` commit must contain one production path.

## Compatibility is not an active fallback

Historical database migrations and decoders required to open user data are retained.
They must be placed or documented as versioned compatibility assets, have a focused
test, and state the condition under which removal becomes safe. They must not select an
older runtime implementation.
