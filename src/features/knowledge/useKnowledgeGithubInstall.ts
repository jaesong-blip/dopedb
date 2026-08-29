// Owns the external GitHub App installation window and return-to-app refresh.
import { useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { errMessage } from "../../ipc/types";
import type { GithubKnowledgeRepository } from "./domain";
import { beginKnowledgeGithubInstall } from "./tauriAdapter";

export type GithubInstallState = "idle" | "waiting" | "returned-empty";

interface KnowledgeGithubInstallInput {
  repositories: GithubKnowledgeRepository[] | undefined;
  refetchRepositories: () => Promise<{
    data?: GithubKnowledgeRepository[];
    error: unknown;
  }>;
  onError: (message: string | null) => void;
}

export function useKnowledgeGithubInstall({
  repositories,
  refetchRepositories,
  onError,
}: KnowledgeGithubInstallInput) {
  const [state, setState] = useState<GithubInstallState>("idle");
  const stateRef = useRef<GithubInstallState>("idle");
  const attemptRef = useRef(0);
  const externalWindowActiveRef = useRef(false);
  const refreshInFlightRef = useRef(false);

  const setInstallState = useCallback((next: GithubInstallState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const reset = useCallback(() => {
    attemptRef.current += 1;
    externalWindowActiveRef.current = false;
    refreshInFlightRef.current = false;
    setInstallState("idle");
  }, [setInstallState]);

  const begin = useCallback(async () => {
    try {
      onError(null);
      const authorizationUrl = await beginKnowledgeGithubInstall();
      attemptRef.current += 1;
      externalWindowActiveRef.current = false;
      setInstallState("waiting");
      await openUrl(authorizationUrl);
    } catch (error) {
      setInstallState("idle");
      onError(errMessage(error));
    }
  }, [onError, setInstallState]);

  useEffect(() => {
    let disposed = false;
    let refreshTimer: number | null = null;
    const refreshAfterGithubReturn = () => {
      if (stateRef.current !== "waiting" || refreshInFlightRef.current) return;
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      const attempt = attemptRef.current;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        if (
          disposed ||
          attempt !== attemptRef.current ||
          stateRef.current !== "waiting" ||
          refreshInFlightRef.current
        ) return;
        refreshInFlightRef.current = true;
        void (async () => {
          try {
            const result = await refetchRepositories();
            if (disposed || attempt !== attemptRef.current) return;
            if (result.error) {
              setInstallState("idle");
              return;
            }
            const nextState: GithubInstallState = result.data?.length
              ? "idle"
              : "returned-empty";
            setInstallState(nextState);
            if (nextState === "idle") onError(null);
          } catch (error) {
            if (disposed || attempt !== attemptRef.current) return;
            setInstallState("idle");
            onError(errMessage(error));
          } finally {
            refreshInFlightRef.current = false;
          }
        })();
      }, 300);
    };
    const onBlur = () => {
      if (stateRef.current === "waiting") {
        externalWindowActiveRef.current = true;
      }
    };
    const onFocus = () => {
      if (!externalWindowActiveRef.current) return;
      externalWindowActiveRef.current = false;
      refreshAfterGithubReturn();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible" && stateRef.current === "waiting") {
        externalWindowActiveRef.current = true;
        return;
      }
      if (
        document.visibilityState === "visible" &&
        externalWindowActiveRef.current
      ) {
        externalWindowActiveRef.current = false;
        refreshAfterGithubReturn();
      }
    };
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [onError, refetchRepositories, setInstallState]);

  useEffect(() => {
    if (!repositories?.length || stateRef.current === "idle") return;
    setInstallState("idle");
  }, [repositories, setInstallState]);

  return { state, begin, reset };
}
