// 실제 제품 shell의 구조 계약. 제품 코드에 테스트 전용 data-* 속성을 심지 않고
// 현존하는 selector와 계산된 스타일만으로 판정한다.
//
// 영역 selector 근거:
//   rail      nav.workbench-rail            (features/appShell/WorkbenchRail)
//   explorer  #workbench-sidebar            (screens/Connections/DatabaseExplorer)
//   main      main.main                     (features/appShell/ShellLayout)
//   terminal  aside.terminal-dock           (components/TerminalDock)
import type { Page } from "@playwright/test";

export const SHELL_REGIONS = {
  rail: "nav.workbench-rail",
  explorer: "#workbench-sidebar",
  main: "main.main",
  terminal: "aside.terminal-dock",
} as const;

export type ShellRegionName = keyof typeof SHELL_REGIONS;

export interface RegionMeasurement {
  name: ShellRegionName;
  visible: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  overflowX: number;
  overflowY: number;
}

export interface ShellMeasurement {
  viewport: { width: number; height: number };
  documentOverflowX: number;
  documentOverflowY: number;
  regions: RegionMeasurement[];
  /** rail 오른쪽 경계와 explorer 왼쪽 경계의 간격(px). 0이어야 붙어 있다. */
  railToExplorerGap: number | null;
  /** main의 계산된 min-width. 데이터 영역이 밀려나지 않도록 0이어야 한다. */
  mainMinWidth: string | null;
  /** 화면 안 모든 상호작용 control의 계산된 높이 집합. */
  controlHeights: number[];
  /** 접근 가능한 이름이 없는 icon-only control 수. */
  unnamedIconControls: number;
  /** 시각적 깊이(중첩된 surface 경계의 최대 단계). */
  maxVisualDepth: number;
}

/**
 * 디자인 시스템이 허용하는 control 높이.
 * 24 닫기·제거, 28 compact, 32 toolbar, 35 tab, 36 rail/navigation.
 */
export const ALLOWED_CONTROL_HEIGHTS = [24, 28, 32, 35, 36];

export const MAX_VISUAL_DEPTH = 3;

export async function measureShell(page: Page): Promise<ShellMeasurement> {
  return page.evaluate((regionSelectors) => {
    const round = (value: number) => Math.round(value * 100) / 100;

    const regions = Object.entries(regionSelectors).map(([name, selector]) => {
      const node = document.querySelector<HTMLElement>(selector);
      if (!node) {
        return {
          name: name as keyof typeof regionSelectors,
          visible: false,
          bounds: { x: 0, y: 0, width: 0, height: 0 },
          overflowX: 0,
          overflowY: 0,
        };
      }
      const rect = node.getBoundingClientRect();
      return {
        name: name as keyof typeof regionSelectors,
        visible: rect.width > 0 && rect.height > 0,
        bounds: {
          x: round(rect.x),
          y: round(rect.y),
          width: round(rect.width),
          height: round(rect.height),
        },
        overflowX: Math.max(0, node.scrollWidth - node.clientWidth),
        overflowY: Math.max(0, node.scrollHeight - node.clientHeight),
      };
    });

    const rail = document.querySelector<HTMLElement>(regionSelectors.rail);
    const explorer = document.querySelector<HTMLElement>(
      regionSelectors.explorer,
    );
    const main = document.querySelector<HTMLElement>(regionSelectors.main);

    // 보이는 상호작용 control만 측정한다. 숨은 control은 레이아웃 계약 대상이 아니다.
    // 높이 계약은 한 줄짜리 design-system controls에 적용한다. Dashboard tile,
    // provider binding chooser 같은 복합 content button과 inline link는 콘텐츠
    // 높이를 가져야 하므로 이 집합에 포함하지 않는다.
    const controls = [
      ...document.querySelectorAll<HTMLElement>(
        [
          ".btn:not(.link)",
          ".workbench-rail-button",
          ".workbench-document-strip [role='tab']",
          "input:not([type='checkbox']):not([type='radio'])",
          "select",
          "textarea:not(.xterm-helper-textarea)",
        ].join(", "),
      ),
    ].filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });

    const controlHeights = [
      ...new Set(
        controls.map((node) =>
          Math.round(node.getBoundingClientRect().height),
        ),
      ),
    ].sort((a, b) => a - b);

    const accessibleName = (node: HTMLElement) =>
      (
        node.getAttribute("aria-label") ??
        node.getAttribute("aria-labelledby") ??
        node.textContent ??
        ""
      ).trim();
    const unnamedIconControls = controls.filter(
      (node) => node.tagName === "BUTTON" && accessibleName(node).length === 0,
    ).length;

    // 시각적 깊이: border/background/shadow를 가진 surface의 중첩 단계.
    const isSurface = (node: HTMLElement) => {
      // 데이터 셀과 control의 자체 경계는 surface nesting이 아니다.
      if (
        node.matches(
          "button, input, select, textarea, summary, table, thead, tbody, tr, th, td",
        )
      ) {
        return false;
      }
      const style = window.getComputedStyle(node);
      const hasBorder =
        style.borderTopWidth !== "0px" ||
        style.borderBottomWidth !== "0px" ||
        style.borderLeftWidth !== "0px" ||
        style.borderRightWidth !== "0px";
      const hasBackground =
        style.backgroundColor !== "rgba(0, 0, 0, 0)" &&
        style.backgroundColor !== "transparent";
      const hasShadow = style.boxShadow !== "none";
      const rounded = style.borderRadius !== "0px";
      return hasShadow || (hasBorder && (rounded || hasBackground));
    };

    let maxVisualDepth = 0;
    const walk = (node: HTMLElement, depth: number) => {
      const rect = node.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const next = isSurface(node) ? depth + 1 : depth;
      if (next > maxVisualDepth) maxVisualDepth = next;
      for (const child of node.children) walk(child as HTMLElement, next);
    };
    const app = document.querySelector<HTMLElement>(".app");
    if (app) walk(app, 0);

    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      documentOverflowX: Math.max(
        0,
        document.documentElement.scrollWidth - window.innerWidth,
      ),
      documentOverflowY: Math.max(
        0,
        document.documentElement.scrollHeight - window.innerHeight,
      ),
      regions,
      railToExplorerGap:
        rail && explorer
          ? round(
              explorer.getBoundingClientRect().left -
                rail.getBoundingClientRect().right,
            )
          : null,
      mainMinWidth: main ? window.getComputedStyle(main).minWidth : null,
      controlHeights,
      unnamedIconControls,
      maxVisualDepth,
    };
  }, SHELL_REGIONS);
}
