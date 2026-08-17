# UI polish regression evidence

This directory preserves one bounded DopeDB before/after regression set. It is
not a product-comparison archive and does not establish packaged-runtime parity.
The captures use a deterministic PostgreSQL catalog fixture and the same browser
projection so layout and accessible text changes remain reviewable.

## Evidence index

- Explorer scope before: [`01-explorer-scope-before.png`](./01-explorer-scope-before.png)
- Explorer scope after: [`02-explorer-scope-after.png`](./02-explorer-scope-after.png)
- Focus tooltip: [`03-erd-tooltip-focus-after.png`](./03-erd-tooltip-focus-after.png)
- Connection categories before: [`04-data-sources-tabs-before.png`](./04-data-sources-tabs-before.png)
- Connection categories after: [`05-data-sources-rail-after.png`](./05-data-sources-rail-after.png)
- Compact connection editor: [`06-data-sources-compact-after.png`](./06-data-sources-compact-after.png)
- Settings rail before: [`07-settings-rail-before.png`](./07-settings-rail-before.png)
- Settings rail after: [`08-settings-rail-after.png`](./08-settings-rail-after.png)
- Compact settings: [`09-settings-compact-after.png`](./09-settings-compact-after.png)
- Action Search before: [`10-action-search-before.png`](./10-action-search-before.png)
- Action Search blank state: [`11-action-search-after.png`](./11-action-search-after.png)
- Action Search command mode: [`12-action-search-actions-after.png`](./12-action-search-actions-after.png)
- Compact Action Search: [`13-action-search-compact-after.png`](./13-action-search-compact-after.png)
- Agent empty state before: [`14-agent-empty-before.png`](./14-agent-empty-before.png)
- Agent empty state after: [`15-agent-empty-after.png`](./15-agent-empty-after.png)
- Compact Agent surface: [`16-agent-empty-compact-after.png`](./16-agent-empty-compact-after.png)
- Welcome before: [`17-welcome-before.png`](./17-welcome-before.png)
- Welcome after: [`18-welcome-after.png`](./18-welcome-after.png)
- Compact Welcome: [`19-welcome-compact-after.png`](./19-welcome-compact-after.png)
- Agent selector before focus containment: [`20-agent-selection-360-before.png`](./20-agent-selection-360-before.png)
- Agent selector with focus containment: [`21-agent-selection-360-focus-after.png`](./21-agent-selection-360-focus-after.png)

## Accepted corrections

### Explorer scope

The data-source row always shows `selected of total`, including `1 of 1`, and
opens the persisted schema checklist shared by Explorer and query scope. The
badge stays compact and its accessible name remains `Introspection scope` /
`인트로스펙션 범위`.

### Connection editor and Settings

Desktop dialogs use a compact navigation rail and a separate detail surface;
compact windows retain text navigation and keep the footer action inside the
viewport. Only implemented connection, cloud, driver, and setting sections are
shown. Arrow keys plus Home/End move through the desktop navigation.

### Shared icon command

Icon commands use the shared `Button` and portal tooltip. Hover and keyboard
focus expose the same label, `Escape` dismisses the tooltip without moving focus,
and `pnpm check:ui-primitives` prevents unnamed icon-only controls.

### Action Search

Action Search is a bounded non-modal surface. Its blank state contains scope tabs
and a focused input without dimming the workbench or rendering an empty result
area. Only Database, Documents, Actions, and Settings are exposed because each
has a real result and command owner; `/` searches the action catalog. Keyboard
selection, roving tabs, Escape dismissal, and launcher focus restoration are part
of the contract.

### Agent empty state

The empty transcript contains only the product's real capabilities: SQL work,
schema/selection inspection, and explicit approval before changes. The composer
and adapter picker stay visible in compact windows. No editor-completion or
inactive integration control is implied.

### Welcome document

The connected Welcome document exposes New Query, New Connection, and Action
Search. The disconnected state provides one first-choice sentence and removes
commands that cannot run. The center remains a command surface rather than a
marketing page.

### Modal focus containment

The startup Agent selector moves focus to the first requested control, loops Tab
and Shift+Tab inside the topmost dialog, redirects programmatic background focus,
and restores its launcher on close. The compact capture records the focused
checkbox and a body/footer that remain inside a `360×640` viewport.

## Evidence limits

These browser captures verify DOM layout and accessible text only. Packaged
macOS and Windows rendering, screen-reader output, native chrome, connection
runtime behavior, large-grid performance, popup continuity, and scroll retention
remain separate manual validation responsibilities in
[`docs/LIVE_VALIDATION_RUNBOOK.md`](../../docs/LIVE_VALIDATION_RUNBOOK.md).
