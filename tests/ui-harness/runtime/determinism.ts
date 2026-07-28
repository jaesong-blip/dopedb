// 화면에 드러나는 비결정성을 App import 전에 고정한다.
// 제품 코드에 테스트 전용 분기를 넣지 않기 위해 하네스 쪽에서만 전역을 덮는다.
// 대상 근거: relTime()/fullTime()의 Date.now, Sql·Documents·operationActivity의
// new Date().toLocaleTimeString(), 그리고 5곳의 crypto.randomUUID.

/** 고정 기준 시각. Playwright가 ko-KR/Asia/Seoul을 고정하므로 표시 문자열까지 결정적이다. */
export const HARNESS_NOW_ISO = "2026-07-28T09:00:00.000Z";

export function freezeEnvironment(): void {
  const RealDate = Date;
  const fixed = new RealDate(HARNESS_NOW_ISO).getTime();

  // Proxy는 DateConstructor의 오버로드를 그대로 통과시키므로 인자 있는 호출의
  // 의미가 바뀌지 않는다. 인자 없는 new Date()와 Date.now()만 고정한다.
  globalThis.Date = new Proxy(RealDate, {
    construct(target, args) {
      return args.length === 0
        ? new target(fixed)
        : new target(...(args as [string]));
    },
    get(target, property, receiver) {
      if (property === "now") return () => fixed;
      return Reflect.get(target, property, receiver);
    },
  });

  // mocks.js가 쓰는 crypto.getRandomValues는 건드리지 않는다.
  let issued = 0;
  const uuid = () => {
    issued += 1;
    const tail = issued.toString(16).padStart(12, "0");
    return `fffffff0-0000-4000-8000-${tail}` as const;
  };
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    configurable: true,
    value: uuid,
  });

  // CSS transition/caret와 smooth scroll을 하네스 경계에서 고정한다. 제품에는
  // test flag를 넣지 않으며 실제 reduced-motion media query도 별도로 유지한다.
  const style = document.createElement("style");
  style.dataset.uiHarnessDeterminism = "true";
  style.textContent = `
    *, *::before, *::after {
      animation-delay: 0s !important;
      animation-duration: 0s !important;
      caret-color: transparent !important;
      scroll-behavior: auto !important;
      transition-delay: 0s !important;
      transition-duration: 0s !important;
    }
  `;
  document.head.append(style);

  const realScrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function deterministicScroll(
    options?: boolean | ScrollIntoViewOptions,
  ) {
    if (typeof options === "object") {
      return realScrollIntoView.call(this, { ...options, behavior: "auto" });
    }
    return realScrollIntoView.call(this, options);
  };
}
