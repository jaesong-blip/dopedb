// Lazily mounts one active xterm surface and bridges bounded text/binary input,
// sanitized PTY output, and debounced resize events to the Rust session manager.
import {
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import {
  terminalResize,
  terminalWrite,
} from "../../ipc/commands";
import type {
  TerminalOutputChunk,
  TerminalSessionSummary,
} from "../../ipc/types";
import { errMessage } from "../../ipc/types";
import { useI18n } from "../../lib/i18n";
import "@xterm/xterm/css/xterm.css";

const INPUT_CHUNK_BYTES = 32 * 1024;
const INPUT_FLUSH_MS = 4;
const RESIZE_FLUSH_MS = 40;

type OutputWriter = (chunk: TerminalOutputChunk) => void;

interface TerminalSurfaceProps {
  session: TerminalSessionSummary;
  active: boolean;
  registerOutput: (id: string, writer: OutputWriter | null) => void;
  onError: (message: string) => void;
}

function cssColor(style: CSSStyleDeclaration, property: string, fallback: string) {
  return style.getPropertyValue(property).trim() || fallback;
}

function boundedPixelSize(value: number): number {
  return Math.max(0, Math.min(32_000, Math.round(value)));
}

function flushInput(
  id: string,
  bytes: number[],
  chain: MutableRefObject<Promise<void>>,
  onError: (message: string) => void,
  formatError: (error: unknown) => string,
) {
  while (bytes.length > 0) {
    const chunk = bytes.splice(0, INPUT_CHUNK_BYTES);
    chain.current = chain.current
      .then(() => terminalWrite(id, chunk))
      .catch((error) => {
        onError(formatError(error));
      });
  }
}

export default function TerminalSurface({
  session,
  active,
  registerOutput,
  onError,
}: TerminalSurfaceProps) {
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const inputChainRef = useRef(Promise.resolve());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    let inputTimer: number | null = null;
    let resizeTimer: number | null = null;
    let inputBytes: number[] = [];
    let lastResize = "";
    const disposables: Array<{ dispose(): void }> = [];
    const encoder = new TextEncoder();

    function formatInputError(error: unknown) {
      return t("terminal.inputFailed", { error: errMessage(error) });
    }

    function sendInput() {
      if (inputTimer !== null) {
        window.clearTimeout(inputTimer);
        inputTimer = null;
      }
      flushInput(
        session.id,
        inputBytes,
        inputChainRef,
        onError,
        formatInputError,
      );
    }

    async function mountTerminal() {
      try {
        const [{ Terminal: XtermTerminal }, { FitAddon: XtermFitAddon }] =
          await Promise.all([
            import("@xterm/xterm"),
            import("@xterm/addon-fit"),
          ]);
        if (disposed || !hostRef.current) return;

        const style = getComputedStyle(document.documentElement);
        const terminal = new XtermTerminal({
          allowProposedApi: false,
          allowTransparency: false,
          cols: session.size.cols,
          rows: session.size.rows,
          convertEol: false,
          cursorBlink: true,
          cursorStyle: "bar",
          disableStdin:
            session.lifecycle === "exited" || session.lifecycle === "failed",
          drawBoldTextInBrightColors: false,
          fontFamily:
            style.getPropertyValue("--ds-font-mono").trim() ||
            "ui-monospace, monospace",
          fontSize: 12,
          letterSpacing: 0,
          lineHeight: 1.35,
          linkHandler: {
            activate: () => undefined,
            allowNonHttpProtocols: false,
          },
          minimumContrastRatio: 4.5,
          rightClickSelectsWord: true,
          screenReaderMode: true,
          scrollback: 5_000,
          scrollOnUserInput: true,
          smoothScrollDuration: 0,
          theme: {
            background: cssColor(style, "--ds-background", "#0a0a0a"),
            foreground: cssColor(style, "--ds-foreground", "#fafafa"),
            cursor: cssColor(style, "--ds-foreground", "#fafafa"),
            cursorAccent: cssColor(style, "--ds-background", "#0a0a0a"),
            selectionBackground: cssColor(
              style,
              "--ds-selection",
              "#404040",
            ),
            black: "#171717",
            brightBlack: "#737373",
            red: cssColor(style, "--ds-critical", "#ff6568"),
            brightRed: "#ff8789",
            green: cssColor(style, "--ds-positive", "#86efac"),
            brightGreen: "#bbf7d0",
            yellow: cssColor(style, "--ds-caution", "#fbbf24"),
            brightYellow: "#fde68a",
            blue: cssColor(style, "--ds-info", "#60a5fa"),
            brightBlue: "#93c5fd",
            magenta: "#c4b5fd",
            brightMagenta: "#ddd6fe",
            cyan: "#5eead4",
            brightCyan: "#99f6e4",
            white: "#d4d4d4",
            brightWhite: "#fafafa",
          },
          windowOptions: {},
        });
        const fit = new XtermFitAddon();
        terminal.loadAddon(fit);
        terminal.open(hostRef.current);
        terminalRef.current = terminal;
        fitRef.current = fit;

        registerOutput(session.id, (chunk) => {
          if (disposed || chunk.sessionId !== session.id) return;
          terminal.write(Uint8Array.from(chunk.bytes));
        });

        disposables.push(
          terminal.onData((value) => {
            const encoded = encoder.encode(value);
            for (const byte of encoded) inputBytes.push(byte);
            if (inputBytes.length >= INPUT_CHUNK_BYTES) {
              sendInput();
            } else if (inputTimer === null) {
              inputTimer = window.setTimeout(sendInput, INPUT_FLUSH_MS);
            }
          }),
        );
        disposables.push(
          terminal.onBinary((value) => {
            for (let index = 0; index < value.length; index += 1) {
              inputBytes.push(value.charCodeAt(index) & 0xff);
            }
            if (inputBytes.length >= INPUT_CHUNK_BYTES) {
              sendInput();
            } else if (inputTimer === null) {
              inputTimer = window.setTimeout(sendInput, INPUT_FLUSH_MS);
            }
          }),
        );
        disposables.push(
          terminal.onResize(({ cols, rows }) => {
            if (!hostRef.current || cols < 10 || rows < 2) return;
            const key = `${cols}:${rows}`;
            if (key === lastResize) return;
            lastResize = key;
            if (resizeTimer !== null) window.clearTimeout(resizeTimer);
            resizeTimer = window.setTimeout(() => {
              resizeTimer = null;
              const rect = hostRef.current?.getBoundingClientRect();
              void terminalResize(session.id, {
                cols,
                rows,
                pixelWidth: boundedPixelSize(rect?.width ?? 0),
                pixelHeight: boundedPixelSize(rect?.height ?? 0),
              }).catch((error) => {
                onError(errMessage(error));
              });
            }, RESIZE_FLUSH_MS);
          }),
        );

        const fitWhenVisible = () => {
          if (
            disposed ||
            !hostRef.current ||
            hostRef.current.hidden ||
            hostRef.current.clientWidth === 0 ||
            hostRef.current.clientHeight === 0
          ) {
            return;
          }
          try {
            fit.fit();
          } catch (error) {
            onError(errMessage(error));
          }
        };
        resizeObserver = new ResizeObserver(fitWhenVisible);
        resizeObserver.observe(hostRef.current);
        window.requestAnimationFrame(fitWhenVisible);
        setLoading(false);
      } catch (error) {
        if (disposed) return;
        const message = errMessage(error);
        setLoadError(message);
        setLoading(false);
        onError(message);
      }
    }

    void mountTerminal();
    return () => {
      disposed = true;
      if (inputTimer !== null) window.clearTimeout(inputTimer);
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      sendInput();
      resizeObserver?.disconnect();
      registerOutput(session.id, null);
      for (const disposable of disposables) disposable.dispose();
      fitRef.current?.dispose();
      terminalRef.current?.dispose();
      fitRef.current = null;
      terminalRef.current = null;
    };
  }, [onError, registerOutput, session.id, session.size.cols, session.size.rows, t]);

  useEffect(() => {
    if (!terminalRef.current) return;
    terminalRef.current.options.disableStdin =
      session.lifecycle === "exited" || session.lifecycle === "failed";
  }, [session.lifecycle]);

  useEffect(() => {
    if (!active || !terminalRef.current || !fitRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
        terminalRef.current?.focus();
      } catch (error) {
        onError(errMessage(error));
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, onError]);

  return (
    <div
      ref={hostRef}
      className="terminal-surface"
      role="tabpanel"
      id={`terminal-panel-${session.id}`}
      aria-labelledby={`terminal-tab-${session.id}`}
      aria-label={`${t("terminal.title")} · ${session.name}`}
      hidden={!active}
    >
      {loading && (
        <div className="terminal-surface-status muted">
          {t("common.loading")}
        </div>
      )}
      {loadError && (
        <div className="terminal-surface-status error" role="alert">
          {loadError}
        </div>
      )}
    </div>
  );
}
