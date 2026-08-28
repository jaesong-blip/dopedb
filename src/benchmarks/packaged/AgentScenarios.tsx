// Packaged Agent transcript and Skill lifecycle scenarios. ACP projection and
// Agent setup accessibility remain together as one provider-runtime benchmark family.
import { useRef, useState } from "react";

import { AgentPermissionCard } from "../../design-system/components/Agent";
import {
  AgentRichText,
  AgentStreamingText,
} from "../../design-system/components/AgentRichText";
import type { AcpSessionEvent, AcpSessionId } from "../../features/agents/domain";
import type {
  AcpConversationProjection,
  AcpTranscriptItem,
} from "../../features/agents/transcript";
import {
  appendAcpConversationEvents,
  createAcpConversationProjection,
  mergeAcpConversationFocus,
  visibleAcpTranscriptItems,
} from "../../features/agents/transcript";
import { openAgentSetup } from "../../features/skills/agentPreferences";
import SkillStartupGate from "../../features/skills/SkillStartupGate";
import { removeSkill, skillStatus } from "../../features/skills/tauriAdapter";
import { preparePackagedBenchmarkWorkload, setPackagedBenchmarkCompactWindow } from "../../features/runtime/tauriAdapter";
import type { SkillStatus, SkillTargetExpectation } from "../../ipc/types";
import { messages } from "../../lib/i18n/catalog";
import { useI18n } from "../../lib/i18n";
import type { Lang } from "../../lib/i18n/types";
import AgentToolsSettings from "../../screens/Settings/AgentTools";
import { runPackagedBenchmarkBackend } from "../backend";
import {
  measurePackagedAction,
  measurePackagedIdle,
  waitForPackagedPaint,
} from "../packagedMetrics";
import {
  ACTION_SAMPLES,
  BenchmarkSurface,
  backendEvidence,
  finishBenchmark,
  samples,
  useScenarioRunner,
} from "./benchmarkHarness";

export function AgentTranscriptScenario() {
  const [projection, setProjection] = useState<AcpConversationProjection>(() =>
    createAcpConversationProjection([]),
  );
  const [turnComplete, setTurnComplete] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);

  useScenarioRunner(true, async () => {
    let currentProjection = projection;
    await measurePackagedAction("agent-stream-10k", async () => {
      const events = agentEvents(10_000);
      const persisted = runPackagedBenchmarkBackend("agent-stream-10k");
      const merged = appendAcpConversationEvents(currentProjection, events).projection;
      currentProjection = merged;
      setProjection({ ...merged });
      const receipt = await persisted;
      return {
        ...backendEvidence(receipt),
        retainedBytes: merged.transcriptBytes + merged.recentBytes + receipt.retainedBytes,
      };
    });
    await waitForPackagedPaint();
    setTurnComplete(true);
    await waitForPackagedPaint();
    await samples("agent-manual-scroll", ACTION_SAMPLES, (index) => {
      const transcript = transcriptRef.current;
      if (!transcript) throw new Error("Agent transcript unavailable");
      transcript.scrollTop = index % 2 === 0 ? 0 : transcript.scrollHeight;
      transcript.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await measurePackagedAction("agent-permission", () => {
      const event = permissionEvent(currentProjection.lastSequence + 1);
      const merged = appendAcpConversationEvents(currentProjection, [event]).projection;
      currentProjection = merged;
      setProjection({ ...merged });
    });
    await measurePackagedAction("agent-reconnect", () => {
      const replay = agentEvents(512, Math.max(1, currentProjection.lastSequence - 511));
      const merged = mergeAcpConversationFocus(currentProjection, replay, true);
      currentProjection = merged;
      setProjection({ ...merged });
      return { retainedBytes: merged.transcriptBytes + merged.recentBytes };
    });
    await finishBenchmark();
  });

  const items = visibleAcpTranscriptItems(projection);
  return (
    <BenchmarkSurface title={`Agent · 10 minute / 10,000 event transcript · ${items.length} retained items`}>
      <div ref={transcriptRef} className="tw:min-h-0 tw:flex-1 tw:overflow-auto tw:p-4">
        <div className="tw:grid tw:min-w-0 tw:gap-3">
          {items.map((item) => (
            <BenchmarkTranscriptItem
              key={item.key}
              item={item}
              turnComplete={turnComplete}
            />
          ))}
        </div>
      </div>
    </BenchmarkSurface>
  );
}

function BenchmarkTranscriptItem({
  item,
  turnComplete,
}: {
  item: AcpTranscriptItem;
  turnComplete: boolean;
}) {
  if (item.kind === "agent" || item.kind === "thought") {
    if (item.kind === "agent" && turnComplete) {
      return <AgentRichText labels={agentRichTextLabels} text={item.chunks.join("")} />;
    }
    return <AgentStreamingText chunks={item.chunks} revision={item.revision} />;
  }
  if (item.kind === "permission") {
    return (
      <AgentPermissionCard
        title="Permission"
        description="Synthetic benchmark permission"
        pending
        status="Waiting"
        actions={<button type="button">Allow once</button>}
      />
    );
  }
  if (item.kind === "user") {
    return <p className="tw:m-0 tw:rounded-md tw:bg-selection tw:p-2">{item.text}</p>;
  }
  if (item.kind === "turnEnd") {
    return <AgentRichText labels={agentRichTextLabels} text={`Completed: ${item.stopReason}`} />;
  }
  return <span className="tw:text-xs tw:text-muted-foreground">activity</span>;
}

const agentRichTextLabels = {
  copied: "Copied",
  copyCode: "Copy",
  diagram: "Diagram",
  diagramError: "Diagram error",
  diagramLoading: "Loading",
  diagramSource: "Source",
  imageOmitted: "Image omitted",
  openLink: "Open",
  plainTextFallback: "Shown as plain text for stability",
};

function agentEvents(count: number, start = 1): AcpSessionEvent[] {
  const sessionId = "00000000-0000-0000-0000-0000000000ac" as AcpSessionId;
  return Array.from({ length: count }, (_, offset) => {
    const sequence = start + offset;
    return {
      sessionId,
      sequence,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence * 0.06)).toISOString(),
      type: "sessionUpdate" as const,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "benchmark-message",
        content: { type: "text", text: `${sequence % 10}` },
      },
    };
  });
}

