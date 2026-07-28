// @vitest-environment happy-dom
import {
  StrictMode,
  act,
  forwardRef,
  useEffect,
  useImperativeHandle,
} from "react";
import { createRoot } from "react-dom/client";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const fakes = vi.hoisted(() => ({
  close: vi.fn(),
  create: vi.fn(),
  draft: vi.fn(),
  exitUnlisten: vi.fn(),
  stateUnlisten: vi.fn(),
  surfaceMode: "prompt" as "prompt" | "fallback",
}));

vi.mock("../terminals/tauriAdapter", () => ({
  onSkillSetupTerminalExit: vi.fn(async () => fakes.exitUnlisten),
  onSkillSetupTerminalState: vi.fn(async () => fakes.stateUnlisten),
  skillSetupTerminalClose: fakes.close,
  skillSetupTerminalCreate: fakes.create,
  skillSetupTerminalDraft: fakes.draft,
  skillSetupTerminalResize: vi.fn(async () => undefined),
  skillSetupTerminalWrite: vi.fn(async () => undefined),
  terminalOutputChannel: vi.fn(() => ({})),
}));

vi.mock("../terminals/PtySurface", () => ({
  default: forwardRef(function MockPtySurface(
    props: {
      session: { id: string };
      registerOutput: (id: string, writer: null) => void;
      onReady?: () => void;
      onPromptVisible?: () => void;
    },
    ref,
  ) {
    useImperativeHandle(ref, () => ({ focus: vi.fn() }), []);
    useEffect(() => {
      props.registerOutput(props.session.id, null);
      props.onReady?.();
      if (fakes.surfaceMode === "prompt") {
        props.onPromptVisible?.();
        props.onPromptVisible?.();
      }
      return () => props.registerOutput(props.session.id, null);
    }, [props]);
    return <div data-testid="mock-pty" />;
  }),
}));

import { I18nProvider } from "../../lib/i18n";
import { skillSetupCommandDraft } from "../terminals/domain";
import SkillSetupTerminal from "./SkillSetupTerminal";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: ReturnType<typeof createRoot> | null = null;
let sequence = 0;

function session() {
  sequence += 1;
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    lifecycle: "running",
    size: { cols: 88, rows: 14, pixelWidth: 0, pixelHeight: 0 },
    createdAt: "2026-07-28T00:00:00.000Z",
    lastActivityAt: "2026-07-28T00:00:00.000Z",
    exit: null,
  };
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function terminalContent(command: string) {
  return (
    <I18nProvider>
      <SkillSetupTerminal command={skillSetupCommandDraft(command)} />
    </I18nProvider>
  );
}

async function renderTerminal(
  strict = false,
  command = "dopedb skill install --target all",
) {
  if (!root) {
    const node = document.body.appendChild(document.createElement("div"));
    root = createRoot(node);
  }
  const content = terminalContent(command);
  await act(async () => {
    root?.render(strict ? <StrictMode>{content}</StrictMode> : content);
  });
  await act(async () => vi.advanceTimersByTimeAsync(0));
  await flushMicrotasks();
}

beforeEach(() => {
  sequence = 0;
  fakes.surfaceMode = "prompt";
  fakes.close.mockReset().mockResolvedValue(undefined);
  fakes.create.mockReset().mockImplementation(async () => session());
  fakes.draft.mockReset().mockResolvedValue(undefined);
  fakes.exitUnlisten.mockReset();
  fakes.stateUnlisten.mockReset();
  vi.useFakeTimers();
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
  }
  root = null;
  document.body.replaceChildren();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("SkillSetupTerminal", () => {
  it("inserts once after a visible prompt despite repeated readiness signals", async () => {
    await renderTerminal();

    await act(async () => vi.advanceTimersByTimeAsync(119));
    expect(fakes.draft).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    await flushMicrotasks();
    expect(fakes.draft).toHaveBeenCalledOnce();
    expect(fakes.draft).toHaveBeenCalledWith(
      expect.any(String),
      "dopedb skill install --target all",
    );

    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(fakes.draft).toHaveBeenCalledOnce();
  });

  it("uses the bounded renderer fallback without submitting a newline", async () => {
    fakes.surfaceMode = "fallback";
    await renderTerminal();

    await act(async () => vi.advanceTimersByTimeAsync(899));
    expect(fakes.draft).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    await flushMicrotasks();

    expect(fakes.draft).toHaveBeenCalledOnce();
    expect(fakes.draft.mock.calls[0][1]).not.toMatch(/[\r\n]/);
  });

  it("does not insert a second draft when the parent changes the command", async () => {
    await renderTerminal();
    await act(async () => vi.advanceTimersByTimeAsync(120));
    await flushMicrotasks();

    await renderTerminal(
      false,
      "dopedb skill install --target claude-code",
    );
    await act(async () => vi.advanceTimersByTimeAsync(2_000));

    expect(fakes.draft).toHaveBeenCalledOnce();
    expect(fakes.draft).toHaveBeenCalledWith(
      expect.any(String),
      "dopedb skill install --target all",
    );
  });

  it("does not create a discarded StrictMode session and cleans the live session", async () => {
    await renderTerminal(true);
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    await flushMicrotasks();

    expect(fakes.create).toHaveBeenCalledOnce();
    expect(fakes.draft).toHaveBeenCalledOnce();

    await act(async () => root?.unmount());
    root = null;
    await flushMicrotasks();

    expect(fakes.close).toHaveBeenCalledOnce();
    expect(fakes.stateUnlisten).toHaveBeenCalledTimes(2);
    expect(fakes.exitUnlisten).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes a slow session that resolves after the setup surface is gone", async () => {
    let resolveCreate: ((value: ReturnType<typeof session>) => void) | null =
      null;
    fakes.create.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );
    await renderTerminal();
    expect(fakes.create).toHaveBeenCalledOnce();

    await act(async () => root?.unmount());
    root = null;
    await act(async () => {
      resolveCreate?.(session());
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(fakes.draft).not.toHaveBeenCalled();
    expect(fakes.close).toHaveBeenCalledOnce();
    expect(fakes.stateUnlisten).toHaveBeenCalledOnce();
    expect(fakes.exitUnlisten).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
