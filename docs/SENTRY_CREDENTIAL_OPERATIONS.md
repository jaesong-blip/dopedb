# Sentry credential operations

## Local personal Sentry CLI credential

The personal Sentry management credential for this workstation is stored in
the macOS login keychain, not in this repository, an `.env` file, shell
configuration, or CI configuration.

- Keychain service: `com.dopedb.sentry.personal`
- Account label: `personal`
- Display name: `DopeDB Sentry (personal)`

The entry is used only for local Sentry CLI administration, such as creating
projects and uploading release artifacts. It is not the runtime credential for
the desktop app. The app uses a project DSN after Sentry monitoring is set up;
an auth token must never be bundled into an app build.

Run local commands through `scripts/sentry-personal.sh`, for example:

```bash
scripts/sentry-personal.sh org list --json
```

The script reads the Keychain value only into the child `sentry` process. It
overrides any inherited `SENTRY_AUTH_TOKEN` for that one command and does not
modify the calling shell.

## Desktop monitoring project

- Organization: `dopedb`
- Team: `dopedb`
- Project: `dopedb-desktop`
- Platform: `javascript-react`
- Release name: `dopedb@<app version>`

The React SDK sends production error events only. Session Replay, tracing,
logs, console/network breadcrumbs, default PII, and benchmark reporting are
disabled. The client filter removes user, request, breadcrumb, extra, context,
transaction, message, SQL, chat, and workspace payloads before sending an
event; stack structure and allowlisted surface/runtime tags remain.

Stable release builds upload hidden source maps from only one matrix worker,
then remove map files from the packaged frontend. GitHub Actions reads the
upload credential from the approval-protected `stable-release` environment secret
`SENTRY_AUTH_TOKEN`.
That secret currently mirrors the authorized personal Keychain credential. If
the personal token is rotated or an organization-scoped CI token is introduced,
update the GitHub secret at the same time; the repository never stores either
value.

## Safety rules

1. Never print, commit, paste into chat, or put the credential in a project
   file. Use `security find-generic-password` without `-w` only to confirm the
   entry exists.
2. A token exposed outside Keychain must be revoked in Sentry and replaced.
3. When an organization-specific credential is required, add a separately
   named Keychain entry; do not overwrite `personal` silently.
4. Inject a selected token only into the one Sentry CLI process that needs it,
   then clear the environment variable. CI reads only the protected environment
   secret and never reads the workstation Keychain directly.

## Account changes

Before changing the default account, identify the Sentry organization and
project explicitly. Update the Keychain entry only through a secure local
prompt, then confirm its presence without reading the password value. Record
the non-secret service and account labels here if a new profile is added.
