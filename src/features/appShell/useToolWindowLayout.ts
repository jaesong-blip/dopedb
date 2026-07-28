import { useCallback, useState } from "react";

const STORAGE_KEY = "dopedb:tool-window-layout:v1";

type LeftToolWindow = "databaseExplorer" | "localHistory";

type StoredToolWindowLayout = {
  databaseExplorerOpen: boolean;
  leftToolWindow: LeftToolWindow;
  servicesOpen: boolean;
  servicesHeight: number;
};

const DEFAULT_SERVICES_HEIGHT = 280;
const MIN_SERVICES_HEIGHT = 160;
const MAX_SERVICES_HEIGHT = 560;

const DEFAULT_LAYOUT: StoredToolWindowLayout = {
  databaseExplorerOpen: true,
  leftToolWindow: "databaseExplorer",
  servicesOpen: false,
  servicesHeight: DEFAULT_SERVICES_HEIGHT,
};

function clampServicesHeight(height: number) {
  const viewportMaximum =
    typeof window === "undefined"
      ? MAX_SERVICES_HEIGHT
      : Math.max(MIN_SERVICES_HEIGHT, window.innerHeight - 220);
  return Math.min(
    MAX_SERVICES_HEIGHT,
    viewportMaximum,
    Math.max(MIN_SERVICES_HEIGHT, height),
  );
}

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
        leftToolWindow:
          "leftToolWindow" in parsed &&
            parsed.leftToolWindow === "localHistory"
            ? "localHistory"
            : DEFAULT_LAYOUT.leftToolWindow,
        servicesOpen:
          "servicesOpen" in parsed && typeof parsed.servicesOpen === "boolean"
            ? parsed.servicesOpen
            : DEFAULT_LAYOUT.servicesOpen,
        servicesHeight:
          "servicesHeight" in parsed && typeof parsed.servicesHeight === "number"
            ? clampServicesHeight(parsed.servicesHeight)
            : DEFAULT_LAYOUT.servicesHeight,
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
      if (
        current.databaseExplorerOpen === open &&
        (!open || current.leftToolWindow === "databaseExplorer")
      ) {
        return current;
      }
      const next = {
        ...current,
        databaseExplorerOpen: open,
        leftToolWindow: open
          ? "databaseExplorer" as const
          : current.leftToolWindow,
      };
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
        databaseExplorerOpen:
          current.leftToolWindow === "databaseExplorer"
            ? !current.databaseExplorerOpen
            : true,
        leftToolWindow: "databaseExplorer" as const,
      };
      storeLayout(next);
      return next;
    });
  }, []);

  const showLocalHistory = useCallback(() => {
    setLayout((current) => {
      const next = {
        ...current,
        databaseExplorerOpen: true,
        leftToolWindow: "localHistory" as const,
      };
      storeLayout(next);
      return next;
    });
  }, []);
  const closeLocalHistory = useCallback(() => {
    setLayout((current) => {
      if (
        !current.databaseExplorerOpen ||
        current.leftToolWindow !== "localHistory"
      ) {
        return current;
      }
      const next = { ...current, databaseExplorerOpen: false };
      storeLayout(next);
      return next;
    });
  }, []);
  const toggleLocalHistory = useCallback(() => {
    setLayout((current) => {
      const next = {
        ...current,
        databaseExplorerOpen:
          current.leftToolWindow === "localHistory"
            ? !current.databaseExplorerOpen
            : true,
        leftToolWindow: "localHistory" as const,
      };
      storeLayout(next);
      return next;
    });
  }, []);

  const setServicesOpen = useCallback((open: boolean) => {
    setLayout((current) => {
      if (current.servicesOpen === open) return current;
      const next = { ...current, servicesOpen: open };
      storeLayout(next);
      return next;
    });
  }, []);
  const showServices = useCallback(
    () => setServicesOpen(true),
    [setServicesOpen],
  );
  const closeServices = useCallback(
    () => setServicesOpen(false),
    [setServicesOpen],
  );
  const toggleServices = useCallback(() => {
    setLayout((current) => {
      const next = { ...current, servicesOpen: !current.servicesOpen };
      storeLayout(next);
      return next;
    });
  }, []);

  const startServicesResize = useCallback(
    (event: { preventDefault(): void; clientY: number }) => {
      event.preventDefault();
      const startY = event.clientY;
      const startHeight = layout.servicesHeight;
      const move = (next: MouseEvent) => {
        const height = clampServicesHeight(
          startHeight + startY - next.clientY,
        );
        setLayout((current) => ({ ...current, servicesHeight: height }));
      };
      const up = (next: MouseEvent) => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        const height = clampServicesHeight(
          startHeight + startY - next.clientY,
        );
        setLayout((current) => {
          const updated = { ...current, servicesHeight: height };
          storeLayout(updated);
          return updated;
        });
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    },
    [layout.servicesHeight],
  );
  const resetServicesHeight = useCallback(() => {
    setLayout((current) => {
      const next = {
        ...current,
        servicesHeight: DEFAULT_SERVICES_HEIGHT,
      };
      storeLayout(next);
      return next;
    });
  }, []);

  return {
    databaseExplorerOpen:
      layout.databaseExplorerOpen &&
      layout.leftToolWindow === "databaseExplorer",
    localHistoryOpen:
      layout.databaseExplorerOpen &&
      layout.leftToolWindow === "localHistory",
    servicesOpen: layout.servicesOpen,
    servicesHeight: layout.servicesHeight,
    showDatabaseExplorer,
    toggleDatabaseExplorer,
    showLocalHistory,
    closeLocalHistory,
    toggleLocalHistory,
    showServices,
    closeServices,
    toggleServices,
    startServicesResize,
    resetServicesHeight,
  };
}
