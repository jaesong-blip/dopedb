import { useEffect, useState } from "react";

export function usePostPaintReady() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let disposed = false;
    let secondFrame = 0;
    let idleCallback: number | undefined;
    const becomeReady = () => {
      if (!disposed && !document.hidden) setReady(true);
    };
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        if (typeof window.requestIdleCallback === "function") {
          idleCallback = window.requestIdleCallback(becomeReady, { timeout: 1_500 });
        } else {
          becomeReady();
        }
      });
    });
    const onVisibility = () => {
      if (!document.hidden) becomeReady();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
      if (idleCallback !== undefined) window.cancelIdleCallback(idleCallback);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return ready;
}
