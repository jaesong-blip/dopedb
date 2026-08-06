// Deterministic viewport placement for portalled command menus. Keeping the
// geometry pure makes clipping, edge clamping, and vertical flipping testable
// without a browser or a particular workbench pane.
export interface FloatingRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

export interface FloatingViewport {
  width: number;
  height: number;
}

export interface FloatingMenuPosition {
  left: number;
  top: number;
  placement: "top" | "bottom";
  maxHeight: number;
}

export function placeFloatingMenu(
  trigger: FloatingRect,
  menu: Pick<FloatingRect, "width" | "height">,
  viewport: FloatingViewport,
  options: {
    align?: "start" | "center" | "end";
    gap?: number;
    margin?: number;
  } = {},
): FloatingMenuPosition {
  const align = options.align ?? "end";
  const gap = options.gap ?? 6;
  const margin = options.margin ?? 8;
  const availableBelow = Math.max(
    0,
    viewport.height - trigger.bottom - gap - margin,
  );
  const availableAbove = Math.max(0, trigger.top - gap - margin);
  const placement =
    menu.height > availableBelow && availableAbove > availableBelow
      ? "top"
      : "bottom";
  const maxHeight =
    placement === "top" ? availableAbove : availableBelow;
  const visibleHeight = Math.min(menu.height, maxHeight);
  const desiredLeft =
    align === "start"
      ? trigger.left
      : align === "center"
        ? trigger.left + (trigger.width - menu.width) / 2
        : trigger.right - menu.width;
  const maxLeft = Math.max(margin, viewport.width - menu.width - margin);
  const desiredTop =
    placement === "top"
      ? trigger.top - gap - visibleHeight
      : trigger.bottom + gap;
  const maxTop = Math.max(
    margin,
    viewport.height - visibleHeight - margin,
  );

  return {
    left: Math.min(Math.max(desiredLeft, margin), maxLeft),
    top: Math.min(Math.max(desiredTop, margin), maxTop),
    placement,
    maxHeight,
  };
}
