# Repository agent instructions

These rules apply to every AI agent working in this repository.

## Required context

Before changing files, read `CLAUDE.md` and `CONTRIBUTING.md`. Keep the
collaboration and release rules in all three files synchronized.

Before changing TSX, CSS, Tailwind utilities, or layout, also read
[`src/design-system/README.md`](src/design-system/README.md). DopeDB semantic
tokens and shared primitives are authoritative.

## Product direction

DopeDB has three product axes. Judge every feature against them, not against
DopeDB's feature list.

**1. A workspace shares connections and dashboards.** The unit of the product
is a team workspace, not one person's machine. Connection profiles and BI
dashboards exist to be shared inside it. Long-lived secrets never travel with
the shared record: member-local access stays in each member's OS credential
store, while managed access issues a least-privilege, member-specific short-lived
credential into process memory. A feature that makes a connection or a dashboard
shareable outranks a local-only convenience.

**2. Connecting stays trivial.** Reaching a database is the first thing every
user does and the place they give up. Prefer the fewest fields that can work,
real defaults, and one verified path per engine. Do not inherit DopeDB's
property-tab surface just because it exists — every extra option has to earn
its place against the cost of a longer first run. Where the OS already owns a
mechanism, delegate to it rather than rebuilding it in a form: SSH tunnelling
takes a `~/.ssh/config` host alias and spawns the system `ssh`, so keys,
passphrases, agents, and ProxyJump stay outside the app.

**3. The Agent does the work; the screen watches, approves, and undoes.** A
connection-pinned Agent does most of the database work by hand-free command.
When deciding whether a feature belongs, ask in order:

1. Can the Agent not do this? Credential entry, write approval, result
   inspection, audit review, and schema verification are the screen's job.
2. Does Agent autonomy make this more necessary? A boundary that undoes an
   execution, a handle that stops a runaway, and preserved results all matter
   more as the Agent gets more autonomous.
3. Would the Agent do it faster in SQL or in conversation? Then do not build
   it. Re-querying with new conditions, object DDL authoring, revision
   diffing, and inline completion are better as one sentence than as buttons.

Agents are attached over ACP (Agent Client Protocol). Run the official adapters
Anthropic and OpenAI publish, unmodified, and let the user's local `claude` /
`codex` login own authentication — the app never reads or refreshes a token and
never offers a login. Holding that line is what keeps subscription users
working, and it means a policy change at one provider drops only that adapter.
Do not build a bespoke chat protocol or a per-provider integration.

Never call a provider's API from the app. All provider traffic goes through the
official CLI binary, and side features are not exempt — showing subscription
usage is subject to the same rule. Reading a stored token to call
`api.anthropic.com` or a provider backend directly is a prohibited path, not a
shortcut. Anthropic began enforcing this server-side in March 2026, rejecting
requests that do not come through the CLI binary; what got cut off then were
open-source tools using tokens directly, not large products.

The Agent can only judge well when it sees the real schema, so introspection
breadth and depth outrank visual features.

[`docs/DopeDB_VISUAL_REFERENCE_SPEC.md`](docs/DopeDB_VISUAL_REFERENCE_SPEC.md)
owns the per-feature decision table. Anything decided `구현 안 함` or `범위 밖`
is not built regardless of tracker priority and gets no label, icon, or
disabled placeholder; anything `미결` is not started. To reverse a decision,
change that table first and the screen second.

## UI/UX source of truth

- DopeDB 2026.1 is the primary clean-room UI/UX target **for features that
  pass the product-direction test above**. Follow its structure, density, and
  interactions; do not inherit its feature list. Use
  [`docs/DopeDB_PARITY_IMPLEMENTATION_TRACKER.md`](docs/DopeDB_PARITY_IMPLEMENTATION_TRACKER.md)
  to track visible parity and functional parity separately.
- Tailwind v4 and DopeDB semantic primitives are the implementation system, not
  a competing visual direction. Do not reintroduce Orca/Chat2DB styling when it
  conflicts with an observed DopeDB reference.
- A DopeDB screenshot baseline proves only self-consistency and must never be
  used to declare DopeDB parity. Compare the same scenario against a
  versioned DopeDB reference and keep `wrong`, `partial`, and `missing` gaps
  explicit.
- Do not add enabled controls that merely look like DopeDB. Every enabled
  control needs a real command and state owner; list missing functionality in
  the tracker instead of hiding it behind visual imitation.

## UI migration discipline

- New or changed UI uses static `tw:` Tailwind v4 utilities directly in TSX
  with roles exposed by `src/design-system/index.css`.
- Do not add screen-level CSS, component CSS, CSS modules, or `styles.ts`
  objects that merely store utility strings.
- Search the design system before creating a control. If a visual/interaction
  pattern repeats, promote it to a real shared component or canonical primitive
  and document it in `src/design-system/README.md`; do not copy its class list.
- When a feature is migrated, delete its legacy selectors, stylesheet import,
  and obsolete file in the same change. Never style the same responsibility
  through Tailwind and legacy CSS at once.
- CSS is reserved for documented vendor integration, global reset, tokens, and
  canonical primitives. Shell, tool-window, and data-grid layout belong to
  static Tailwind utilities and shared React primitives. A new exception
  requires an explicit rationale in the design-system README.
- Raw colors and dynamically assembled utility fragments are forbidden.

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
