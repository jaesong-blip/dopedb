import { useCallback, useRef } from "react";

/**
 * Keeps an event handler identity stable while always invoking the latest
 * render's implementation. This is useful for editor extensions whose
 * reconfiguration is substantially more expensive than updating a ref.
 */
export function useEventCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  return useCallback((...args: Args) => callbackRef.current(...args), []);
}
