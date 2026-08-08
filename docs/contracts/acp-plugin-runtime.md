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
artifact URL and independent signature, size budgets, license inventory, SBOM
digest, release/revocation timestamps, and rollout cohort. The outer envelope
owns a separate manifest digest, signature, and key ID. Shape validation is not
signature verification; the installer must verify both signatures against the
bundled DopeDB key before any archive is extracted or activated.

The command schema is version 7 because Agent registration now carries the
closed `pluginId` rather than the former adapter enum. Desktop and its private
Agent bridge are released together and must negotiate that exact schema.

## Migration state

The signed installer/activator is the next implementation boundary. Until it
owns the adapter entrypoint, the private Agent bridge still maps the closed
plugin ID to the former pinned npx package internally. That transitional mapping
is not part of the wire contract and cannot be supplied by a renderer, CLI, or
Agent. It is deleted when plugin activation replaces the system npx launcher.
