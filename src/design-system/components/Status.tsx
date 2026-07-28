// Small semantic status primitives shared by tool windows and asynchronous
// workflows. Color always communicates state, never navigation selection.
import type { ReactNode } from "react";

import { Icon, type IconName } from "../../components/Icon";

export type StatusTone = "neutral" | "success" | "warning" | "danger";

export function StatusDot({ tone = "neutral" }: { tone?: StatusTone }) {
  return (
    <span
      data-tone={tone}
      aria-hidden="true"
      className="tw:size-2 tw:shrink-0 tw:rounded-full tw:bg-muted-foreground tw:data-[tone=danger]:bg-danger tw:data-[tone=success]:bg-success tw:data-[tone=warning]:bg-warning"
    />
  );
}

export function LoadingLabel({ children }: { children: ReactNode }) {
  return (
    <span
      role="status"
      className="tw:inline-flex tw:min-w-0 tw:items-center tw:gap-1.5 tw:text-muted-foreground"
    >
      <Icon
        name="refresh"
        className="tw:size-3 tw:animate-spin tw:motion-reduce:animate-none"
      />
      <span>{children}</span>
    </span>
  );
}

export function InlineNotice({
  tone,
  icon,
  children,
  action,
  role,
}: {
  tone: "warning" | "danger";
  icon: IconName;
  children: ReactNode;
  action?: ReactNode;
  role?: "alert" | "status";
}) {
  return (
    <div
      data-tone={tone}
      className="tw:grid tw:min-w-0 tw:grid-cols-[var(--ds-icon-md)_minmax(0,1fr)_auto] tw:items-center tw:gap-2 tw:border-b tw:border-border-subtle tw:px-3 tw:py-2 tw:text-xs tw:data-[tone=danger]:border-danger-border tw:data-[tone=danger]:bg-danger-muted tw:data-[tone=warning]:border-warning tw:data-[tone=warning]:bg-muted tw:max-[640px]:grid-cols-[var(--ds-icon-md)_minmax(0,1fr)]"
      role={role}
    >
      <Icon
        name={icon}
        data-tone={tone}
        className="tw:data-[tone=danger]:text-danger"
      />
      <span className="tw:min-w-0">{children}</span>
      {action ? (
        <span className="tw:max-[640px]:col-start-2 tw:max-[640px]:justify-self-start">
          {action}
        </span>
      ) : null}
    </div>
  );
}
