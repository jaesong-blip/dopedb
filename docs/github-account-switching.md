# GitHub account and commit identity

The shared development machine keeps `jaesong-blip` as the default active
GitHub CLI account. For this repository, `jaesong-blip` and `json-choi`
represent the same human operator and both use the direct-`main` workflow.
Do not create a work branch or additional worktree unless the user explicitly
requests one.

Every commit must use the repository-local `json-choi` identity. Configure a
new checkout, or repair a changed local Git configuration, with:

```sh
pnpm repo:identity
```

An operation that GitHub must attribute to the repository owner temporarily
uses `json-choi` only through the repository wrapper:

```sh
pnpm gh:owner -- gh issue edit 123 --add-label security
pnpm gh:owner -- git push origin main
```

The wrapper:

- accepts only a `gh` command or `git push`;
- rejects nested `gh auth` changes;
- verifies the active default account and repository owner;
- serializes account-scoped commands with a per-user lock;
- verifies `json-choi` before running the command;
- restores and verifies `jaesong-blip` on success, failure, or a handled signal;
- returns the wrapped command's original exit status unless restoration fails;
- never reads, prints, copies, or stores a token.

Normal reads and non-owner GitHub operations keep using `jaesong-blip`. Direct
`main` pushes, protected tags, stable releases, environment approvals, and
repository-administration calls use the wrapper so GitHub records
`json-choi` as the actor.

If a process is killed before cleanup completes, first confirm that no wrapper
process is still active, then recover the default account and stale lock:

```sh
pnpm gh:restore
```

Do not use a raw `gh auth switch` for repository work. Do not run multiple
account-switching commands concurrently. The wrapper changes the host-wide
active GitHub CLI account briefly, so keep the wrapped operation minimal.
