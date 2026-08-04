# Provider access migration inventory

Status: active compatibility boundary for #98

This inventory classifies every Provider access entry point before CLI-driven
provisioning is introduced. It does not authorize another Provider. DQ-18 in
`DopeDB_VISUAL_REFERENCE_SPEC.md` owns that decision; until it changes, only
Neon, GCP Cloud SQL, and PlanetScale may appear in the managed Provider catalog.

## Contract that remains public

Provider discovery and connection provisioning are separate capabilities:

- Discovery produces a server-reconstructed, redacted resource projection and an
  opaque, member/session-bound receipt.
- Import consumes that receipt to create or replace one shared connection whose
  administrator write policy starts disabled. Browser-supplied provider identifiers
  are not an import authority.
- Managed access issues one member-specific, short-lived credential. GCP Cloud SQL
  may issue the separately provisioned write principal only when the current
  Admin/Owner DB policy, member role, and connection grant all permit it.
- The current GCP bootstrap owns provider-side IAM, read/write service accounts,
  and database-user changes. Future CLI provisioning must preserve that capability
  boundary rather than infer it from a catalog label.

The persisted discovery manifest remains the compatibility schema:

```json
{
  "discover": true,
  "importReadOnly": true,
  "managedLease": true,
  "write": true
}
```

`write` records whether the exact provider resource has a separately provisioned
write credential; it is not the administrator policy and cannot by itself authorize
a write. GCP resources discovered through a newly completed bootstrap may set it to
`true`; legacy GCP rows and other providers remain `false`.

## Entrypoint inventory

| Layer | Entrypoint | Decision | Owner / removal condition |
| --- | --- | --- | --- |
| Web UI | `ProviderIntegrationList`, `GcpCloudSetup`, `ProviderResourcePicker`, `useProviderAccess` | keep | Current account connection, redacted discovery, safe-default import, GCP read/write bootstrap, and administrator DB write policy flow. Provider-specific setup is selected by the server catalog, not a planned UI placeholder. |
| Catalog API | `GET /api/v1/workspaces/:id/provider-integrations` | keep, narrowed | Returns only the three working adapters and no write capability claim. DQ-18 must change before another descriptor is added. |
| Integration mutation | `POST/DELETE /provider-integrations` and provider OAuth callbacks | keep | Current Neon, GCP Cloud SQL, and PlanetScale authorization boundary. Replacement is #99/#100, after equivalent CLI setup and rollback exist. |
| Discovery | `GET /provider-integrations/:id/resources` | keep | Provider response is bounded, normalized server-side, and projected into opaque receipts. |
| Import | `POST /provider-integrations/:id/imports` | keep | Receipt-only, idempotent shared connection import with `allowWrites: false`. A later administrator action owns the durable write policy. |
| GCP setup | `gcp-setup/:setupId`, `gcp-cloud-sql/callback`, `gcp-cloud-bootstrap.ts` | migrate | Current keyless OAuth bootstrap creates separate least-privilege read/write principals and replaces the removed seven-field manual form. #100 may move these changes behind CLI provisioning; do not expose WIF coordinates, service-account ids, or trust configuration to the browser. |
| Managed lease | `POST /connections/:id/lease` and `/managed-access` | keep | Issues/revokes short-lived read or role-gated GCP write credentials. Every write issuance rechecks the live role, connection grant, administrator policy, and canonical provider capability. #99 owns the future CLI runner, not this connection lease contract. |
| Local target | `provider-local-target` web route and desktop `provider_local_target.rs` | keep | Revalidates the exact provider resource and TLS/connector material before the local pool opens. |
| Desktop Provider authority | `src-tauri/src/features/providers` | keep | Authenticated inventory, OS credential binding, exact revalidation, and local GCP ADC boundary. |
| Desktop connection runtime | `connection/runtime/authority.rs`, `remote_authority.rs`, `cloud_sql_proxy.rs` | keep | Obtains the one-time lease into process memory, owns proxy/pool lifetime, and releases the lease. |
| Storage | `workspace_provider_integration`, `workspace_provider_resource`, discovery receipt/import request, credential lease tables | keep | Secret-bearing integration authorization stays separate from redacted shared connection records. Existing generation and revocation gates remain authoritative. |
| Workspace backup | `workspace-backup-core.ts` | keep | Backs up only connection metadata. Provider grants, discovery receipts, leases, and credentials intentionally have no snapshot representation. Historical connection write preferences are normalized to the read-only contract on restore. |
| Legacy GCP rows without a verification target | local-authority projection and desktop `authority.rs` | remove after reconnect | Exposed only as `reconnect_required`; never accepted as active authority. Delete after all deployed rows have reconnected and a production count is zero for one release window. |
| Manual GCP trust form | pre-bootstrap browser fields for project/WIF/service accounts/admin confirmations | removed | Replaced by OAuth target selection and server-side bootstrap. A browser contract carrying these values must not return. |
| Planned Provider catalog entries | AWS, OCI, Atlas, Generic managed placeholders | removed | #106/DQ-18 owns any future choice. No label, icon, disabled row, or capability declaration before that decision. |
| Pipedream runtime assumption | roadmap-only future authentication shortcut | removed | It is not a dependency of the current or CLI provisioning architecture. A future adapter requires a fresh product decision. |

