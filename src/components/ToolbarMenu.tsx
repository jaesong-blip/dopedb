import {
  type ButtonHTMLAttributes,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { placeFloatingMenu, type FloatingMenuPosition } from "../lib/floatingMenu";
import { Icon, type IconName } from "./Icon";

function menuItems(root: HTMLElement | null) {
  if (!root) return [];
  return [
    ...root.querySelectorAll<HTMLElement>(
      'button:not(:disabled), [role="menuitem"]:not([aria-disabled="true"]), [role="menuitemcheckbox"] input:not(:disabled)',
    ),
  ];
}

export default function ToolbarMenu({
  label,
  icon,
  trigger,
  children,
  align = "end",
  disabled = false,
  pressed,
  triggerVariant = "default",
  menuSize = "default",
}: {
  label: string;
  icon?: IconName;
  trigger?: ReactNode;
  children: ReactNode;
  align?: "start" | "end";
  disabled?: boolean;
  pressed?: boolean;
  triggerVariant?: "default" | "badge" | "treeBadge";
  menuSize?: "default" | "scope";
}) {
  const generatedId = useId();
  const menuId = `toolbar-menu-${generatedId.replace(/:/g, "")}`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const focusFirstOnOpen = useRef(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<FloatingMenuPosition | null>(null);

  function close({ restoreFocus = false } = {}) {
    setOpen(false);
    setPosition(null);
    if (restoreFocus) {
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }

  useLayoutEffect(() => {
    if (!open) return;
    let frame = 0;
    const update = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const trigger = triggerRef.current?.getBoundingClientRect();
        const menu = menuRef.current?.getBoundingClientRect();
        if (!trigger || !menu) return;
        if (
          trigger.width === 0 ||
          trigger.height === 0 ||
          trigger.right <= 0 ||
          trigger.bottom <= 0 ||
          trigger.left >= window.innerWidth ||
          trigger.top >= window.innerHeight
        ) {
          close();
          return;
        }
        const rootStyle = getComputedStyle(document.documentElement);
        const gap =
          Number.parseFloat(rootStyle.getPropertyValue("--ds-popover-offset-lg")) || 6;
        const margin =
          Number.parseFloat(rootStyle.getPropertyValue("--ds-viewport-gutter")) || 8;
        setPosition(
          placeFloatingMenu(
            trigger,
            menu,
            { width: window.innerWidth, height: window.innerHeight },
            { align, gap, margin },
          ),
        );
      });
    };
    update();
    const observer = new ResizeObserver(update);
    if (triggerRef.current) observer.observe(triggerRef.current);
    if (menuRef.current) observer.observe(menuRef.current);
    window.addEventListener("resize", update);
    document.addEventListener("scroll", update, true);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", update);
      document.removeEventListener("scroll", update, true);
    };
  }, [align, open]);

  useEffect(() => {
    const trigger = triggerRef.current;
    if (!open || !trigger) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) close();
    });
    observer.observe(trigger);
    return () => observer.disconnect();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        triggerRef.current?.contains(target) ||
        menuRef.current?.contains(target)
      ) {
        return;
      }
      close();
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close({ restoreFocus: true });
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !position || !focusFirstOnOpen.current) return;
    focusFirstOnOpen.current = false;
    menuItems(menuRef.current)[0]?.focus();
  }, [open, position]);

  function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement
    ) {
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = menuItems(menuRef.current);
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Home") items[0]?.focus();
    else if (event.key === "End") items[items.length - 1]?.focus();
    else {
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const next = current < 0 ? (direction > 0 ? 0 : items.length - 1) : current + direction;
      items[(next + items.length) % items.length]?.focus();
    }
  }

  const menu = open
    ? createPortal(
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={label}
          data-placement={position?.placement}
          data-size={menuSize}
          className="tw:fixed tw:z-[var(--ds-z-popover)] tw:grid tw:max-h-[calc(100dvh-(var(--ds-viewport-gutter)*2))] tw:min-w-[var(--ds-menu-min-width)] tw:max-w-[min(var(--ds-menu-max-width),calc(100vw-(var(--ds-viewport-gutter)*2)))] tw:gap-[var(--ds-segment-gap)] tw:overflow-auto tw:overscroll-contain tw:rounded-md tw:border tw:border-border-strong tw:bg-popover tw:p-1 tw:text-popover-foreground tw:shadow-popover tw:data-[size=scope]:w-[min(var(--ds-schema-scope-menu-width),calc(100vw-(var(--ds-viewport-gutter)*2)))]"
          style={{
            left: position?.left ?? 0,
            top: position?.top ?? 0,
            maxHeight: position?.maxHeight,
            visibility: position ? "visible" : "hidden",
          }}
          onKeyDown={moveFocus}
          onClick={(event) => {
            const target = event.target as HTMLElement;
            if (target.closest('button:not(:disabled), [role="menuitem"]')) {
              close();
            }
          }}
        >
          {children}
        </div>,
        document.body,
      )
    : null;

  return (
    <span className="tw:inline-flex tw:shrink-0">
      <button
        ref={triggerRef}
        type="button"
        className={
          trigger
            ? triggerVariant === "treeBadge"
              ? "tw:inline-flex tw:h-[var(--ds-tree-badge-height)] tw:min-h-[var(--ds-tree-badge-height)] tw:min-w-0 tw:cursor-pointer tw:items-center tw:gap-1 tw:rounded-xs tw:border tw:border-border-subtle tw:bg-transparent tw:px-1.5 tw:font-sans tw:text-2xs tw:font-medium tw:leading-none tw:text-muted-foreground tw:aria-expanded:border-ring tw:aria-expanded:bg-selection tw:aria-expanded:text-selection-foreground tw:disabled:cursor-progress tw:disabled:opacity-55 tw:hover:border-ring tw:hover:text-foreground tw:focus-visible:outline-none tw:focus-visible:ring-2 tw:focus-visible:ring-ring"
              : triggerVariant === "badge"
                ? "tw:inline-flex tw:min-h-control-xs tw:min-w-0 tw:cursor-pointer tw:items-center tw:gap-1 tw:rounded-xs tw:border tw:border-border-subtle tw:bg-transparent tw:px-1.5 tw:font-sans tw:text-2xs tw:font-medium tw:text-muted-foreground tw:aria-expanded:border-ring tw:aria-expanded:bg-selection tw:aria-expanded:text-selection-foreground tw:disabled:cursor-progress tw:disabled:opacity-55 tw:hover:border-ring tw:hover:text-foreground tw:focus-visible:outline-none tw:focus-visible:ring-2 tw:focus-visible:ring-ring"
              : "tw:inline-flex tw:h-control-md tw:min-w-0 tw:cursor-pointer tw:items-center tw:gap-2 tw:rounded-xs tw:border-0 tw:bg-transparent tw:px-2 tw:font-sans tw:text-sm tw:font-semibold tw:text-foreground tw:aria-expanded:bg-selection tw:aria-expanded:text-selection-foreground tw:disabled:cursor-progress tw:disabled:opacity-55 tw:hover:bg-muted tw:focus-visible:outline-none tw:focus-visible:ring-2 tw:focus-visible:ring-ring"
            : "btn small icon-only tw:aria-expanded:bg-selection tw:aria-expanded:text-selection-foreground tw:aria-pressed:bg-selection tw:aria-pressed:text-selection-foreground"
        }
        disabled={disabled}
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-pressed={pressed}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          if (open) close();
          else {
            setPosition(null);
            setOpen(true);
          }
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown") return;
          event.preventDefault();
          focusFirstOnOpen.current = true;
          setPosition(null);
          setOpen(true);
        }}
      >
        {trigger ?? (icon ? <Icon name={icon} /> : null)}
      </button>
      {menu}
    </span>
  );
}

export function ToolbarMenuItem({
  icon,
  children,
  ...props
}: {
  icon: IconName;
  children: ReactNode;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "className">) {
  return (
    <button
      type="button"
      role="menuitem"
      className="tw:flex tw:min-h-control-md tw:w-full tw:min-w-[var(--ds-menu-min-width)] tw:cursor-pointer tw:items-center tw:justify-start tw:gap-2 tw:rounded-sm tw:border-0 tw:bg-transparent tw:px-2 tw:font-sans tw:text-left tw:text-ui tw:leading-ui tw:text-inherit tw:whitespace-nowrap tw:disabled:cursor-default tw:disabled:opacity-45 tw:hover:bg-muted tw:hover:text-foreground tw:focus-visible:bg-muted tw:focus-visible:text-foreground tw:focus-visible:outline-none tw:focus-visible:ring-2 tw:focus-visible:ring-inset tw:focus-visible:ring-ring"
      {...props}
    >
      <Icon name={icon} className="tw:shrink-0 tw:text-sm" />
      {children}
    </button>
  );
}
