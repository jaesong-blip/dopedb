// 시간 지연 없는 Tauri event script. command 완료나 Playwright의 명시적
// 사용자 action이 trigger가 되며 같은 장면을 반복해도 event 순서가 동일하다.
import { emit } from "@tauri-apps/api/event";
import type { HarnessEvent } from "../scenarios/types";

export interface HarnessEventDelivery {
  trigger: string;
  event: string;
  payload: unknown;
}

export interface HarnessEventRouter {
  trigger(name: string): Promise<HarnessEventDelivery[]>;
  deliveries(): HarnessEventDelivery[];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function createEventRouter(
  script: readonly HarnessEvent[] = [],
): HarnessEventRouter {
  const delivered = new Set<number>();
  const log: HarnessEventDelivery[] = [];

  return {
    async trigger(name) {
      const pending = script
        .map((entry, index) => ({ entry, index }))
        .filter(
          ({ entry, index }) =>
            entry.trigger === name &&
            (!entry.once || !delivered.has(index)),
        );
      const current: HarnessEventDelivery[] = [];
      for (const { entry, index } of pending) {
        const delivery = {
          trigger: name,
          event: entry.event,
          payload: clone(entry.payload),
        };
        await emit(entry.event, delivery.payload);
        delivered.add(index);
        log.push(delivery);
        current.push(delivery);
      }
      return current;
    },
    deliveries() {
      return clone(log);
    },
  };
}