function permissionEvent(sequence: number): AcpSessionEvent {
  return {
    sessionId: "00000000-0000-0000-0000-0000000000ac" as AcpSessionId,
    sequence,
    createdAt: "2026-01-01T00:10:00.000Z",
    type: "permissionRequest",
    requestId: "benchmark-permission",
    toolCall: { title: "Read schema" },
    options: [{ id: "once", name: "Allow once", kind: "allowOnce" }],
  };
}

function skillExpectations(status: SkillStatus): SkillTargetExpectation[] {
  return status.targets.map((target) => ({
    target: target.target,
    inventoryFingerprint: target.inventoryFingerprint,
  }));
}

function assertSkillState(status: SkillStatus, expected: "missing" | "managed_current") {
  if (status.targets.length !== 2 || status.targets.some((target) => target.state !== expected)) {
    throw new Error(`packaged Skill inventory did not converge to ${expected}`);
  }
  if (
    expected === "managed_current"
    && status.targets.some((target) =>
      target.installedRevision !== status.skill.releaseRevision
      || target.installedPackageDigest !== status.skill.packageDigest)
  ) {
    throw new Error("packaged Skill inventory revision or digest is stale");
  }
}

export function AgentToolsScenario({
  phase,
}: {
  phase: "install" | "restart" | null;
}) {
  const { setLang } = useI18n();
  const [status, setStatus] = useState<SkillStatus | null>(null);
  const [surfaceMounted, setSurfaceMounted] = useState(true);
  const [settingsMounted, setSettingsMounted] = useState(false);

  useScenarioRunner(true, async () => {
    await setPackagedBenchmarkCompactWindow(true);
    await waitForPackagedViewport(360, 640);
    for (const lang of ["en", "ko"] as const) {
      setLang(lang);
      await waitForDocumentLanguage(lang);
      if (lang === "ko") openAgentSetup();
      await validateAndDismissAgentSelectionModal(lang);
    }
    await setPackagedBenchmarkCompactWindow(false);
    await waitForPackagedPaint();
    setSettingsMounted(true);
    await waitForPackagedPaint();
    const initial = await skillStatus("all");
    assertSkillState(initial, phase === "restart" ? "managed_current" : "missing");
    setStatus(initial);

    if (phase !== "restart") {
      await preparePackagedBenchmarkWorkload();
      await measurePackagedAction("agent-skill-install-all", async () => {
        const installButton = await waitForAgentSkillInstallButton();
        installButton.click();
        const installed = await waitForAgentSkillState("managed_current");
        assertSkillState(installed, "managed_current");
        setStatus(installed);
      });
    }

    if (phase !== "install") {
      await preparePackagedBenchmarkWorkload();
      await measurePackagedAction("agent-skill-reload", async () => {
        const receipt = await runPackagedBenchmarkBackend("agent-skill-reload");
        if (receipt.rowCount !== 2) {
          throw new Error("restarted app did not find both packaged Skill targets");
        }
        const reloaded = await skillStatus("all");
        assertSkillState(reloaded, "managed_current");
        setStatus({ ...reloaded });
        return backendEvidence(receipt);
      });
      await preparePackagedBenchmarkWorkload();
      await measurePackagedAction("agent-skill-remove-all", async () => {
        const current = await skillStatus("all");
        const receipt = await removeSkill("all", skillExpectations(current));
        assertSkillState(receipt.status, "missing");
        if (receipt.changedTargets.length !== 2) {
          throw new Error("packaged Skill removal did not change both targets");
        }
        setStatus(receipt.status);
      });
    }
    setSurfaceMounted(false);
    await waitForPackagedPaint();
    await new Promise((resolve) => window.setTimeout(resolve, 750));
    await measurePackagedIdle(1_500);
    await finishBenchmark();
  });

  return (
    <BenchmarkSurface title={`Agent tools · ${phase ?? "single-process compatibility"}`}>
      <div className="tw:min-h-0 tw:flex-1 tw:overflow-auto">
        {surfaceMounted ? (
          <>
            <SkillStartupGate />
            {settingsMounted ? <AgentToolsSettings /> : null}
          </>
        ) : null}
        <output className="tw:sr-only" aria-live="polite">
          {status?.targets.map((target) => `${target.target}:${target.state}`).join(",")}
        </output>
      </div>
    </BenchmarkSurface>
  );
}

