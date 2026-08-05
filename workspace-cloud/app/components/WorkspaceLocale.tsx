"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { WorkspaceLocale } from "../../lib/workspace-locale";

const WorkspaceLocaleContext = createContext<WorkspaceLocale>("en");

export function WorkspaceLocaleProvider({
  locale,
  children,
}: {
  locale: WorkspaceLocale;
  children: ReactNode;
}) {
  return (
    <WorkspaceLocaleContext.Provider value={locale}>
      {children}
    </WorkspaceLocaleContext.Provider>
  );
}

export function useWorkspaceLocale() {
  return useContext(WorkspaceLocaleContext);
}
