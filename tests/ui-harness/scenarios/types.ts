// 장면 계약. 시나리오는 DOM selector를 복제하지 않고 제품 진입 상태, IPC 응답,
// action-triggered event, benchmark 요구사항과 관찰 가능한 결과만 소유한다.
import type { HarnessIpcMap } from "../runtime/commandRouter";
import type { HarnessStorageSeed } from "../runtime/storage";

export type UiHarnessSceneId =
  | "first-run"
  | "explorer-connected"
  | "compact-shell"
  | "terminal-open"
  | "sql-terminal"
  | "table-data"
  | "schema-erd"
  | "dashboard"
  | "settings"
  | "provider-setup"
  | "permission-review"
  | "loading-error"
  | "empty-results"
  | "long-content"
  | "keyboard-only";

export type HarnessViewport = "desktop" | "compact";
export type HarnessActiveArea = "workspace" | "dashboard" | "settings";
export type ReferenceCloneSceneId =
  | "first-run"
  | "data-editor"
  | "query-console"
  | "assistant-open";

export interface HarnessEvent {
  /** `after:<command>` 또는 Playwright가 호출하는 `manual:<action>` trigger. */
  trigger: string;
  event: string;
  payload: unknown;
  once?: boolean;
}

export type BenchmarkRegion =
  | "rail"
  | "explorer"
  | "workbench"
  | "assistant"
  | "status";

export interface AccessibleRoleExpectation {
  role:
    | "alert"
    | "button"
    | "dialog"
    | "grid"
    | "heading"
    | "main"
    | "menubar"
    | "navigation"
    | "tab"
    | "table"
    | "textbox";
  name?: string;
  count?: number;
}

/** rubric.schema.json의 평가 항목과 1:1로 대응한다. */
export type BenchmarkCriterionId =
  | "orientation"
  | "workbenchHierarchy"
  | "densityAndAlignment"
  | "actionLocality"
  | "contextContinuity"
  | "accessibility";

export const HARNESS_VIEWPORTS: Record<
  HarnessViewport,
  { width: number; height: number }
> = {
  desktop: { width: 1440, height: 900 },
  compact: { width: 900, height: 680 },
};

export interface UiHarnessScenario {
  id: UiHarnessSceneId;
  title: string;
  viewport: HarnessViewport;
  activeArea: HarnessActiveArea;
  selectedConnectionId: string | null;
  /** 제품이 읽는 실제 key만 심는다. 비어 있으면 최초 실행 상태다. */
  initialStorage: HarnessStorageSeed;
  /** strict router가 허용하는 command 전체. 여기 없는 command는 실패한다. */
  ipc: HarnessIpcMap;
  /** 시간 지연 대신 command/action trigger로만 방출하는 event script. */
  events?: readonly HarnessEvent[];
  benchmark: {
    referenceId: string;
    referenceCloneScene: ReferenceCloneSceneId;
    requiredRegions: readonly BenchmarkRegion[];
    rubric: readonly BenchmarkCriterionId[];
  };
  expected: {
    /** 장면 준비 완료까지 호출되어야 하는 command 이름(정렬된 집합). */
    commands: readonly string[];
    /** 중요 command의 정확한 횟수. 생략한 command는 집합 계약만 검사한다. */
    commandCounts?: Readonly<Record<string, number>>;
    visibleRoles: readonly AccessibleRoleExpectation[];
    layout: {
      viewportFits: true;
      maxVisualDepth: 3;
      minimumMainWidth: number;
      terminalVisible: boolean;
    };
    focusOrder?: readonly string[];
  };
}
