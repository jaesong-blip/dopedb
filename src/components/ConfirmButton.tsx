// Inline two-step confirm: one click arms it ("Really delete? Yes / No"), auto-reverts
// after 3s if untouched. No window.confirm.
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Button,
  type ButtonProps,
} from "../design-system/components/Button";
import { useI18n } from "../lib/i18n";

export default function ConfirmButton({
  children,
  onConfirm,
  disabled,
  confirmLabel,
  label,
  iconOnly = false,
  presentation = "button",
  size = "default",
  tone = "neutral",
  variant = "default",
}: {
  children: ReactNode;
  onConfirm: () => void;
  disabled?: boolean;
  confirmLabel?: string;
  label?: string;
} & Pick<
  ButtonProps,
  "iconOnly" | "presentation" | "size" | "tone" | "variant"
>) {
  const { t } = useI18n();
  const [armed, setArmed] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  if (!armed) {
    return (
      <Button
        disabled={disabled}
        iconOnly={iconOnly}
        presentation={presentation}
        size={size}
        tone={tone}
        variant={variant}
        title={label}
        aria-label={label}
        onClick={() => {
          setArmed(true);
          timer.current = window.setTimeout(() => setArmed(false), 3000);
        }}
      >
        {children}
      </Button>
    );
  }

  return (
    <span className="tw:inline-flex tw:items-center tw:gap-[var(--ds-control-gap)]">
      <span className="tw:text-muted-foreground">
        {confirmLabel ?? t("common.reallyDelete")}
      </span>
      <Button
        size="compact"
        variant="danger"
        disabled={disabled}
        onClick={() => {
          window.clearTimeout(timer.current);
          setArmed(false);
          onConfirm();
        }}
      >
        {t("common.yes")}
      </Button>
      <Button
        size="compact"
        autoFocus
        disabled={disabled}
        onClick={() => {
          window.clearTimeout(timer.current);
          setArmed(false);
        }}
      >
        {t("common.no")}
      </Button>
    </span>
  );
}
