// 장면 진입 전 브라우저 저장 상태를 초기화하고 시나리오가 요구한 값만 심는다.
// 제품이 실제로 읽는 key만 한 곳에서 관리해 테스트마다 문자열을 복제하지 않는다.

/** 제품이 읽는 localStorage key. 값 형식은 제품 구현과 동일해야 한다. */
export const HARNESS_STORAGE_KEYS = {
  /** "1" | "0" — features/appShell/useTerminalDock */
  terminalDockOpen: "terminalDockOpen",
  /** 숫자 문자열 — features/appShell/useTerminalDock */
  terminalDockWidth: "terminalDockWidth",
  /** "dashboard" | 그 외 — features/appShell/navigationHooks */
  appArea: "appArea",
  /** 활성 문서 종류 — features/appShell/navigationHooks */
  tab: "tab",
  /** 연결 id 원문 — features/appShell/navigationHooks */
  selectedId: "selectedId",
  /** 숫자 문자열 — features/appShell/useSidebarWidth */
  sidebarWidth: "sidebarW",
  /** JSON — components/TerminalDock/TerminalDock */
  terminalActiveSessions: "terminalActiveSessionByScope",
  /** "en" | "ko" — lib/i18n/runtime */
  lang: "dopedb.lang",
} as const;

export type HarnessStorageSeed = Readonly<Record<string, string>>;

export function resetStorage(): void {
  window.localStorage.clear();
  window.sessionStorage.clear();
}

export function seedStorage(seed: HarnessStorageSeed): void {
  for (const [key, value] of Object.entries(seed)) {
    window.localStorage.setItem(key, value);
  }
}

/** 모든 장면이 동일한 제품 언어로 시작한다. Playwright locale은 별도로 고정된다. */
export const ENGLISH_HARNESS_STORAGE = {
  [HARNESS_STORAGE_KEYS.lang]: "en",
} satisfies HarnessStorageSeed;
