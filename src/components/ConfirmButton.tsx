// Inline two-step confirm: one click arms it ("Really delete? Yes / No"), auto-reverts
// after 3s if untouched. No window.confirm. Styling reuses .btn; inline flex, no css file.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../lib/i18n";

export default function ConfirmButton({
  children,
  onConfirm,
  className = "btn",
  disabled,
  confirmLabel,
  label,
}: {
  children: ReactNode;
  onConfirm: () => void;
  className?: string;
  disabled?: boolean;
  confirmLabel?: string;
  label?: string;
}) {
  const { t } = useI18n();
  const [armed, setArmed] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  if (!armed) {
    return (
      <button
        type="button"
        className={className}
        disabled={disabled}
        title={label}
        aria-label={label}
        onClick={() => {
          setArmed(true);
          timer.current = window.setTimeout(() => setArmed(false), 3000);
        }}
      >
        {children}
      </button>
    );
  }

  return (
    <span className="tw:inline-flex tw:items-center tw:gap-[var(--ds-control-gap)]">
      <span className="tw:text-muted-foreground">
        {confirmLabel ?? t("common.reallyDelete")}
      </span>
      <button
        type="button"
        className="btn danger small"
        disabled={disabled}
        onClick={() => {
          window.clearTimeout(timer.current);
          setArmed(false);
          onConfirm();
        }}
      >
        {t("common.yes")}
      </button>
      <button
        type="button"
        className="btn small"
        autoFocus
        disabled={disabled}
        onClick={() => {
          window.clearTimeout(timer.current);
          setArmed(false);
        }}
      >
        {t("common.no")}
      </button>
    </span>
  );
}
