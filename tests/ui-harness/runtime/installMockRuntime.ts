// 장면 런타임 설치. App을 import하기 전에 호출해야 하며, module 평가 시점의
// Tauri 접근도 mock 경계 안에 들어오게 한다.
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { UiHarnessScenario } from "../scenarios/types";
import { createCommandRouter, type HarnessRouter } from "./commandRouter";
import { freezeEnvironment } from "./determinism";
import { createEventRouter, type HarnessEventDelivery } from "./eventRouter";
import { resetStorage, seedStorage } from "./storage";

export interface HarnessWindowBridge {
  scene: string;
  calls(): { command: string; payload: unknown }[];
  counts(): Record<string, number>;
  names(): string[];
  pending(): number;
  unhandled(): string[];
  trigger(name: string): Promise<HarnessEventDelivery[]>;
  events(): HarnessEventDelivery[];
}

declare global {
  interface Window {
    __uiHarness?: HarnessWindowBridge;
  }
}

export function installMockRuntime(scenario: UiHarnessScenario): HarnessRouter {
  freezeEnvironment();
  resetStorage();
  seedStorage(scenario.initialStorage);

  mockWindows("main");
  const events = createEventRouter(scenario.events);
  const router = createCommandRouter(
    scenario.id,
    scenario.ipc,
    (command) => events.trigger(`after:${command}`),
  );
  // shouldMockEvents가 plugin:event|listen/emit/unlisten을 내부 처리하므로
  // 제품의 이벤트 구독은 strict allowlist를 통과할 필요가 없다.
  mockIPC(
    async (command, payload) => router.handle(command, payload),
    { shouldMockEvents: true },
  );

  // Playwright가 IPC call log를 읽는 유일한 경로다. 제품 코드는 이 값을 보지 않는다.
  window.__uiHarness = {
    scene: scenario.id,
    calls: () => router.calls.map((call) => ({ ...call })),
    counts: () => router.counts(),
    names: () => router.names(),
    pending: () => router.pending(),
    unhandled: () => router.unhandled(),
    trigger: (name) => events.trigger(name),
    events: () => events.deliveries(),
  };

  return router;
}
