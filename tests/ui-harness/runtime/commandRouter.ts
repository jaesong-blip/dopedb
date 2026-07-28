// 장면별 strict Tauri command router. 등록되지 않은 command는 즉시 실패시켜
// 제품이 새 IPC를 호출하면 fixture drift가 그 자리에서 드러나게 한다.
// null·빈 배열·빈 객체를 기본값으로 돌려주지 않는다.

export interface HarnessCall {
  command: string;
  payload: unknown;
}

export interface HarnessCommandContext {
  payload: unknown;
  calls: readonly HarnessCall[];
}

export type HarnessCommandHandler = (
  context: HarnessCommandContext,
) => unknown | Promise<unknown>;

/** command 이름 → 고정 응답 값 또는 payload를 보고 응답을 만드는 handler. */
export type HarnessIpcMap = Readonly<Record<string, unknown>>;

export interface HarnessRouter {
  readonly calls: readonly HarnessCall[];
  handle(command: string, payload: unknown): Promise<unknown>;
  /** command 이름별 호출 횟수. allowlist 계약 검증에 사용한다. */
  counts(): Record<string, number>;
  names(): string[];
  /** 아직 응답하지 않은 command 수. readiness 판정이 고정 sleep을 쓰지 않게 한다. */
  pending(): number;
  /**
   * 등록되지 않아 거부한 command 이름.
   * 던진 예외는 제품의 오류 처리에 삼켜질 수 있으므로 위반을 따로 기록한다.
   */
  unhandled(): string[];
}

/** 응답과 payload를 양방향으로 복제해 앱이 fixture 원본을 변형하지 못하게 한다. */
function isolate(value: unknown): unknown {
  if (value === undefined) return null;
  return structuredClone(value);
}

export function createCommandRouter(
  sceneId: string,
  ipc: HarnessIpcMap,
  onHandled?: (command: string) => unknown | Promise<unknown>,
): HarnessRouter {
  const calls: HarnessCall[] = [];
  const rejected: string[] = [];
  let inFlight = 0;

  return {
    calls,
    async handle(command, payload) {
      calls.push({ command, payload: isolate(payload) });

      if (!Object.prototype.hasOwnProperty.call(ipc, command)) {
        rejected.push(command);
        throw new Error(
          `[ui-harness] unhandled Tauri command "${command}" in scene "${sceneId}". ` +
            "Register a typed fixture for it instead of returning an empty value.",
        );
      }

      inFlight += 1;
      try {
        const handler = ipc[command];
        const value =
          typeof handler === "function"
            ? await (handler as HarnessCommandHandler)({ payload, calls })
            : handler;
        const isolated = isolate(value);
        await onHandled?.(command);
        return isolated;
      } finally {
        inFlight -= 1;
      }
    },
    pending() {
      return inFlight;
    },
    unhandled() {
      return [...new Set(rejected)].sort();
    },
    counts() {
      const totals: Record<string, number> = {};
      for (const call of calls) {
        totals[call.command] = (totals[call.command] ?? 0) + 1;
      }
      return totals;
    },
    names() {
      return [...new Set(calls.map((call) => call.command))].sort();
    },
  };
}
