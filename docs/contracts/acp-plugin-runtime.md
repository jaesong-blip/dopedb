# ACP plugin runtime contract

DopeDB ships one platform Node runtime and installs only the first-party Claude
or Codex ACP adapter selected by the user. The runtime, adapter plugin, local
provider CLI, provider login, and optional DopeDB Skill are separate assets and
must never share an installation state.

## Bundled Node runtime

[`runtime-catalog.json`](../../src-tauri/resources/agent-runtime/runtime-catalog.json)
is the source of truth for the Node version and the three supported stable
release targets: Apple Silicon macOS, Intel macOS, and x64 Windows. Every entry
pins the official `nodejs.org` archive URL, byte length, and SHA-256. The core
installer budget rejects an archive larger than 60 MiB.

`scripts/prepare-agent-runtime.mjs` downloads at most the exact pinned byte
length, verifies the archive before extraction, and extracts only the Node
executable and its license. It creates a target-specific executable manifest
and SPDX 2.3 SBOM and places them under
`resources/agent-runtime/node/<target>/`. Tauri bundles that directory as a
read-only application resource. npm and npx are intentionally not included.

Generated runtime bytes are ignored by Git. Stable artifacts rebuild them from
the pinned catalog so a changed upstream object fails before signing.

## Closed plugin identity

`dopedb-protocol::AcpPluginId` accepts exactly:

- `dopedb.acp.claude`
- `dopedb.acp.codex`

There is no user-provided ID, executable, package name, URL, or provider field
on the Agent registration command. The ID fixes the provider and the local CLI
environment variable (`CLAUDE_CODE_EXECUTABLE` or `CODEX_PATH`).

`SignedAcpPluginManifestV1` is the catalog wire shape. Its inner manifest owns
the upstream tag and commit, compatibility ranges, relative adapter entrypoint,
artifact URL and independent signature, packed archive hash, canonical unpacked
content-tree hash, size budgets, license inventory, SBOM digest,
release/revocation timestamps, and rollout cohort. The outer envelope
owns a separate manifest digest, signature, and key ID. Shape validation is not
signature verification; the installer must verify both signatures against the
bundled DopeDB key before any archive is extracted or activated.

The command schema is version 8. Agent registration carries the closed
`pluginId`, bundle version, the verified bundled Node path and hash, the signed
adapter entrypoint and hash, and the independently verified local provider CLI
path and hash. The private bridge re-verifies all three executables before it
starts the adapter. Desktop and its private Agent bridge are released together
and must negotiate that exact schema.

## Install, activation, and removal

The plugin manager downloads only fixed DopeDB release origins with bounded
redirects and byte counts. It verifies the signed manifest, artifact signature,
archive hash, compatibility range, and canonical content-tree hash before an
atomic stage. Archive extraction rejects absolute or parent paths, links,
special files, duplicate paths, oversized files, and file-count abuse.

The first new ACP session launches a candidate. Successful initialization
promotes it to current and last-known-good; failure quarantines it and retries
the last-known-good bundle. Removing a plugin first closes that provider's ACP
sessions and waits for their launched process trees to exit, then deletes only
that provider's managed current, staged, rollback, and quarantine files. Local
provider CLIs, logins, conversations, DopeDB Skill, the other plugin, and bundled
Node remain untouched.

## Independent adapter releases

[`catalog.json`](../../agent-runtime/plugins/catalog.json) pins the exact
official npm package, upstream tag, and commit for each adapter. The adapter
build includes only the official JavaScript and production dependencies, rejects
provider-native executables and unsafe file types, produces an SPDX 2.3 SBOM,
and enforces the 30 MiB packed budget. Claude receives the verified local CLI
through `CLAUDE_CODE_EXECUTABLE`; Codex uses `CODEX_PATH`.

`acp-adapter-release.yml` builds and signs candidate or stable adapter bundles
without changing the app, CLI, or Skill version. Compatibility CI starts each
entrypoint with bundled Node. The pin watcher opens an exact source/lock update
PR when an official adapter changes. Stable promotion is explicitly gated and
publishes immutable version artifacts plus the closed stable manifest alias.

At runtime, startup schedules (but does not await) a 24-hour-coalesced update
check for installed plugins only. Download, verification, candidate promotion,
quarantine, and removal emit categorical provider/operation/outcome telemetry;
versions, paths, failure strings, credentials, prompts, and database data are
never included.
