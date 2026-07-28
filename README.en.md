# DopeDB

DopeDB is a **free, open-source desktop app that gives AI agents a safe path to your databases**. Run Codex or Claude Code in an Agent Terminal pinned to one selected database, then use the version-matched DopeDB Skill and local CLI to inspect schemas and run queries. Raw credentials, read-only enforcement, write approvals, rollback previews, and audit logs stay under the Desktop app's control.

- Website: https://dopedb.dev (Korean: https://dopedb.dev/?lang=ko)
- Download: [Windows x64](https://github.com/json-choi/dopedb/releases/latest/download/DopeDB-windows-x64-setup.exe) · [macOS Apple Silicon](https://github.com/json-choi/dopedb/releases/latest/download/DopeDB-macos-arm64.dmg) · [macOS Intel](https://github.com/json-choi/dopedb/releases/latest/download/DopeDB-macos-x64.dmg)
- Korean: [README.md](./README.md)
- Project docs: [docs/PROJECT.md](./docs/PROJECT.md)

## Features

- PostgreSQL, MySQL/MariaDB, SQLite, and MongoDB connection management
- Connection-pinned Shell, Codex, and Claude Agent Terminals with version-matched Skills
- Local `dopedb` CLI Broker with no listening port or separate server
- Read-only defaults and SQL classification
- Approval card plus `allow_writes` gate for writes and DDL
- Query history and hash-chained audit log
- Live in-app view of agent query results
- Korean/English support across the marketing site, desktop client UI, and GitHub README
- macOS/Windows downloads and Tauri updater metadata through GitHub Releases

## Why DopeDB

There are great free database clients, and there are plenty of AI SQL generators. DopeDB closes the risky gap between them.

- It is not an AI feature bolted onto a SQL editor. It is a **local database authorization boundary your existing agent can use through a dedicated Terminal and CLI**.
- The agent does not receive raw database credentials; the local app owns connections and secrets.
- SQL reads use a two-step `query plan` and single-use `query run` flow, returning EXPLAIN and aggregate database-health cautions before execution. MongoDB uses typed document commands that reject write stages.
- Writes and DDL become immutable proposals that the CLI cannot approve; a human must approve the exact change in Desktop.
- The context your agent saw, the queries it ran, the results, approvals, and audit logs land in a UI humans can review.

## Language Support

- Website: use the top-right language switcher or `?lang=ko` / `?lang=en`
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

Useful checks:

```sh
pnpm build
pnpm site:build
pnpm build:sidecars
cargo check --workspace
```

`pnpm build:sidecars` stages only the Local Broker `dopedb` CLI. Settings -> Agent
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

Until the app is signed and notarized with an Apple Developer ID, macOS can show an unidentified developer warning. After confirming the file came from GitHub Releases, open System Settings -> Privacy & Security -> Open Anyway.

If you need to remove the quarantine flag from Terminal, copy DopeDB to Applications first, then run:

```sh
sudo xattr -dr com.apple.quarantine /Applications/DopeDB.app
open /Applications/DopeDB.app
```

Replace `/Applications/DopeDB.app` if the app lives somewhere else. This command removes the macOS quarantine flag from the downloaded app, so only use it for files you verified came from the official GitHub Release.

## License

MIT License. See [LICENSE](./LICENSE).
