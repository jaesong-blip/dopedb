# DopeDB

DopeDB is a **free, open-source database workspace where teams and AI agents
share access without sharing database credentials**. A team shares a secretless
connection and policy. Each member uses a local credential or receives a
least-privilege, short-lived managed credential. Codex and Claude work inside a
session pinned to the exact workspace, account, connection revision, and local
policy, while database traffic, approval, stop, recovery, and audit stay at the
Desktop boundary. The public build is currently an alpha.

- Website: https://dopedb.dev (Korean: https://dopedb.dev/ko)
- Download: [Windows x64](https://github.com/json-choi/dopedb/releases/latest/download/DopeDB-windows-x64-setup.exe) · [macOS Apple Silicon](https://github.com/json-choi/dopedb/releases/latest/download/DopeDB-macos-arm64.dmg) · [macOS Intel](https://github.com/json-choi/dopedb/releases/latest/download/DopeDB-macos-x64.dmg)
- Korean: [README.md](./README.md)
- Project docs: [docs/PROJECT.md](./docs/PROJECT.md)
- Product direction: [docs/PRODUCT_POSITIONING.md](./docs/PRODUCT_POSITIONING.md)

## Features

- Personal and team workspaces, device sign-in, invitations, membership, and roles
- Secretless shared connection templates with per-member local credential binding
- Member-specific short-lived managed access for PlanetScale, Neon, and GCP Cloud SQL
- PostgreSQL, MySQL/MariaDB, SQLite, and MongoDB connections and schema introspection
- Official Codex and Claude ACP sessions pinned to exact connection authority, plus an advanced Shell Terminal
- Local `dopedb` CLI Broker with no listening port or separate server
- Read-only defaults, SQL classification, immutable write proposals, and exact approval
- Cancellation, manual transaction rollback, durable results, and hash-chained audit
- Live in-app view of agent query results
- Korean/English support across the marketing site, desktop client UI, and GitHub README
- macOS/Windows downloads and Tauri updater metadata through GitHub Releases

## Why DopeDB

There are already excellent database clients, AI SQL generators, and general MCP
servers. DopeDB does not compete on their feature count. It focuses on letting a
team share one database access path without creating a shared password or broad
Agent authority.

- The workspace shares connection identity, provider resource, environment policy,
  grants, and revisions, but never puts a long-lived secret in the shared record.
- A member uses their OS credential store or a provider-issued, member-specific
  short-lived credential held only in process memory.
- An official Codex or Claude ACP session sees the exact Desktop-selected authority,
  not every saved connection through an always-on general MCP server.
- SQL reads use `query plan` and single-use `query run`; writes and DDL become
  immutable proposals that only a human can approve for the exact payload.
- The screen can stop execution, roll back a manual transaction, and preserve the
  result, approval, and receipt trail for review.

## Language Support

- Website: [English](https://dopedb.dev/) / [Korean](https://dopedb.dev/ko)
- Desktop client: choose Korean or English from Settings -> Language
- GitHub README: [Korean](./README.md) / [English](./README.en.md)

## Development

Requirements:

- Rust stable 1.94 or newer
- Node.js 24
- pnpm 11.17.0
- Xcode Command Line Tools for macOS builds

```sh
pnpm install
pnpm tauri dev
```

`pnpm tauri dev` and `pnpm tauri build --debug` run as `DopeDB Dev` with the
`dev.dopedb.desktop.dev` identifier. Development therefore cannot replace the
installed DopeDB in the Dock or publish over its local Broker runtime. On macOS the
development runner also keeps a stable development signing identity across rebuilds.

Useful checks:

```sh
pnpm build
pnpm site:build
pnpm build:sidecars
cargo check --workspace
```

`pnpm build:sidecars` stages the Local Broker `dopedb` CLI and the pinned official
Cloud SQL Auth Proxy. Settings -> Agent
tools detects the official Codex and Claude Code user Skill locations and installs
the small DopeDB discovery Skill after one explicit confirmation. The version-matched
full guide remains embedded in the signed CLI and is available offline. Existing or
user-modified files are never overwritten silently: DopeDB shows each path conflict
and preserves the old directory before an explicit repair. The same screen can preview
and remove exact retired DopeDB MCP entries without changing unrelated client settings.

## Releases

Only the repository owner publishes stable versions. After an owner-created `app-v*` tag points to a commit merged into `main`, approval of the `stable-release` environment lets GitHub Actions collect the Apple Silicon and Intel macOS artifacts, Windows x64 NSIS installer, and updater metadata in a draft before publishing them together. The tag and assets of each new published release are then protected by release immutability.

```sh
git tag app-v0.1.1
git push origin app-v0.1.1
```

The release workflow requires the `TAURI_SIGNING_PRIVATE_KEY` repository secret. Contributors can publish isolated, unsigned canary prereleases from their own `work/<github-login>/<topic>` branches. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the branch, pull request, and canary workflow.

## macOS Warning

macOS alpha builds published before the first Developer ID-signed and notarized release can show an unidentified developer warning. After confirming the file came from GitHub Releases, open System Settings -> Privacy & Security -> Open Anyway.

If you need to remove the quarantine flag from Terminal, copy DopeDB to Applications first, then run:

```sh
sudo xattr -dr com.apple.quarantine /Applications/DopeDB.app
open /Applications/DopeDB.app
```

Replace `/Applications/DopeDB.app` if the app lives somewhere else. This command removes the macOS quarantine flag from the downloaded app, so only use it for files you verified came from the official GitHub Release.

## Windows Warning

Windows alpha installers published before code signing is enabled can show a Microsoft Defender SmartScreen warning. After confirming the file came from the official GitHub Release, choose More info -> Run anyway. This path applies only to pre-signing alpha installers and must not be used for executables from an unverified source.

## License

MIT License. See [LICENSE](./LICENSE).
