import { useCallback, useState } from "react";

const STORAGE_KEY = "dopedb:tool-window-layout:v1";

type StoredToolWindowLayout = {
  databaseExplorerOpen: boolean;
};

const DEFAULT_LAYOUT: StoredToolWindowLayout = {
  databaseExplorerOpen: true,
};

function readLayout(): StoredToolWindowLayout {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? "null",
    );
    if (
      parsed &&
      typeof parsed === "object" &&
      "databaseExplorerOpen" in parsed &&
      typeof parsed.databaseExplorerOpen === "boolean"
    ) {
      return {
        databaseExplorerOpen: parsed.databaseExplorerOpen,
      };
    }
  } catch {
    // A corrupt layout preference must never block the workbench.
  }
  return DEFAULT_LAYOUT;
}

function storeLayout(layout: StoredToolWindowLayout) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
}

export function useToolWindowLayout() {
  const [layout, setLayout] = useState(readLayout);

  const setDatabaseExplorerOpen = useCallback((open: boolean) => {
    setLayout((current) => {
      if (current.databaseExplorerOpen === open) return current;
      const next = { ...current, databaseExplorerOpen: open };
      storeLayout(next);
      return next;
    });
  }, []);

  const showDatabaseExplorer = useCallback(
    () => setDatabaseExplorerOpen(true),
    [setDatabaseExplorerOpen],
  );
  const toggleDatabaseExplorer = useCallback(() => {
    setLayout((current) => {
      const next = {
        ...current,
        databaseExplorerOpen: !current.databaseExplorerOpen,
      };
      storeLayout(next);
      return next;
    });
  }, []);

  return {
    databaseExplorerOpen: layout.databaseExplorerOpen,
    showDatabaseExplorer,
    toggleDatabaseExplorer,
  };
}
