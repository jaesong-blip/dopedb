// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./SkillSetupTerminal", () => ({
  default: ({ command }: { command: string }) => (
    <div role="region" aria-label="mock setup Terminal">
      {command}
    </div>
  ),
}));

import { ToastProvider } from "../../components/Toast";
import { I18nProvider } from "../../lib/i18n";
import SkillSetupPanel from "./SkillSetupPanel";
import {
  buildSkillSetupPlan,
  type SkillSetupTargetStatus,
} from "./setupPolicy";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const writeText = vi.fn(async () => undefined);
let root: ReturnType<typeof createRoot> | null = null;

function missingTarget(): SkillSetupTargetStatus {
  return {
    target: "codex",
    displayName: "Codex",
    state: "missing",
    currentRevision: 7,
    installedRevision: null,
  };
}

async function renderPanel(lang: "en" | "ko", onClose = vi.fn()) {
  localStorage.setItem("dopedb.lang", lang);
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <I18nProvider>
        <ToastProvider>
          <SkillSetupPanel
            plan={buildSkillSetupPlan([missingTarget()])}
            onClose={onClose}
          />
        </ToastProvider>
      </I18nProvider>,
    );
  });
  return onClose;
}

beforeEach(() => {
  localStorage.clear();
  writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
  }
  root = null;
  document.body.replaceChildren();
  localStorage.clear();
});

describe("SkillSetupPanel", () => {
  it("exposes the exact English command to copy without executing it", async () => {
    const onClose = await renderPanel("en");
    expect(document.body.textContent).toContain("Install DopeDB Skill");
    expect(document.body.textContent).toContain(
      "dopedb skill install --target codex",
    );

    const copy = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy command"]',
    );
    const close = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Close setup Terminal"]',
    );
    expect(copy).not.toBeNull();
    expect(close).not.toBeNull();

    await act(async () => copy?.click());
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(
      "dopedb skill install --target codex",
    );

    close?.focus();
    expect(document.activeElement).toBe(close);
    await act(async () => close?.click());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("provides Korean labels and the same screen-reader controls", async () => {
    await renderPanel("ko");

    expect(document.body.textContent).toContain("DopeDB 스킬 설치");
    expect(
      document.querySelector('button[aria-label="명령 복사"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('button[aria-label="설정 터미널 닫기"]'),
    ).not.toBeNull();
  });

  it("uses Escape as the same quiet close path", async () => {
    const onClose = await renderPanel("en");

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    expect(onClose).toHaveBeenCalledOnce();
  });
});
