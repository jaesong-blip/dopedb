import type { KeyboardEvent } from "react";

export type TabFocusDirection = "end" | "next" | "previous" | "start";

export function tabFocusTargetIndex(
  current: number,
  length: number,
  direction: TabFocusDirection,
) {
  if (length <= 0 || current < 0 || current >= length) return null;
  if (direction === "start") return 0;
  if (direction === "end") return length - 1;
  if (direction === "next") return (current + 1) % length;
  return (current - 1 + length) % length;
}

export function moveTabFocus(
  event: KeyboardEvent<HTMLElement>,
  direction: TabFocusDirection,
) {
  const tabList = event.currentTarget.closest('[role="tablist"]');
  if (!tabList) return;
  const tabs = Array.from(
    tabList.querySelectorAll<HTMLElement>(
      '[role="tab"]:not(:disabled):not([aria-disabled="true"])',
    ),
  );
  if (tabs.length === 0) return;
  const current = tabs.indexOf(event.currentTarget);
  const targetIndex = tabFocusTargetIndex(current, tabs.length, direction);
  if (targetIndex === null) return;
  const target = tabs[targetIndex];
  event.preventDefault();
  target?.focus({ preventScroll: true });
  target?.click();
}

export function moveHorizontalTabFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.key === "ArrowRight") moveTabFocus(event, "next");
  else if (event.key === "ArrowLeft") moveTabFocus(event, "previous");
  else if (event.key === "Home") moveTabFocus(event, "start");
  else if (event.key === "End") moveTabFocus(event, "end");
}
