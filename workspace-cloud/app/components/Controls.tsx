import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from "react";
import { createElement } from "react";

function ControlAction({
  element,
  children,
  ...props
}: {
  element: "a" | "button";
  children: ReactNode;
} & Record<string, unknown>) {
  return createElement(
    element,
    {
      ...props,
      className:
        "tw:inline-flex tw:h-control-sm tw:shrink-0 tw:cursor-pointer tw:items-center tw:justify-center tw:border tw:border-border tw:bg-transparent tw:px-3 tw:text-2xs tw:font-semibold tw:text-foreground tw:no-underline tw:transition-colors tw:data-[size=field]:h-control-field tw:data-[size=field]:px-4 tw:data-[tone=danger]:text-danger tw:data-[tone=primary]:border-primary-emphasis tw:data-[tone=primary]:bg-primary-emphasis tw:data-[tone=primary]:font-extrabold tw:data-[tone=primary]:text-primary-foreground tw:hover:border-primary tw:hover:bg-surface-raised tw:data-[tone=primary]:hover:bg-primary tw:focus-visible:outline-2 tw:focus-visible:outline-offset-2 tw:focus-visible:outline-ring tw:active:translate-y-px tw:disabled:cursor-not-allowed tw:disabled:opacity-[var(--ds-disabled-opacity)]",
    },
    children,
  );
}

export function ControlButton({
  tone = "neutral",
  size = "small",
  type = "button",
  children,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> & {
  tone?: "danger" | "neutral" | "primary";
  size?: "field" | "small";
  children: ReactNode;
}) {
  return createElement(ControlAction, {
    ...props,
    element: "button",
    type,
    "data-tone": tone,
    "data-size": size,
    children,
  });
}

export function ControlLink({
  children,
  ...props
}: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "className"> & {
  children: ReactNode;
}) {
  return createElement(ControlAction, {
    ...props,
    element: "a",
    children,
  });
}

export function ControlField({
  label,
  children,
}: {
  label: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="tw:grid tw:min-w-0 tw:gap-2">
      <span className="tw:font-mono tw:text-2xs tw:font-semibold tw:uppercase tw:text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}

export function ControlInput(
  props: Omit<InputHTMLAttributes<HTMLInputElement>, "className">,
) {
  return (
    <input
      className="tw:h-control-field tw:w-full tw:min-w-0 tw:border tw:border-border tw:bg-surface-inset tw:px-3 tw:text-xs tw:text-foreground tw:outline-none tw:placeholder:text-muted-foreground tw:focus:border-primary tw:focus:ring-2 tw:focus:ring-ring/30 tw:disabled:cursor-not-allowed tw:disabled:opacity-[var(--ds-disabled-opacity)]"
      {...props}
    />
  );
}

export function ControlSelect({
  children,
  ...props
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, "className"> & {
  children: ReactNode;
}) {
  return (
    <select
      className="tw:h-control-field tw:w-full tw:min-w-0 tw:border tw:border-border tw:bg-surface-inset tw:px-3 tw:text-xs tw:text-foreground tw:outline-none tw:focus:border-primary tw:focus:ring-2 tw:focus:ring-ring/30 tw:disabled:cursor-not-allowed tw:disabled:opacity-[var(--ds-disabled-opacity)]"
      {...props}
    >
      {children}
    </select>
  );
}
