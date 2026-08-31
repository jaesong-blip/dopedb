// Compact mutually exclusive choices used by dense property editors. The
// primitive owns keyboard semantics and selected treatment so feature screens
// do not recreate segmented-button styling.

export type SegmentedControlOption<Value extends string> = {
  value: Value;
  label: string;
  disabled?: boolean;
};

export function SegmentedControl<Value extends string>({
  value,
  options,
  label,
  disabled = false,
  onChange,
}: {
  value: Value;
  options: readonly SegmentedControlOption<Value>[];
  label: string;
  disabled?: boolean;
  onChange: (value: Value) => void;
}) {
  return (
    <div
      className="tw:inline-flex tw:w-fit tw:rounded-sm tw:border tw:border-input tw:bg-background tw:p-0.5 tw:shadow-control"
      role="radiogroup"
      aria-label={label}
    >
      {options.map((option, optionIndex) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            data-selected={selected || undefined}
            disabled={disabled || option.disabled}
            tabIndex={selected ? 0 : -1}
            className="tw:min-h-control-md tw:min-w-24 tw:cursor-pointer tw:rounded-xs tw:border-0 tw:bg-transparent tw:px-3 tw:font-sans tw:text-ui tw:text-muted-foreground tw:outline-none tw:data-[selected]:bg-selection tw:data-[selected]:font-medium tw:data-[selected]:text-selection-foreground tw:hover:bg-muted tw:focus-visible:ring-2 tw:focus-visible:ring-ring/30 tw:disabled:cursor-default tw:disabled:opacity-50"
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => {
              let nextIndex: number | null = null;
              const enabledIndexes = options
                .map((candidate, index) => candidate.disabled ? null : index)
                .filter((index): index is number => index !== null);
              const enabledPosition = enabledIndexes.indexOf(optionIndex);
              if (enabledPosition === -1 || enabledIndexes.length === 0) return;
              if (
                event.key === "ArrowRight" ||
                event.key === "ArrowDown"
              ) {
                nextIndex = enabledIndexes[
                  (enabledPosition + 1) % enabledIndexes.length
                ] ?? null;
              } else if (
                event.key === "ArrowLeft" ||
                event.key === "ArrowUp"
              ) {
                nextIndex = enabledIndexes[
                  (enabledPosition - 1 + enabledIndexes.length) %
                    enabledIndexes.length
                ] ?? null;
              } else if (event.key === "Home") {
                nextIndex = enabledIndexes[0] ?? null;
              } else if (event.key === "End") {
                nextIndex = enabledIndexes[enabledIndexes.length - 1] ?? null;
              }
              if (nextIndex === null || !options[nextIndex]) return;
              event.preventDefault();
              onChange(options[nextIndex].value);
              const buttons =
                event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                  '[role="radio"]',
                );
              window.requestAnimationFrame(() =>
                buttons?.[nextIndex]?.focus(),
              );
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
