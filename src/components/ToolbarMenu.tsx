import {
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
import "./ToolbarMenu.css";

function menuItems(root: HTMLElement | null) {
  if (!root) return [];
  return [
    ...root.querySelectorAll<HTMLElement>(
      'button:not(:disabled), [role="menuitem"]:not([aria-disabled="true"])',
    ),
  ];
}

export default function ToolbarMenu({
  label,
  icon,
  children,
  align = "end",
  disabled = false,
  triggerClassName = "",
  menuClassName = "",
}: {
  label: string;
  icon: IconName;
  children: ReactNode;
  align?: "start" | "end";
  disabled?: boolean;
  triggerClassName?: string;
  menuClassName?: string;
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
          className={`ds-menu-popover${menuClassName ? ` ${menuClassName}` : ""}`}
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
    <span className="ds-toolbar-menu">
      <button
        ref={triggerRef}
        type="button"
        className={`btn small icon-only${open ? " active" : ""}${
          triggerClassName ? ` ${triggerClassName}` : ""
        }`}
        disabled={disabled}
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
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
        <Icon name={icon} />
      </button>
      {menu}
    </span>
  );
}
