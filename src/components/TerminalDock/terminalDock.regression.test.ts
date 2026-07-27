// Static ownership guard: archive presentation moved to Settings and the dock
// must retain stable focus targets for the external Terminal action.
import { describe, expect, it } from "vitest";

import appShellSource from "../../features/appShell/AppShell.tsx?raw";
import dockSource from "./TerminalDock.tsx?raw";
import tabsSource from "./TerminalTabs.tsx?raw";
import dockCss from "./terminalDock.css?raw";

const terminalDockFiles = import.meta.glob("./*", {
  eager: true,
  query: "?raw",
  import: "default",
});

describe("Terminal Dock regression guards", () => {
  it("focuses an active tab or the empty-session launcher without toggling an open dock", () => {
    const openOrFocus = appShellSource.slice(
      appShellSource.indexOf("function openOrFocusTerminalDock()"),
      appShellSource.indexOf("function selectConnection("),
    );

    expect(tabsSource).toMatch(
      /data-terminal-focus-target=\{\s*session\.id === activeId \? "active-session" : undefined\s*\}/,
    );
    expect(tabsSource).toContain('data-terminal-focus-target="launcher"');
    expect(openOrFocus).toContain(
      "[data-terminal-focus-target=\"active-session\"], [data-terminal-focus-target=\"launcher\"]",
    );
    expect(openOrFocus).toContain("if (showTerminalDock)");
    expect(openOrFocus).not.toContain("setTerminalDockOpen(false)");
    expect(openOrFocus).not.toContain("closeTerminalDock");
  });

  it("keeps retired chat archive UI and CSS out of the Terminal feature", () => {
    expect(dockCss).not.toMatch(/terminal-archive-/);
    expect(tabsSource).not.toMatch(/LegacyChatArchive|terminal-archive-/);
    expect(dockSource).not.toMatch(/LegacyChatArchive|terminal-archive-/);
    expect(Object.keys(terminalDockFiles)).not.toContain(
      "./LegacyChatArchiveDialog.tsx",
    );
  });

  it("keeps portal focus in the current dock scope and returns to its launcher after the last tab closes", () => {
    expect(tabsSource).toContain("data-terminal-popup");
    expect(dockSource).toContain("if (event.defaultPrevented) return;");
    expect(dockSource).toContain(
      "popupScopeKeyRef.current !== currentScopeKey || targetIsStale",
    );
    expect(dockSource).toContain("focusDockTarget();");
  });
});