## Compatibility and rollback order

1. Keep parsing the current manifest and all existing redacted connection fields.
2. Keep target-less GCP rows visible only as `reconnect_required`; never synthesize
   an active verification target.
3. Land the #99 CLI runner and provider-neutral provisioning receipt without
   deleting current discovery, import, or read lease paths.
4. Land each #100 provider provisioner with drift detection and explicit rollback.
5. Migrate one provider at a time. A provider can stop using its legacy setup path
   only after old records can reconnect or roll back through the new path.
6. Remove legacy storage and code only after #102 verifies issuance, drift,
   revocation, restart recovery, log redaction, and old-record compatibility.

Rollback always restores the preceding adapter selection. It never copies a
Provider token, short-lived database password, WIF coordinate, or service-account
key into a connection template, backup, log, analytics event, or browser response.

## #99 provider-neutral lifecycle

The desktop now owns one provider-neutral, secret-free lifecycle before any legacy
setup path is removed:

- `detect → discover → plan → approve → apply → verify → issue → reconcile → destroy`
  is represented by closed enums and a revision-fenced receipt in the active
  workspace/account scope.
- Every mutating plan is persisted as a hash-pinned `ProviderAction` Operation and
  uses the existing exact local approval boundary. Production targets are critical
  operations and require the exact confirmation phrase.
- Discovery ids are short-lived and process-local. Durable plans retain only a
  validated display projection, target selectors, fingerprints, action enums, and
  the adapter manifest hash; credentials, raw Provider output, CLI stderr, and
  command output are absent from the renderer and receipt table.
- The shared process runner executes a previously audited binary directly with
  fixed argv, an allowlisted environment, bounded schema-checked stdout, timeout,
  cancellation, and process-tree cleanup. Shell and `eval` paths do not exist.
- Interrupted apply/destroy Operations resume only after the receipt, target,
  adapter manifest, payload hash, and last checkpoint all validate. Otherwise the
  receipt becomes `Needs repair` and the Operation becomes `Outcome unknown`.
- The Tailwind v4 managed-access Wizard renders only Providers registered with the
  complete lifecycle. With no concrete #100 driver, no label, icon, button, or
  disabled placeholder is shown. This keeps the current legacy setup path active
  until each Provider can apply, verify, repair, and destroy safely.

## Verification gates

- The catalog API returns exactly Neon, GCP Cloud SQL, and PlanetScale.
- No catalog response contains `planned`, `supportsReadWrite`, or an equivalent
  optimistic write claim.
- Discovery/import continues to require `importReadOnly: true`, a boolean `write`
  capability, and managed lease support. Import still persists `allowWrites: false`.
- A GCP write lease requires the canonical resource's `write: true`, a live
  Editor/Admin/Owner role, a `use`/`manage` connection grant, and the Admin/Owner
  connection policy at both request and final issuance time.
- Existing target-less GCP rows remain reconnect-only; an active row without an
  exact target remains invalid.
- Workspace backups remain provider-secret-free and restore old connection
  metadata into the current read-only policy.
- TypeScript, Rust, and workspace-cloud builds pass before #98 is closed.
