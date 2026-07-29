// Canonical observation and approval surfaces for protocol-driven Agent work.
// Protocol adapters provide semantic state and actions; these primitives own
// repeated card geometry, spacing, and status treatment.
import type { ReactNode } from "react";

import { Icon } from "../../components/Icon";
import { StatusDot, type StatusTone } from "./Status";

export function AgentToolCallCard({
  title,
  status,
  tone,
  children,
  details,
}: {
  title: ReactNode;
  status: ReactNode;
  tone: StatusTone;
  children?: ReactNode;
  details?: ReactNode;
}) {
  return (
    <section className="tw:ml-7 tw:grid tw:gap-2 tw:rounded-md tw:border tw:border-border-subtle tw:bg-card tw:p-3">
      <div className="tw:flex tw:min-w-0 tw:items-center tw:gap-2">
        <StatusDot tone={tone} />
        <strong className="tw:min-w-0 tw:flex-1 tw:truncate tw:text-sm">
          {title}
        </strong>
        <span className="tw:text-xs tw:text-muted-foreground">{status}</span>
      </div>
      {children}
      {details}
    </section>
  );
}

export function AgentPermissionCard({
  title,
  description,
  pending,
  actions,
}: {
  title: ReactNode;
  description: ReactNode;
  pending: boolean;
  actions: ReactNode;
}) {
  return (
    <section
      data-pending={pending || undefined}
      className="tw:grid tw:gap-3 tw:rounded-md tw:border tw:border-border-subtle tw:bg-card tw:p-3 tw:data-[pending=true]:border-warning"
    >
      <div className="tw:flex tw:min-w-0 tw:items-start tw:gap-2">
        <Icon
          name={pending ? "alert" : "check"}
          className="tw:mt-0.5 tw:shrink-0 tw:data-[pending=true]:text-warning"
          data-pending={pending || undefined}
        />
        <div className="tw:min-w-0">
          <strong className="tw:block tw:text-sm">{title}</strong>
          <span className="tw:block tw:text-xs tw:leading-body tw:text-muted-foreground">
            {description}
          </span>
        </div>
      </div>
      {actions}
    </section>
  );
}
