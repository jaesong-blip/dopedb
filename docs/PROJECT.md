# DopeDB Project Guide

This is the single maintained project document for DopeDB. Keep the root README files short and update this file when architecture, release, or safety behavior changes.

## Product

DopeDB is a local-first desktop database client built with Tauri. It lets a user inspect and operate databases manually, and it runs AI tools in a connection-pinned Terminal that reaches the Desktop trust boundary through the local `dopedb` CLI without receiving raw credentials.

Current scope:

- Desktop app: Tauri v2, Rust core, React UI, Vite
- Landing site: Next.js under `site/`, hosted at https://dopedb.dev
- Databases: PostgreSQL, MySQL/MariaDB, SQLite, MongoDB
- Agent runtime: connection-pinned Shell, Codex, and Claude PTY sessions
- CLI: owner-local UDS/named-pipe Broker plus the bundled `dopedb` sidecar
- Distribution: GitHub Releases and Tauri updater metadata

Planned team collaboration, workspace-scoped provider integrations, shared
connections, dashboards, and saved agent analysis are specified in the
[Workspace Collaboration Roadmap](./WORKSPACE_ROADMAP.md).

## Architecture

The Rust core owns the trust boundary:

- `driver/`: driver catalog, compatibility/recommendation, install state, and runtime dispatch
- `connection/`: connection profiles, concrete pools, provider tuning, and OS credential-store-backed secrets
- `safety/`: SQL classification, read-only enforcement, preview, and approval policy
- `executor/`: read execution and gated write execution
- `audit/`: query history and hash-chained audit records
- `services/`: transport-neutral connection, catalog, query, dashboard, and operation behavior
- `operations/`: immutable exact-payload plans, approvals, claims, and lifecycle receipts
- `broker/`: owner-local, versioned UDS/named-pipe control messages for the CLI
- `cli_install.rs`: bundled in-app resolver and explicit per-user CLI/PATH installation
- `skills/`: bounded inventory plus atomic Codex/Claude Code Skill install, repair,
  backup, and removal
- `terminal/`: connection-pinned PTY lifecycle, secret-free child environment, and process-tree cleanup
- `legacy_mcp_cleanup.rs`: explicit preview, backup, and targeted cleanup for retired client entries
- `store/`: local SQLite app store under the platform app data directory, including
  connection-scoped saved dashboard definitions

The frontend renders database state and approval decisions. It does not own the safety decision.
Writes and DDL require an immutable Operation proposal, an exact stored approval, and
`allow_writes = true`; transports cannot approve a replacement SQL payload.

The Local Broker is the only Agent database path for the bundled `dopedb` CLI. Public
`version`, `status`, and `app open` calls do not carry a reusable secret. Database
commands require an ephemeral in-memory Terminal capability pinned to one
workspace/account/connection revision. The global discovery file contains only
runtime metadata. The app opens no Agent HTTP or TCP listener.

The repository-owned Skill source is `skills/dopedb-cli/`. Build verification records
exact and normalized hashes in versioned bundled manifests. The installed Skill is a
small discovery stub; `dopedb skills get dopedb-cli --full` returns the exact guide and
references embedded in that app version without contacting the network. Inventory scans
are bounded and reject symlinks/reparse points. Only a known, byte-exact managed snapshot
may be updated or removed automatically; repair preserves every conflicting directory.

## Agent Terminal and CLI Behavior

Opening an Agent Terminal creates a PTY session pinned to the selected workspace,
account, connection revision, and database policy. Shell, Codex, and Claude profiles
share the same lifecycle. A connection, account, membership, or authority change
revokes the session instead of silently retargeting it. The child environment excludes
database URLs, provider secrets, API keys, and OS credential-store values.

The signed `dopedb` CLI discovers an owner-only Unix socket or Windows named pipe.
Database commands require an ephemeral Terminal-session capability that lives in
process memory. The capability is never a database credential, never enters argv, and
cannot be moved to another Terminal. The command surface covers secret-free connection
summaries, canonical catalog/schema/table metadata, typed MongoDB reads, SQL read
planning/execution, provenance-bound dashboard creation, immutable SQL proposals, and
operation receipts.

The desktop Agent activity view keeps at most 200 in-memory completion records containing
only command, request/session/connection identifiers, state, and a stable error code. It
does not retain result rows, SQL text, Terminal output, session tokens, or credentials.

Every SQL data read is a mandatory two-step operation. `dopedb query plan` validates
one SELECT, runs non-executing EXPLAIN, gathers aggregate database-pressure signals, and
returns an expiring single-use plan. `dopedb query run` accepts only that plan identifier,
not replacement SQL or a connection. The database read-only session remains the
authoritative guard. MongoDB uses `dopedb document run` with bounded `find`, `aggregate`,
or `count` JSON shapes; unknown fields and write stages such as `$out` or `$merge` fail
closed.

Each successful SQL query returns a durable `queryRunId`. After explicit user agreement,
`dopedb dashboard create` must reference that exact ID from the same Terminal. DopeDB
loads the connection and SQL from the successful history row instead of accepting
replacements. Dashboard creation writes only to `app.db`. Opening a dashboard reloads
and revalidates its versioned declarative visualization (`auto`, `metric`, `line`, `bar`,
or `table`) and executes through the read-only database path. Result rows are not stored.

