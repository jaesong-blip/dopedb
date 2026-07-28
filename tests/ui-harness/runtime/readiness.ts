// 장면 준비 완료 판정. 고정 sleep을 쓰지 않고 관찰 가능한 신호만 사용한다.
//   1) document.fonts.ready
//   2) strict router의 in-flight command 0
//   3) Skeleton(.skeleton) 잔존 없음
//   4) 위 조건이 연속 프레임 동안 유지됨
import type { HarnessRouter } from "./commandRouter";

export const HARNESS_READY_ATTRIBUTE = "data-ui-harness-ready";

/** 연속으로 조용해야 하는 프레임 수. 쿼리 연쇄가 한 프레임 뒤 시작하는 경우를 흡수한다. */
const STABLE_FRAMES = 3;

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

function quiet(router: HarnessRouter): boolean {
  return (
    router.pending() === 0 &&
    document.querySelector(".skeleton, [aria-busy='true']") === null
  );
}

export async function markSceneReady(router: HarnessRouter): Promise<void> {
  await document.fonts.ready;

  let stable = 0;
  while (stable < STABLE_FRAMES) {
    await nextFrame();
    stable = quiet(router) ? stable + 1 : 0;
  }

  document.documentElement.setAttribute(HARNESS_READY_ATTRIBUTE, "true");
}
