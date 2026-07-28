import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { errMessage } from "../../ipc/types";
import { useI18n } from "../../lib/i18n";
import type {
  SkillSetupCommandDraft,
  SkillSetupTerminalSessionSummary,
  TerminalOutputChunk,
  TerminalSessionId,
} from "../terminals/domain";
import PtySurface, {
  type PtyOutputWriter,
  type PtySurfaceHandle,
} from "../terminals/PtySurface";
import {
  onSkillSetupTerminalExit,
  onSkillSetupTerminalState,
  skillSetupTerminalClose,
  skillSetupTerminalCreate,
  skillSetupTerminalDraft,
  skillSetupTerminalResize,
  skillSetupTerminalWrite,
  terminalOutputChannel,
} from "../terminals/tauriAdapter";

const DEFAULT_SIZE = {
  cols: 88,
  rows: 14,
  pixelWidth: 0,
  pixelHeight: 0,
};
const PROMPT_SETTLE_MS = 120;
const RENDERER_FALLBACK_MS = 900;
const SLOW_FEEDBACK_MS = 1_000;
const MAX_PENDING_OUTPUT_BYTES = 256 * 1024;

interface SkillSetupTerminalProps {
  command: SkillSetupCommandDraft;
}

export default function SkillSetupTerminal({
  command,
}: SkillSetupTerminalProps) {
  const { t } = useI18n();
  const initialCommand = useRef(command).current;
  const surfaceRef = useRef<PtySurfaceHandle>(null);
  const sessionRef = useRef<SkillSetupTerminalSessionSummary | null>(null);
  const outputWriterRef = useRef<{
    id: TerminalSessionId;
    writer: PtyOutputWriter;
  } | null>(null);
  const pendingOutputRef = useRef<TerminalOutputChunk[]>([]);
  const pendingOutputBytesRef = useRef(0);
  const draftedSessionRef = useRef<TerminalSessionId | null>(null);
  const draftTimerRef = useRef<number | null>(null);
  const draftDeadlineRef = useRef<number | null>(null);
  const closedSessionsRef = useRef(new Set<TerminalSessionId>());
  const mountedRef = useRef(true);
  const [session, setSession] =
    useState<SkillSetupTerminalSessionSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafted, setDrafted] = useState(false);
  const [slowFeedbackVisible, setSlowFeedbackVisible] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(
      () => setSlowFeedbackVisible(true),
      SLOW_FEEDBACK_MS,
    );
    return () => window.clearTimeout(timer);
  }, []);

  const closeSession = useCallback(async (
    id: TerminalSessionId,
    reportError = true,
  ) => {
    if (closedSessionsRef.current.has(id)) return;
    closedSessionsRef.current.add(id);
    try {
      await skillSetupTerminalClose(id);
    } catch (reason) {
      if (reportError && mountedRef.current) setError(errMessage(reason));
    }
  }, []);

  const registerOutput = useCallback(
    (id: TerminalSessionId, writer: PtyOutputWriter | null) => {
      if (!writer) {
        if (outputWriterRef.current?.id === id) outputWriterRef.current = null;
        return;
      }
      outputWriterRef.current = { id, writer };
      const pending = pendingOutputRef.current;
      pendingOutputRef.current = [];
      pendingOutputBytesRef.current = 0;
      for (const chunk of pending) {
        if (chunk.sessionId === id) writer(chunk);
      }
    },
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    let disposed = false;
    let createdId: TerminalSessionId | null = null;

    const channel = terminalOutputChannel((chunk) => {
      const activeWriter = outputWriterRef.current;
      if (activeWriter?.id === chunk.sessionId) {
        activeWriter.writer(chunk);
        return;
      }
      pendingOutputRef.current.push(chunk);
      pendingOutputBytesRef.current += chunk.bytes.length;
      while (
        pendingOutputBytesRef.current > MAX_PENDING_OUTPUT_BYTES &&
        pendingOutputRef.current.length > 1
      ) {
        const removed = pendingOutputRef.current.shift();
        pendingOutputBytesRef.current -= removed?.bytes.length ?? 0;
      }
    });

    const stateListener = onSkillSetupTerminalState(({ session: next }) => {
      if (!disposed && next.id === createdId) {
        sessionRef.current = next;
        setSession(next);
      }
    }).catch((reason) => {
      if (!disposed) setError(errMessage(reason));
      return null;
    });
    const exitListener = onSkillSetupTerminalExit(({ sessionId, exit }) => {
      if (!disposed && sessionId === createdId) {
        setSession((current) =>
          current
            ? { ...current, lifecycle: "exited", exit }
            : current,
        );
      }
    }).catch((reason) => {
      if (!disposed) setError(errMessage(reason));
      return null;
    });

    let createTimer: number | null = window.setTimeout(() => {
      createTimer = null;
      void skillSetupTerminalCreate({ size: DEFAULT_SIZE }, channel)
        .then((created) => {
          createdId = created.id;
          if (disposed) {
            void closeSession(created.id, false);
            return;
          }
          sessionRef.current = created;
          setSession(created);
        })
        .catch((reason) => {
          if (!disposed) setError(errMessage(reason));
        });
    }, 0);

    return () => {
      disposed = true;
      mountedRef.current = false;
      if (createTimer !== null) {
        window.clearTimeout(createTimer);
        createTimer = null;
      }
      if (draftTimerRef.current !== null) {
        window.clearTimeout(draftTimerRef.current);
        draftTimerRef.current = null;
      }
      void stateListener.then((unlisten) => unlisten?.());
      void exitListener.then((unlisten) => unlisten?.());
      outputWriterRef.current = null;
      pendingOutputRef.current = [];
      pendingOutputBytesRef.current = 0;
      const activeId = createdId ?? sessionRef.current?.id ?? null;
      if (activeId) void closeSession(activeId, false);
    };
  }, [closeSession]);

  const insertDraft = useCallback(
    async (id: TerminalSessionId) => {
      if (draftedSessionRef.current === id) return;
      draftedSessionRef.current = id;
      try {
        await skillSetupTerminalDraft(id, initialCommand);
        if (!mountedRef.current) return;
        setDrafted(true);
        setError(null);
        surfaceRef.current?.focus();
      } catch (reason) {
        draftedSessionRef.current = null;
        if (mountedRef.current) setError(errMessage(reason));
      }
    },
    [initialCommand],
  );

  const scheduleDraft = useCallback(
    (delay: number) => {
      const id = sessionRef.current?.id;
      if (!id || draftedSessionRef.current === id) return;
      const deadline = Date.now() + delay;
      if (
        draftTimerRef.current !== null &&
        draftDeadlineRef.current !== null &&
        draftDeadlineRef.current <= deadline
      ) {
        return;
      }
      if (draftTimerRef.current !== null) {
        window.clearTimeout(draftTimerRef.current);
      }
      draftDeadlineRef.current = deadline;
      draftTimerRef.current = window.setTimeout(() => {
        draftTimerRef.current = null;
        draftDeadlineRef.current = null;
        void insertDraft(id);
      }, delay);
    },
    [insertDraft],
  );

  const handleSurfaceReady = useCallback(
    () => scheduleDraft(RENDERER_FALLBACK_MS),
    [scheduleDraft],
  );
  const handlePromptVisible = useCallback(
    () => scheduleDraft(PROMPT_SETTLE_MS),
    [scheduleDraft],
  );

  return (
    <section
      className="tw:relative tw:mt-3 tw:grid tw:h-[264px] tw:min-w-0 tw:grid-rows-[var(--ds-control-lg)_minmax(0,1fr)] tw:overflow-hidden tw:rounded-md tw:border tw:border-border-strong tw:bg-background tw:@max-[520px]:h-[236px]"
      aria-label={t("agentTools.setupTerminalAria")}
      data-ui-boundary
    >
      <header className="tw:flex tw:items-center tw:justify-between tw:gap-2 tw:border-b tw:border-border-subtle tw:pr-1 tw:pl-3 tw:text-xs tw:text-muted-foreground">
        <p className="tw:m-0" aria-live="polite">
          {drafted
            ? t("agentTools.setupPressEnter")
            : slowFeedbackVisible
              ? t("agentTools.setupPreparingDraft")
              : "\u00a0"}
        </p>
      </header>
      {error && (
        <div
          className="tw:absolute tw:z-[var(--ds-z-base)] tw:mx-2 tw:mt-[calc(var(--ds-control-lg)+var(--ds-space-2))] tw:text-ui tw:text-danger"
          role="alert"
        >
          {t("agentTools.setupTerminalError", { error })}
        </div>
      )}
      {session ? (
        <PtySurface
          ref={surfaceRef}
          session={session}
          active
          registerOutput={registerOutput}
          writeInput={skillSetupTerminalWrite}
          resize={skillSetupTerminalResize}
          onError={setError}
          onReady={handleSurfaceReady}
          onPromptVisible={handlePromptVisible}
          ariaLabel={t("agentTools.setupTerminalAria")}
          className="tw:h-full tw:p-2"
        />
      ) : (
        <div
          className="tw:grid tw:place-items-center tw:p-4 tw:text-muted-foreground"
          aria-live="polite"
        >
          {error
            ? t("agentTools.setupUnavailable")
            : slowFeedbackVisible
              ? t("agentTools.setupStarting")
              : null}
        </div>
      )}
    </section>
  );
}
