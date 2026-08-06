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
- Data Sources horizontal category tabs before correction:
  [`04-data-sources-tabs-before.png`](./04-data-sources-tabs-before.png)
- Data Sources desktop rail after correction:
  [`05-data-sources-rail-after.png`](./05-data-sources-rail-after.png)
- Data Sources compact projection after correction:
  [`06-data-sources-compact-after.png`](./06-data-sources-compact-after.png)
- Settings wide rail before correction:
  [`07-settings-rail-before.png`](./07-settings-rail-before.png)
- Settings desktop rail after correction:
  [`08-settings-rail-after.png`](./08-settings-rail-after.png)
- Settings compact projection after correction:
  [`09-settings-compact-after.png`](./09-settings-compact-after.png)
- Search Everywhere oversized modal before correction:
  [`10-search-everywhere-before.png`](./10-search-everywhere-before.png)
- Search Everywhere compact blank state after correction:
  [`11-search-everywhere-after.png`](./11-search-everywhere-after.png)
- Search Everywhere `/` action mode after correction:
  [`12-search-everywhere-actions-after.png`](./12-search-everywhere-actions-after.png)
- Search Everywhere compact projection after correction:
  [`13-search-everywhere-compact-after.png`](./13-search-everywhere-compact-after.png)
- AI Chat verbose empty state before correction:
  [`14-agent-empty-before.png`](./14-agent-empty-before.png)
- AI Chat compact capability state after correction:
  [`15-agent-empty-after.png`](./15-agent-empty-after.png)
- AI Chat compact-window projection after correction:
  [`16-agent-empty-compact-after.png`](./16-agent-empty-compact-after.png)

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

## Data Sources 2026.1.4 recheck

An isolated official DopeDB 2026.1.4 (`DB-261.26222.86`) process was opened
with a clean empty project. Its native Data Sources and Drivers window measured
`980×737` before the macOS capture shadow; the application content uses a roughly
`42px` vertical category rail followed by a roughly `250px` catalog list. The
temporary reference capture has SHA-256
`0487e71353fcf36a7876b5d8bd4f50bfda8ff8df7ecc89b25f9a77eedb241852`
and is intentionally not copied into the repository.

This contradicts the earlier horizontal-category interpretation recorded in the
tracker. The correction keeps only DopeDB's already implemented Data Sources,
Clouds, and Drivers categories; it does not add DopeDB-only categories or a
disabled placeholder. The category title now appears once instead of repeating
above the list. Arrow keys and Home/End move and activate desktop rail tabs;
compact dialogs keep the existing text SegmentedControl and source selector.

## Settings 2026.1.4 recheck

The same isolated DopeDB process exposed a native Settings window measuring
`982×722`, with a roughly `202px` navigation rail and an 8px search gutter. Its
temporary reference capture has SHA-256
`6fa4a3f912c16c5aa6677db144271239351ab3768e929b1be6a9fbd2d0e9872d` and is
not copied into the repository. The previous DopeDB capture shows the obsolete
`945×700` frame and `300px` rail; the after capture records the corrected compact
hierarchy, 24px navigation rows, and flat breadcrumb surface. The compact capture
confirms the same searchable navigation remains scrollable above the document body
and that the footer action stays inside the viewport.

## Icon-command primitive check

ERD, Documents, Schema, Dashboard, Job and Schema Diff still had 13 raw
`.btn.icon-only` commands. They now use the shared `Button`, which removes the
native `title` from the control and presents the same portal tooltip on hover and
keyboard focus. The ERD capture records the focused state. An interaction check also
confirmed `Escape` dismisses the tooltip and leaves the command focused. The static
`pnpm check:ui-primitives` rule prevents a raw icon-only button or a statically unnamed
`Button iconOnly` from entering the source tree again.

## Search Everywhere 2026.1.4 recheck

The isolated DopeDB 2026.1.4 window exposed a roughly `672px` Search Everywhere
popup at `top=190px` in a `1400×929` logical viewport. The blank popup contains a
category row and a focused 32px search row without dimming the application or
expanding an empty result area. The temporary reference capture has SHA-256
`ee86a84e871c96122a0329d4cd38a0dd912fcdb1d6e69557a59d90ac7c22512d` and is not
copied into the repository.

The correction replaces the former `760×620` dimmed modal and initial 40-item list
with the measured popup geometry. Only categories backed by real DopeDB results are
shown: Database, Documents, Actions, and Settings. `/` searches the existing action
catalog; DopeDB-only Files, Code, and Text categories are not represented by labels
or placeholders. Desktop and compact captures verify the blank and action states.
Playwright also verified scoped filtering, Arrow selection, roving tab
Arrow/Home/End, Escape dismissal, and focus restoration to the toolbar launcher.

## AI Chat empty-state 2026.1.4 recheck

The isolated DopeDB 2026.1.4 window exposed a blank AI Chat with a flat header,
three terse capability lines, a 108px composer, and the Agent picker below it. It
did not place a large title or explanatory paragraph in the transcript. The
temporary `1400×929` reference capture has SHA-256
`bc1b88e156dd6c4d3c259dee68bf4e95755cd10ee92a23baf482f6ea66f9fe69` and is not
copied into the repository.

DopeDB keeps the previously verified independent 600px preferred width from the
user's detailed reference. Only the empty transcript changed: it now presents
three real DopeDB capabilities—SQL work, schema/selection inspection, and explicit
approval before changes. DopeDB's editor-completion features were not copied and
no inactive link or control was added. The hidden heading preserves an accessible
name without spending steady-state visible text. The `560×700` capture confirms the
same three-line hierarchy while the composer and Agent picker remain visible. At
`1400×929`, the browser projection measured the right surface at `596px`, the
composer at `570×108px`, and no horizontal document overflow.
