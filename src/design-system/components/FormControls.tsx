// Canonical Tailwind form controls. They replace screen-owned form selectors
// while preserving semantic labels, focus treatment, and dense desktop sizing.
import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from "react";
import { forwardRef } from "react";

export function Field({
  label,
  hint,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="tw:grid tw:min-w-0 tw:gap-1.5 tw:text-sm tw:font-medium tw:text-muted-foreground tw:[&>input]:w-full tw:[&>select]:w-full tw:[&>textarea]:w-full">
      <span className="tw:inline-flex tw:items-center tw:gap-1">
        {label}
        {hint}
      </span>
      {children}
    </label>
  );
}

export const TextInput = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, "className">
>(function TextInput(props, ref) {
  return (
    <input
      ref={ref}
      className="tw:h-control-lg tw:w-full tw:rounded-sm tw:border tw:border-input tw:bg-background tw:px-3 tw:font-sans tw:text-ui tw:text-foreground tw:shadow-control tw:outline-none tw:placeholder:text-muted-foreground tw:focus:border-ring tw:focus:ring-2 tw:focus:ring-ring/30 tw:disabled:cursor-default tw:disabled:opacity-50"
      {...props}
    />
  );
});

export const SelectInput = forwardRef<
  HTMLSelectElement,
  Omit<SelectHTMLAttributes<HTMLSelectElement>, "className">
>(function SelectInput({ children, ...props }, ref) {
  return (
    <select
      ref={ref}
      className="tw:h-control-lg tw:w-full tw:rounded-sm tw:border tw:border-input tw:bg-background tw:px-3 tw:font-sans tw:text-ui tw:text-foreground tw:shadow-control tw:outline-none tw:focus:border-ring tw:focus:ring-2 tw:focus:ring-ring/30 tw:disabled:cursor-default tw:disabled:opacity-50"
      {...props}
    >
      {children}
    </select>
  );
});

export function CheckboxField({
  label,
  ...props
}: {
  label: ReactNode;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "type">) {
  return (
    <label className="tw:inline-flex tw:cursor-pointer tw:items-center tw:gap-2 tw:text-ui tw:text-foreground">
      <input
        type="checkbox"
        className="tw:size-4 tw:accent-primary"
        {...props}
      />
      <span>{label}</span>
    </label>
  );
}
