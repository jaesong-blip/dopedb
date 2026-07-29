// Canonical dense tool-window primitives shared by explorer, assistant, and
// provider surfaces. Consumers provide content and actions, while this module
// owns the repeated DopeDB-style spacing and interaction contract.
import type {
  ButtonHTMLAttributes,
  FormHTMLAttributes,
  ReactNode,
  Ref,
  TextareaHTMLAttributes,
} from "react";

import { Icon } from "../../components/Icon";

export function ToolWindowHeader({
  title,
  actions,
}: {
  title: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="tw:flex tw:h-tool-window-header tw:min-h-tool-window-header tw:shrink-0 tw:items-center tw:justify-between tw:gap-2 tw:border-b tw:border-border-subtle tw:bg-background tw:px-3 tw:text-ui">
      <strong className="tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap">
        {title}
      </strong>
      {actions ? (
        <div className="tw:flex tw:items-center tw:gap-[2px]">{actions}</div>
      ) : null}
    </header>
  );
}

export function ToolWindowSection({
  title,
  children,
}: {
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="tw:grid tw:gap-[2px]">
      <h3 className="tw:mt-0 tw:mb-1 tw:px-2 tw:text-xs tw:font-semibold tw:tracking-[0.03em] tw:text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

export function ToolWindowVerticalSplit({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div className="tw:grid tw:min-h-0 tw:flex-1 tw:grid-rows-[minmax(0,var(--ds-tool-window-primary-ratio))_minmax(0,1fr)] tw:[&>*]:min-h-0 tw:[&>*:first-child]:border-b tw:[&>*:first-child]:border-border-subtle">
      {children}
    </div>
  );
}

export function ToolWindowAction({
  leading,
  trailing,
  selected = false,
  children,
  ...buttonProps
}: {
  leading: ReactNode;
  trailing?: ReactNode;
  selected?: boolean;
  children: ReactNode;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">) {
  return (
    <button
      type="button"
      className="tw:grid tw:min-h-control-md tw:w-full tw:cursor-pointer tw:grid-cols-[20px_minmax(0,1fr)_16px] tw:items-center tw:gap-2 tw:rounded-xs tw:border-0 tw:bg-transparent tw:px-2 tw:font-sans tw:text-left tw:text-sm tw:text-foreground tw:aria-pressed:bg-selection tw:aria-pressed:text-selection-foreground tw:disabled:cursor-progress tw:disabled:opacity-50 tw:hover:bg-muted"
      aria-pressed={selected}
      {...buttonProps}
    >
      {leading}
      <span className="tw:min-w-0 tw:overflow-hidden tw:text-ellipsis tw:whitespace-nowrap">
        {children}
      </span>
      <span className="tw:text-xs tw:text-muted-foreground">{trailing}</span>
    </button>
  );
}

export function ToolWindowRailAction({
  selected,
  children,
  ...buttonProps
}: {
  selected?: boolean;
  children: ReactNode;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">) {
  return (
    <button
      type="button"
      data-active={selected || undefined}
      aria-pressed={selected}
      className="tw:grid tw:size-8 tw:cursor-pointer tw:place-items-center tw:rounded-sm tw:border-0 tw:bg-transparent tw:text-sm tw:text-muted-foreground tw:hover:bg-muted tw:hover:text-foreground tw:data-[active=true]:bg-selection tw:data-[active=true]:text-selection-foreground"
      {...buttonProps}
    >
      {children}
    </button>
  );
}

export function ToolWindowHideButton({
  label,
  buttonRef,
  ...buttonProps
}: {
  label: string;
  buttonRef?: Ref<HTMLButtonElement>;
} & Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "children" | "title" | "aria-label"
>) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className="btn small icon-only icon-xs"
      title={label}
      aria-label={label}
      {...buttonProps}
    >
      <Icon name="minus" />
    </button>
  );
}

export function ToolWindowComposerDock({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div className="tw:m-2 tw:mt-0 tw:flex tw:shrink-0 tw:flex-col tw:gap-1">
      {children}
    </div>
  );
}

export function ToolWindowComposer({
  children,
  ...formProps
}: FormHTMLAttributes<HTMLFormElement>) {
  return (
    <form
      className="tw:relative tw:flex tw:min-h-[108px] tw:flex-col tw:rounded-md tw:border tw:border-input tw:bg-card tw:focus-within:border-ring"
      {...formProps}
    >
      {children}
    </form>
  );
}

export function ToolWindowComposerInput(
  textareaProps: TextareaHTMLAttributes<HTMLTextAreaElement>,
) {
  return (
    <textarea
      className="tw:min-h-16 tw:w-full tw:flex-1 tw:resize-none tw:border-0 tw:bg-transparent tw:px-3 tw:py-2 tw:font-sans tw:text-sm tw:leading-body tw:text-foreground tw:outline-none tw:placeholder:text-muted-foreground"
      {...textareaProps}
    />
  );
}

export function ToolWindowComposerContext({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div className="tw:flex tw:min-h-control-lg tw:items-center tw:gap-1 tw:px-1">
      {children}
    </div>
  );
}
