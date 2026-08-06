# Explorer scope badge audit

This audit records one bounded #111/#112 comparison. It does not declare full
DopeDB parity.

## Evidence

- Before: [`01-explorer-scope-before.png`](./01-explorer-scope-before.png)
- DopeDB 2026.1 reference:
  [`../DopeDB-design-analysis-2026-07-08/06-database-explorer-screenshot-section.png`](../DopeDB-design-analysis-2026-07-08/06-database-explorer-screenshot-section.png)
- After: [`02-explorer-scope-after.png`](./02-explorer-scope-after.png)
- Canonical icon-command focus tooltip:
  [`03-erd-tooltip-focus-after.png`](./03-erd-tooltip-focus-after.png)

The DopeDB captures use the same `1393×862` browser projection and deterministic
PostgreSQL catalog fixture. Browser projection verifies layout and accessible text,
not Tauri runtime behavior or platform rendering.

## Gap and correction

The reference keeps the selected and available introspection counts together on the
data-source row. DopeDB already did this for multi-schema catalogs, but collapsed a
single-schema catalog to the ambiguous label `1`. The trigger now always renders
`selected of total`, including `1 of 1`, and opens the existing persisted schema
checklist. No new feature or inactive control was added.

## Acceptance

- The data-source row exposes both selected and total namespace counts in every
  non-empty catalog.
- The count remains a compact tree badge and does not add another row suffix.
- The button keeps the accessible name `Introspection scope` / `인트로스펙션 범위`.
- The menu continues to edit the same persisted filter used by Explorer and query
  scope.

The wider shell, data editor, Agent, popup and compact-platform scenarios remain
open until the same before/reference/after and packaged macOS/Windows evidence exists.

## Icon-command primitive check

ERD, Documents, Schema, Dashboard, Job and Schema Diff still had 13 raw
`.btn.icon-only` commands. They now use the shared `Button`, which removes the
native `title` from the control and presents the same portal tooltip on hover and
keyboard focus. The ERD capture records the focused state. An interaction check also
confirmed `Escape` dismisses the tooltip and leaves the command focused. The static
`pnpm check:ui-primitives` rule prevents a raw icon-only button or a statically unnamed
`Button iconOnly` from entering the source tree again.
