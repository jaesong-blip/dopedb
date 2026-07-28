# Repository agent instructions

These rules apply to every AI agent working in this repository.

## Required context

Before changing files, read `CLAUDE.md` and `CONTRIBUTING.md`. Keep the
collaboration and release rules in all three files synchronized.

Before changing TSX, CSS, Tailwind utilities, or layout, also read
[`src/design-system/README.md`](src/design-system/README.md). DopeDB semantic
tokens and shared primitives are authoritative.

## Work safely

- Inspect `git status` before editing. Preserve unrelated and untracked work.
- Work on the current `main` checkout unless the user explicitly requests a
  branch or pull request. A GitHub Issue is optional.
- Never force-push, delete `main`, hide failed checks, or expose repository
  secrets and signing keys.
- Follow [`docs/commit.md`](docs/commit.md) when creating a commit.

## GitHub identity

The workstation normally keeps `jaesong-blip` active, while this repository is
owned by `json-choi`. Before committing, run `pnpm repo:identity`. For a single
owner-attributed GitHub or push command, use `pnpm gh:owner -- gh ...` or
`pnpm gh:owner -- git push ...`; never run raw `gh auth switch`. If the wrapper
was interrupted, confirm it is no longer running and use `pnpm gh:restore`.

## Validation

Run checks proportional to the change:

- `pnpm build` for frontend changes.
- `pnpm test` for the critical frontend smoke suite.
- `pnpm test:rust` for Rust behavior or wire-contract changes.
- A manual app check for changed UI flows.

The repository has a hard budget of 104 critical tests. Add a test only for a
security/safety invariant, public wire contract, or core end-to-end journey.
Prefer extending an existing test, and replace a lower-value test instead of
increasing the count. Never raise
[`tests/critical-test-budget.json`](tests/critical-test-budget.json) limits
without an explicit user request. Run `pnpm check:test-budget` for test changes.

For documentation-only changes, a diff and link review is enough. Report the
branch, commit or uncommitted state, checks run, and any failures accurately.

## Stable releases

Publish a stable release only after an explicit user request. Only `json-choi`
may do so, from `main`, with every version source synchronized and an
`app-vX.Y.Z` tag. Do not approve or bypass the protected release environment,
handle signing material, or create a plain `vX.Y.Z` release tag.
