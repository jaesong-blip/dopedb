// Mouse 없이 focus target을 찾고 key action을 실행하는 공통 helper. DOM 순서를
// hard-code하지 않고 accessible name이 나타날 때까지 실제 Tab 순서를 걷는다.
import type { Page } from "@playwright/test";

export async function tabUntil(
  page: Page,
  accessibleName: RegExp,
  limit = 40,
): Promise<void> {
  for (let index = 0; index < limit; index += 1) {
    await page.keyboard.press("Tab");
    const matched = await page.evaluate((source) => {
      const active = document.activeElement as HTMLElement | null;
      if (!active) return false;
      const name =
        active.getAttribute("aria-label") ??
        active.getAttribute("title") ??
        active.textContent ??
        "";
      return new RegExp(source).test(name.trim());
    }, accessibleName.source);
    if (matched) return;
  }
  throw new Error(
    `[ui-harness] focus target ${accessibleName.toString()} was not reached`,
  );
}
