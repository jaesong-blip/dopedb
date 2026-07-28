// Canonical group surface for dense preference and policy controls. Settings
// screens provide their own row grids while this primitive owns the shared
// surface, heading rhythm, and neutral border contract.
import type { ReactNode } from "react";

export function SettingsGroup({
  title,
  children,
}: {
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="tw:grid tw:gap-0 tw:rounded-sm tw:border tw:border-border-subtle tw:bg-card tw:p-3">
      <h3 className="tw:mt-0 tw:mb-1">{title}</h3>
      {children}
    </section>
  );
}