Query planning never sends other sessions' SQL text, users, client addresses, or
parameters to the agent. It returns aggregate connection usage, active/long-running
query counts, lock-wait counts, and replication lag when the engine exposes them.
PostgreSQL can grant or revoke `pg_monitor` from Safety settings through one fixed,
explicitly confirmed and separately audited command. MySQL uses available Performance
Schema aggregates; SQLite reports basic local coverage.

Settings -> Agent tools installs the version-matched discovery Skill for Codex and
Claude Code. It also offers a separate legacy cleanup flow: inspect exact retired DopeDB
MCP client entries, show a redacted diff, require confirmation, preserve unrelated
settings, and back up edited client files. Retired app-owned bearer metadata is erased
without copying the secret into a backup. Existing chat history remains a read-only
archive; there is no in-app live chat execution path.

## Safety Model

The important rules are enforced in Rust:

- Reads run through read-only database sessions.
- Writes are off by default per connection.
- A write or DDL path requires `allow_writes = true`.
- Manual writes require an approval card unless the connection policy explicitly disables approval.
- Migrations also run through the same write gate.
- Successful and blocked execution paths are audited.

Skill text, agent prompts, and CLI output are guidance, not security boundaries.

## Development

Required local tools:

- Rust stable 1.94 or newer
- Node.js 24
- pnpm 11.17.0
- Xcode Command Line Tools

Main commands:

```sh
pnpm install
pnpm tauri dev
pnpm build
pnpm site:build
pnpm build:sidecars
cargo check --workspace
```

Both external binaries must exist before Tauri validates `bundle.externalBin`.
`pnpm build:sidecars` builds the host `dopedb` binary and stages it together with the
version- and SHA-256-pinned official Cloud SQL Auth Proxy in
`src-tauri/binaries/`.

## Landing Site

The site lives in `site/`.

- Canonical domain: https://dopedb.dev
- Framework: Next.js app router
- SEO files: `site/app/robots.ts`, `site/app/sitemap.ts`
- Product preview image: `site/public/dopedb-dashboard.png`
- Preview generator: `site/scripts/generate-preview.py`

Local commands:

```sh
pnpm site:preview-image
pnpm site:dev
pnpm site:build
```

Vercel should use `site` as the root directory.

## CI and Releases

CI runs on pull requests and `main` pushes:

- install root and site dependencies
- build desktop frontend
- build landing site
- stage the CLI sidecar
- run `cargo check --workspace`

Stable release runs only on an owner-created `app-v*` tag whose commit is already in `main` and whose version matches `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and `Cargo.lock`. The `stable-release` environment requires approval from `@json-choi` before the signing key and write token are available:

- build macOS Apple Silicon artifact
- build macOS Intel artifact
- build Windows x64 NSIS installer with `src-tauri/tauri.windows.conf.json`
- upload stable direct-download aliases:
  `DopeDB-windows-x64-setup.exe`, `DopeDB-macos-arm64.dmg`, `DopeDB-macos-x64.dmg`
- upload installers, updater archives, signatures, and `latest.json`
- keep the release as a draft until every matrix build and stable alias upload succeeds, then publish it for immutable tag and asset protection

Contributors use `work/<github-login>/<topic>` branches and may manually dispatch `.github/workflows/canary.yml` from `main` for their own branch only. Canary builds publish through a per-user `canary-<github-login>` environment as unsigned prereleases without updater artifacts, updater signatures, or `latest.json`. See `CONTRIBUTING.md` for the exact commands.

Required GitHub secret:

```txt
TAURI_SIGNING_PRIVATE_KEY
```

The local updater key path used during setup was `~/.tauri/dopedb-updater.key`. Do not commit private keys.

## Dependency Policy

Use the latest stable compatible library versions, including major releases, and
update the affected safety tests whenever an upgrade changes parser, database, broker,
or credential-store behavior. The desktop and both Next.js apps build with
TypeScript 7. pnpm 11 supply-chain policy, Next.js CLI type-checking, and audited
toolchain holds are documented in [`dependencies.md`](dependencies.md).

## macOS Distribution

The app is currently distributed outside the Mac App Store. Until Developer ID signing and notarization are configured, macOS can show an unidentified developer warning. Users should only bypass the warning after confirming the file came from the official GitHub Release.

User-facing bypass path:

1. Try opening DopeDB once.
2. Open System Settings -> Privacy & Security.
3. Choose Open Anyway for DopeDB.
4. Confirm Open.

Terminal alternative after copying the app to Applications:

```sh
sudo xattr -dr com.apple.quarantine /Applications/DopeDB.app
open /Applications/DopeDB.app
```

Only document this command with the release-origin warning. It removes the macOS quarantine flag from the downloaded app and should not be presented as a general bypass for untrusted binaries.

## Deferred Work

- Developer ID signing and notarization
- More structured Agent proposal types beyond SQL
- SSH tunnel support
- More granular Agent and plugin origin handling
- Virtualized result grid for very large result sets
