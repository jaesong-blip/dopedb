// Canonical workbench primitives for editor, data, and result panes. These own
// the dense IDE spacing shared by table data, SQL, and document surfaces.
import type { ReactNode } from "react";

import { Icon, type IconName } from "../../components/Icon";

export function WorkbenchPane({ children }: { children: ReactNode }) {
  return (
    <section
      data-workbench-pane
      className="tw:flex tw:h-full tw:min-h-0 tw:min-w-0 tw:flex-col tw:overflow-hidden tw:bg-background tw:[container-type:inline-size]"
    >
      {children}
    </section>
  );
}

export function WorkbenchToolbar({
  label,
  compact = false,
  children,
}: {
  label: string;
  compact?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      role="toolbar"
      aria-label={label}
      data-workbench-toolbar
      data-compact={compact}
      className="ds-control-row tw:flex tw:min-h-control-lg tw:shrink-0 tw:items-center tw:gap-1 tw:overflow-hidden tw:border-b tw:border-border-subtle tw:bg-card tw:px-2 tw:py-1 tw:data-[compact=true]:h-control-lg tw:data-[compact=true]:py-0"
    >
      {children}
    </div>
  );
}

export function WorkbenchDivider() {
  return (
    <span
      aria-hidden="true"
      className="tw:mx-1 tw:h-control-sm tw:w-px tw:shrink-0 tw:bg-border-subtle"
    />
  );
}

export function WorkbenchSelect({
  label,
  title,
  value,
  disabled = false,
  icon,
  onChange,
  children,
}: {
  label: string;
  title?: string;
  value: string;
  disabled?: boolean;
  icon?: IconName;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <label
      className="tw:inline-flex tw:h-control-sm tw:min-w-0 tw:max-w-[180px] tw:shrink tw:items-center tw:gap-1 tw:rounded-xs tw:px-1 tw:text-sm tw:text-foreground tw:hover:bg-muted"
      title={title}
    >
      {icon ? (
        <Icon
          name={icon}
          className="tw:shrink-0 tw:text-muted-foreground"
        />
      ) : null}
      <span className="tw:sr-only">{label}</span>
      <select
        className="tw:h-control-sm tw:min-w-0 tw:max-w-[140px] tw:cursor-pointer tw:truncate tw:border-0 tw:bg-transparent tw:p-0 tw:pr-1 tw:font-sans tw:text-sm tw:text-foreground tw:shadow-none tw:outline-none tw:focus:border-transparent tw:focus:shadow-none tw:disabled:cursor-default tw:disabled:opacity-50"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        aria-label={label}
      >
        {children}
      </select>
    </label>
  );
}

export function WorkbenchContextHeader({
  icon,
  title,
  badge,
  metadata,
}: {
  icon: IconName;
  title: ReactNode;
  badge?: ReactNode;
  metadata?: ReactNode;
}) {
  return (
    <header
      data-workbench-context
      className="tw:flex tw:min-h-control-lg tw:shrink-0 tw:items-center tw:justify-between tw:gap-3 tw:border-b tw:border-border-subtle tw:bg-card tw:px-3 tw:@max-[640px]:h-auto tw:@max-[640px]:flex-col tw:@max-[640px]:items-start tw:@max-[640px]:gap-1 tw:@max-[640px]:py-2"
    >
      <div className="tw:flex tw:min-w-0 tw:items-center tw:gap-2">
        <Icon
          name={icon}
          className="tw:shrink-0 tw:text-ui tw:text-muted-foreground"
        />
        <strong className="tw:min-w-0 tw:overflow-hidden tw:text-ui tw:text-ellipsis tw:whitespace-nowrap">
          {title}
        </strong>
        {badge ? <span className="ds-context-badge">{badge}</span> : null}
      </div>
      {metadata ? (
        <div className="ds-meta-row tw:flex-nowrap tw:justify-end tw:overflow-hidden tw:whitespace-nowrap tw:@max-[640px]:w-full tw:@max-[640px]:justify-start">
          {metadata}
        </div>
      ) : null}
    </header>
  );
}

export function MetadataDot() {
  return <span className="ds-meta-dot" aria-hidden="true" />;
}

export function WorkbenchEmptyState({
  icon,
  children,
}: {
  icon?: IconName;
  children: ReactNode;
}) {
  return (
    <div className="tw:flex tw:min-h-[200px] tw:flex-1 tw:flex-col tw:items-center tw:justify-center tw:gap-2 tw:p-4 tw:text-ui tw:text-muted-foreground">
      {icon ? (
        <Icon name={icon} className="tw:text-heading tw:opacity-60" />
      ) : null}
      {children}
    </div>
  );
}

export function ResultMeta({ children }: { children: ReactNode }) {
  return (
    <div className="tw:flex tw:min-h-control-md tw:flex-wrap tw:items-center tw:gap-1 tw:border-b tw:border-border-subtle tw:px-3 tw:py-1 tw:text-sm tw:text-muted-foreground">
      {children}
    </div>
  );
}

export function WorkbenchStatusFooter({
  children,
  actions,
}: {
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <footer className="tw:relative tw:flex tw:min-h-control-md tw:shrink-0 tw:items-center tw:justify-center tw:gap-1 tw:border-t tw:border-border-subtle tw:bg-card tw:px-3 tw:text-xs tw:text-muted-foreground">
      {children}
      {actions ? (
        <div className="tw:absolute tw:right-2 tw:flex tw:items-center">
          {actions}
        </div>
      ) : null}
    </footer>
  );
}

export function SqlSnippet({ children }: { children: ReactNode }) {
  return (
    <code className="tw:inline-block tw:max-w-[60ch] tw:overflow-hidden tw:rounded-sm tw:bg-muted tw:px-1.5 tw:py-px tw:align-bottom tw:font-mono tw:text-sm tw:text-ellipsis tw:whitespace-nowrap">
      {children}
    </code>
  );
}

export function InspectorHeader({
  title,
  metadata,
  actions,
}: {
  title: ReactNode;
  metadata?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="tw:mb-2 tw:flex tw:items-start tw:justify-between tw:gap-2 tw:@max-[760px]:flex-col">
      <div className="tw:flex tw:min-w-0 tw:items-baseline tw:gap-2">
        <strong className="tw:min-w-0">{title}</strong>
        {metadata}
      </div>
      {actions ? (
        <div className="ds-control-row tw:flex tw:shrink-0 tw:items-start tw:gap-2 tw:@max-[760px]:w-full tw:@max-[760px]:flex-wrap">
          {actions}
        </div>
      ) : null}
    </header>
  );
}

export function InspectorFooter({ children }: { children: ReactNode }) {
  return (
    <div className="ds-action-row ds-control-row tw:sticky tw:bottom-[-12px] tw:mx-[-12px] tw:mt-2 tw:mb-[-12px] tw:border-t tw:border-border-subtle tw:bg-card tw:p-3">
      {children}
    </div>
  );
}