async function waitForPackagedViewport(maxWidth: number, maxHeight: number) {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    if (window.innerWidth <= maxWidth && window.innerHeight <= maxHeight) return;
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }
  throw new Error("packaged compact viewport timed out");
}

async function waitForDocumentLanguage(lang: Lang) {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    if (document.documentElement.lang === lang) {
      await waitForPackagedPaint();
      return;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }
  throw new Error("packaged Agent locale timed out");
}

async function validateAndDismissAgentSelectionModal(lang: Lang) {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
    if (dialog) {
      const titleId = dialog.getAttribute("aria-labelledby");
      const descriptionId = dialog.getAttribute("aria-describedby");
      const checkedTargets = dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked');
      const title = titleId ? document.getElementById(titleId)?.textContent?.trim() : null;
      const description = descriptionId
        ? document.getElementById(descriptionId)?.textContent?.trim()
        : null;
      if (
        !titleId
        || !descriptionId
        || !document.getElementById(titleId)
        || !document.getElementById(descriptionId)
        || document.documentElement.lang !== lang
        || title !== messages[lang]["agentTools.startupTitle"]
        || description !== messages[lang]["agentTools.startupBody"]
        || checkedTargets.length !== 2
      ) {
        throw new Error("Agent selection modal accessibility contract is incomplete");
      }
      const bounds = dialog.getBoundingClientRect();
      if (
        window.innerWidth > 360
        || window.innerHeight > 640
        || bounds.left < 0
        || bounds.top < 0
        || bounds.right > window.innerWidth
        || bounds.bottom > window.innerHeight
        || dialog.scrollWidth > dialog.clientWidth
      ) {
        throw new Error("Agent selection modal escaped the 360px packaged viewport");
      }
      const initialFocus = dialog.querySelector<HTMLElement>("[data-modal-initial-focus]");
      if (document.activeElement !== initialFocus) await waitForPackagedPaint();
      if (document.activeElement !== initialFocus) {
        throw new Error("Agent selection modal did not establish keyboard focus");
      }
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])",
      )).filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0);
      const last = focusable[focusable.length - 1];
      last?.focus();
      last?.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      }));
      if (document.activeElement !== focusable[0]) {
        throw new Error("Agent selection modal did not contain forward keyboard focus");
      }
      focusable[0]?.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }));
      if (document.activeElement !== last) {
        throw new Error("Agent selection modal did not contain reverse keyboard focus");
      }
      dialog.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }));
      await waitForPackagedPaint();
      if (document.body.contains(dialog)) {
        throw new Error("Agent selection modal did not close from the keyboard");
      }
      return;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }
  throw new Error("Agent selection modal surface timed out");
}

async function waitForAgentSkillInstallButton() {
  const deadline = performance.now() + 15_000;
  while (performance.now() < deadline) {
    const button = document.querySelector<HTMLButtonElement>(
      '[data-agent-skill-batch-action="install"]',
    );
    if (button && !button.disabled) return button;
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }
  throw new Error("Agent Tools install surface timed out");
}

async function waitForAgentSkillState(expected: "managed_current" | "missing") {
  const deadline = performance.now() + 15_000;
  while (performance.now() < deadline) {
    const status = await skillStatus("all");
    if (status.targets.every((target) => target.state === expected)) return status;
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }
  throw new Error(`Agent Tools inventory timed out waiting for ${expected}`);
}
