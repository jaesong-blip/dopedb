import { useEffect, useRef } from "react";

export function useOperationNudge(
  latestId: number | null,
  terminalVisible: boolean,
  notify: () => void,
) {
  const seenOperationId = useRef<number | null>(null);
  const surfaceInit = useRef(true);
  const lastToastAt = useRef(0);

  useEffect(() => {
    if (surfaceInit.current) {
      surfaceInit.current = false;
      seenOperationId.current = latestId;
      return;
    }
    if (latestId === null || latestId === seenOperationId.current) return;
    seenOperationId.current = latestId;
    const now = Date.now();
    if (!terminalVisible && now - lastToastAt.current > 30_000) {
      lastToastAt.current = now;
      notify();
    }
  }, [latestId, notify, terminalVisible]);
}
