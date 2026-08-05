import type { HTMLAttributes } from "react";

type ProgressBarProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  "children" | "className"
> & {
  value: number | null;
  max?: number;
  density?: "compact" | "default";
  label: string;
};

export function ProgressBar({
  value,
  max = 100,
  density = "default",
  label,
  ...props
}: ProgressBarProps) {
  const normalized =
    value === null || !Number.isFinite(value) || max <= 0
      ? null
      : Math.max(0, Math.min(1, value / max));
  return (
    <div
      {...props}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={normalized === null ? undefined : normalized * max}
      data-density={density}
      data-indeterminate={normalized === null ? "true" : undefined}
      className="tw:h-2 tw:w-full tw:overflow-hidden tw:rounded-full tw:border tw:border-border-subtle tw:bg-muted tw:data-[density=compact]:h-0.5 tw:data-[density=compact]:rounded-none tw:data-[density=compact]:border-0 tw:data-[density=compact]:bg-border-subtle"
    >
      <span
        className="tw:block tw:h-full tw:w-full tw:origin-left tw:rounded-full tw:bg-primary tw:transition-transform tw:duration-200 tw:motion-reduce:transition-none tw:data-[indeterminate=true]:animate-pulse"
        data-indeterminate={normalized === null ? "true" : undefined}
        style={{ transform: `scaleX(${normalized ?? 0.12})` }}
      />
    </div>
  );
}
