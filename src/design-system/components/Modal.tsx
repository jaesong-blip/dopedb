// Canonical modal backdrop and bounded dialog surface. Feature dialogs own
// their content and actions; this primitive owns viewport placement, elevation,
// responsive bounds, and background interaction blocking.
import {
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { Icon } from "../../components/Icon";
import { Button } from "./Button";

export function ModalBackdrop({
  children,
  ...props
}: {
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, "className" | "children">) {
  return createPortal(
    <div
      className="tw:fixed tw:inset-0 tw:z-[var(--ds-z-modal)] tw:grid tw:place-items-center tw:overflow-auto tw:bg-overlay tw:p-4 tw:max-[640px]:p-2"
      role="presentation"
      {...props}
    >
      {children}
    </div>,
    document.body,
  );
}

export const ModalSurface = forwardRef<
  HTMLElement,
  {
    children: ReactNode;
    size?: "medium" | "wide" | "settings" | "dataSources";
    fill?: boolean;
  } & Omit<HTMLAttributes<HTMLElement>, "className" | "children">
>(function ModalSurface(
  { children, size = "medium", fill = false, ...props },
  ref,
) {
  return (
    <section
      ref={ref}
      role="dialog"
      aria-modal="true"
      data-size={size}
      data-fill={fill}
      className="ds-panel tw:flex tw:max-h-[calc(100dvh-(var(--ds-space-4)*2))] tw:w-[min(640px,100%)] tw:flex-col tw:overflow-hidden tw:p-0 tw:shadow-popover tw:[container-type:inline-size] tw:data-[fill=true]:h-[min(760px,calc(100dvh-(var(--ds-space-4)*2)))] tw:data-[size=dataSources]:h-[min(731px,calc(100dvh-(var(--ds-space-4)*2)))] tw:data-[size=dataSources]:w-[min(980px,100%)] tw:data-[size=settings]:h-[min(700px,calc(100dvh-(var(--ds-space-4)*2)))] tw:data-[size=settings]:w-[min(945px,100%)] tw:data-[size=wide]:w-[min(1120px,100%)] tw:max-[640px]:max-h-[calc(100dvh-(var(--ds-space-2)*2))] tw:max-[640px]:data-[fill=true]:h-[calc(100dvh-(var(--ds-space-2)*2))] tw:max-[640px]:data-[size=dataSources]:h-[calc(100dvh-(var(--ds-space-2)*2))] tw:max-[640px]:data-[size=settings]:h-[calc(100dvh-(var(--ds-space-2)*2))]"
      onMouseDown={(event) => event.stopPropagation()}
      {...props}
    >
      {children}
    </section>
  );
});

export function ModalTitleBar({
  title,
  titleId,
  closeLabel,
  onClose,
}: {
  title: ReactNode;
  titleId: string;
  closeLabel: string;
  onClose: () => void;
}) {
  return (
    <header className="tw:grid tw:h-[30px] tw:min-h-[30px] tw:shrink-0 tw:grid-cols-[28px_minmax(0,1fr)_28px] tw:items-center tw:border-b tw:border-border-subtle tw:bg-card tw:px-1">
      <span aria-hidden="true" />
      <h1
        id={titleId}
        className="tw:m-0 tw:overflow-hidden tw:text-center tw:text-sm tw:font-semibold tw:text-ellipsis tw:whitespace-nowrap"
      >
        {title}
      </h1>
      <Button
        iconOnly
        size="xs"
        variant="ghost"
        onClick={onClose}
        title={closeLabel}
        aria-label={closeLabel}
      >
        <Icon name="close" />
      </Button>
    </header>
  );
}

export function ModalDetailActionBar({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div className="tw:flex tw:h-[48px] tw:min-h-[48px] tw:shrink-0 tw:items-center tw:gap-3 tw:border-t tw:border-border-subtle tw:bg-card tw:px-5">
      {children}
    </div>
  );
}

export function ModalFooter({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <footer
      className="tw:flex tw:h-[50px] tw:min-h-[50px] tw:shrink-0 tw:items-center tw:justify-end tw:gap-2 tw:border-t tw:border-border-subtle tw:bg-card tw:px-4"
      data-primary-flow
    >
      {children}
    </footer>
  );
}
