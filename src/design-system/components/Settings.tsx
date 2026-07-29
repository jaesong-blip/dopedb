// Canonical flat group for dense preference and policy controls. Settings
// screens provide their own row grids while this primitive owns the shared
// divider and heading rhythm without adding nested card surfaces.
import type { ReactNode } from "react";

export function SettingsGroup({
  title,
  children,
}: {
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="tw:grid tw:content-start tw:gap-0 tw:border-t tw:border-border-subtle tw:py-2">
      <h3 className="tw:mt-0 tw:mb-1">{title}</h3>
      {children}
    </section>
  );
}
