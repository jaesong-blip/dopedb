# Collaboration workflow

AI assistants must read and follow both `AGENTS.md` and `CLAUDE.md` before changing this repository. `CONTRIBUTING.md` is the human-facing workflow; when collaboration or release rules change, keep all three files synchronized in the same change.

## Commit messages

Write commit messages according to [`docs/commit.md`](docs/commit.md).

## Choose the workflow

Before changing files, confirm both identities and inspect the worktree:

```sh
login="$(gh api user --jq .login)"
owner="$(gh repo view --json owner --jq .owner.login)"
git status --short --branch
```

Never discard another person's uncommitted work.

The shared workstation keeps `jaesong-blip` as the default GitHub CLI account.
For this repository, `jaesong-blip` and `json-choi` are the same human
operator. Configure every checkout's commit identity with
`pnpm repo:identity`. For one owner-attributed operation, use
`pnpm gh:owner -- gh ...` or `pnpm gh:owner -- git push ...`. The wrapper
verifies `json-choi` and always restores `jaesong-blip`; do not use raw
`gh auth switch` during repository work. If a killed process leaves stale
state, confirm no wrapper is active and run `pnpm gh:restore`. See
[`docs/github-account-switching.md`](docs/github-account-switching.md).

### Repository operator

When the remote owner is `json-choi` and `login` is either `jaesong-blip` or
`json-choi`, work directly on a clean, up-to-date `main`. Do not create a work
branch, pull request, or additional worktree unless the user explicitly
requests it.

1. Run `pnpm repo:identity`.
2. Reuse an existing GitHub Issue for the user request or create one before committing.
3. Implement and run the relevant validation on `main`.
4. Write a Korean Conventional Commit with `Refs: #<number>` or `Closes: #<number>` in the footer.
5. If `jaesong-blip` is active, push with `pnpm gh:owner -- git push origin main`.
6. Verify the required `build` and `windows-check` jobs after the push. If either fails, fix it under the same issue.

The owner administrator bypass is used only to omit the pull-request requirement. It does not permit force-pushing, deleting `main`, concealing failed validation, or bypassing release restrictions.

### Contributors

Each non-owner contributor works in a branch under their GitHub login:

```text
work/<github-login>/<short-topic>
```

For example, `PENEKhun` uses `work/PENEKhun/query-history`. Open a pull request into `main` when the change is ready. `main` requires the macOS and Windows CI jobs, one approval, resolved conversations, and an up-to-date branch. Force pushes and deletion are blocked.

Files that control GitHub Actions or the application version are owned by `@json-choi` through `CODEOWNERS`, so changing them also requires the owner's review.

The branch login segment is case-sensitive and must match the authenticated login exactly. Contributors must not push directly to `main`, use another contributor's namespace, or bypass required checks and reviews.

## UI changes

Before editing TSX, CSS, Tailwind utilities, or layout, read
[`src/design-system/README.md`](src/design-system/README.md) and
[`docs/testing/visual-regression.md`](docs/testing/visual-regression.md).
New and migrated screen layout uses Tailwind CSS v4 utilities with the `tw:`
prefix. Use only theme roles backed by DopeDB's semantic tokens; do not add
raw color utilities or assemble class names dynamically. Preflight remains
disabled during the incremental migration, while shared controls continue to
use the canonical `.btn`, `.badge`, `.ds-*` primitives.

When migrating a screen, remove its obsolete CSS import and file in the same
change. Run `pnpm check:ui`, the relevant app build, and the focused visual
regression test. Inspect changed screenshots rather than accepting a new
baseline merely to make CI pass.

## Personal canary builds

Push your work branch, then dispatch the trusted workflow from `main`:

```sh
git push -u origin work/<github-login>/<short-topic>
gh workflow run canary.yml \
  --ref main \
  -f source_ref='work/<github-login>/<short-topic>'
```

The login in `source_ref` must exactly match the account that starts the workflow. A successful run publishes an immutable prerelease named `canary-<github-login>-<run>-<attempt>` through the contributor's own `canary-<github-login>` environment.

Canary installers are deliberately unsigned and do not include Tauri updater artifacts or `latest.json`. They are isolated from the stable updater and are for internal testing only.

## Stable releases

Only `@json-choi` publishes stable versions:

1. Create or reuse a release issue.
2. Update `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, the `dopedb` entry in `Cargo.lock`, `dopedb-cli/Cargo.toml`, and the `dopedb-cli` entry in `Cargo.lock` to the same version directly on an up-to-date `main`.
3. Commit with the issue footer, push normally, and verify the required CI jobs pass.
4. Create and push `app-vX.Y.Z` from that `main` commit.
5. Approve the pending `stable-release` environment deployment.

All tags other than `canary-*` are owner-only. The release workflow rejects tags whose version sources do not match or whose commit is not in `main`. It uploads all installers to a draft, then publishes the completed release so release immutability can protect its tag and assets.
