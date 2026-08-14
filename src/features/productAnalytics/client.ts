// Consent-gated product analytics runtime. Native code owns availability and
// delivery; this WebView layer owns a closed event vocabulary, immediate
// identity hashing, a seven-day local retry queue, and observable consent state.
import { getVersion } from "@tauri-apps/api/app";
import { useSyncExternalStore } from "react";

import type {
  ProductAnalyticsEvent,
  ProductAnalyticsEventInput,
  ProductAnalyticsLocale,
  ProductAnalyticsPlatform,
  ProductAnalyticsSnapshot,
  QueuedProductAnalyticsEvent,
} from "./domain";
import {
  isProductAnalyticsAppVersion,
  isProductAnalyticsEventInput,
  isProductAnalyticsUuid,
} from "./domain";
import {
  ProductAnalyticsLocalStore,
  productAnalyticsInstallationReadyInput,
} from "./storage";
import {
  productAnalyticsStatus,
  setProductAnalyticsConsent,
  submitProductAnalyticsBatch,
} from "./tauriAdapter";

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60_000;

type Listener = () => void;

function browserStorage() {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function currentPlatform(): ProductAnalyticsPlatform {
  const userAgent = navigator.userAgent.toLowerCase();
  if (userAgent.includes("macintosh") || userAgent.includes("mac os x")) {
    return "macos";
  }
  if (userAgent.includes("windows")) return "windows";
  if (userAgent.includes("linux")) return "linux";
  return "unknown";
}

function currentLocale(): ProductAnalyticsLocale {
  const language = document.documentElement.lang || navigator.language;
  return language.toLowerCase().startsWith("ko") ? "ko" : "en";
}

function isOnline() {
  return typeof navigator.onLine !== "boolean" || navigator.onLine;
}

async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function identityHashInput(kind: "actor" | "workspace", id: string) {
  return `dopedb-product-analytics:${kind}:v1:${id.toLowerCase()}`;
}

async function hashedContext(
  input: ProductAnalyticsEventInput,
  installationId: string,
) {
  if (input.name === "desktop_installation_ready") return {};
  if (input.name === "workspace_authentication_completed") {
    if (input.properties.outcome !== "success" || !input.context) return {};
    return {
      actorKey: await sha256Hex(
        identityHashInput("actor", input.context.actorId),
      ),
    };
  }
  if (input.context.workspaceKind === "personal") {
    // Personal workspace IDs are reserved and identical across installations.
    // Deriving this scope from the installation prevents unrelated individuals
    // from collapsing into one analytics identity.
    return {
      workspaceKey: await sha256Hex(
        `dopedb-product-analytics:workspace:v1:personal:${installationId}`,
      ),
      workspaceKind: "personal" as const,
    };
  }
  return {
    actorKey: await sha256Hex(
      identityHashInput("actor", input.context.actorId),
    ),
    workspaceKey: await sha256Hex(
      identityHashInput("workspace", input.context.workspaceId),
    ),
    workspaceKind: "team" as const,
  };
}

function newSessionId() {
  try {
    const value = crypto.randomUUID().toLowerCase();
    return isProductAnalyticsUuid(value) ? value : null;
  } catch {
    return null;
  }
}

const localStore = new ProductAnalyticsLocalStore(browserStorage());
const listeners = new Set<Listener>();
const completedSessionCaptures = new Set<string>();
const pendingSessionCaptures = new Map<string, Promise<boolean>>();
let availability: ProductAnalyticsSnapshot["availability"] = "checking";
let appVersion: string | null = null;
let sessionId = newSessionId();
let sending = false;
let retryAttempt = 0;
let retryTimer: number | null = null;
let initialized = false;
let initializePromise: Promise<void> | null = null;
let snapshot: ProductAnalyticsSnapshot = {
  availability,
  consent: localStore.getSnapshot().consent,
  queueSize: localStore.getSnapshot().queueSize,
  sending,
};

function publish() {
  const local = localStore.getSnapshot();
  const next: ProductAnalyticsSnapshot = {
    availability,
    consent: local.consent,
    queueSize: local.queueSize,
    sending,
  };
  if (
    next.availability === snapshot.availability &&
    next.consent === snapshot.consent &&
    next.queueSize === snapshot.queueSize &&
    next.sending === snapshot.sending
  ) {
    return;
  }
  snapshot = next;
  for (const listener of listeners) listener();
}

localStore.subscribe(publish);

function subscribe(listener: Listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return snapshot;
}

function clearRetry() {
  if (retryTimer !== null) window.clearTimeout(retryTimer);
  retryTimer = null;
  retryAttempt = 0;
}

function scheduleRetry() {
  if (
    retryTimer !== null ||
    snapshot.consent !== "granted" ||
    availability !== "available" ||
    snapshot.queueSize === 0
  ) {
    return;
  }
  const delay = Math.min(
    RETRY_BASE_MS * 2 ** Math.min(retryAttempt, 10),
    RETRY_MAX_MS,
  );
  retryAttempt += 1;
  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    void flushProductAnalytics();
  }, delay);
}

function attachLifecycleListeners() {
  window.addEventListener("online", () => void flushProductAnalytics());
  window.addEventListener("storage", () => {
    localStore.reload();
    if (snapshot.consent !== "granted") clearRetry();
    else void flushProductAnalytics();
  });
  document.addEventListener("visibilitychange", () => {
    void flushProductAnalytics();
  });
}

export function initializeProductAnalytics() {
  if (initializePromise) return initializePromise;
  initializePromise = (async () => {
    if (!initialized) {
      initialized = true;
      attachLifecycleListeners();
    }
    try {
      const status = await productAnalyticsStatus();
      localStore.applyConsent(status.consent);
      if (status.enabled !== true) {
        availability = "unavailable";
        publish();
        return;
      }
      const version = await getVersion();
      if (!isProductAnalyticsAppVersion(version) || sessionId === null) {
        availability = "unavailable";
        publish();
        return;
      }
      appVersion = version;
      availability = "available";
      publish();
      if (snapshot.consent === "granted") {
        const installationReady = await captureDesktopInstallationReady();
        if (installationReady) void flushProductAnalytics();
      }
    } catch {
      availability = "unavailable";
      publish();
    }
  })();
  return initializePromise;
}

export function useProductAnalyticsSnapshot() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

async function captureDesktopInstallationReady() {
  if (
    snapshot.consent !== "granted" ||
    availability !== "available"
  ) {
    return false;
  }
  let installation;
  try {
    installation = localStore.ensureInstallation(() => crypto.randomUUID());
  } catch {
    return false;
  }
  if (!installation) return false;
  if (installation.readyRecorded) return true;
  const captured = await captureProductEventInternal(
    productAnalyticsInstallationReadyInput(installation),
    false,
    false,
  );
  if (!captured) return false;
  // Persist the local exactly-once marker before any delivery can start. If the
  // write fails, the deterministic queued event remains for a later retry.
  return localStore.markInstallationReadyRecorded(installation.id);
}

export async function grantProductAnalyticsConsent() {
  if (availability !== "available") return false;
  try {
    const status = await setProductAnalyticsConsent("granted");
    if (status.consent !== "granted") return false;
    localStore.applyConsent(status.consent);
    availability = status.enabled ? "available" : "unavailable";
    publish();
    if (status.enabled) {
      const installationReady = await captureDesktopInstallationReady();
      if (installationReady) void flushProductAnalytics();
    }
    return status.enabled;
  } catch {
    return false;
  }
}

export async function denyProductAnalyticsConsent() {
  clearRetry();
  completedSessionCaptures.clear();
  pendingSessionCaptures.clear();
  // A later opt-in starts a fresh analytics session as well as a fresh
  // installation. Never let the prior process-session key bridge consent eras.
  sessionId = newSessionId();
  // Revocation is fail-closed locally before IPC so an unavailable native host
  // cannot leave queued data or this process's installation identity behind.
  localStore.applyConsent("denied");
  try {
    const status = await setProductAnalyticsConsent("denied");
    availability = status.enabled ? "available" : "unavailable";
    if (status.consent !== "denied") {
      localStore.applyConsent("pending");
      publish();
      return false;
    }
    publish();
    return true;
  } catch {
    // Keep collection disabled but surface the choice as unresolved so the
    // onboarding prompt can report the native persistence failure.
    localStore.applyConsent("pending");
    return false;
  }
}

async function captureProductEventInternal(
  input: ProductAnalyticsEventInput,
  oncePerSession: boolean,
  flushAfterCapture = true,
) {
  if (
    snapshot.consent !== "granted" ||
    availability !== "available" ||
    appVersion === null ||
    sessionId === null ||
    !isProductAnalyticsEventInput(input)
  ) {
    return false;
  }
  let installation;
  try {
    installation = localStore.ensureInstallation(() => crypto.randomUUID());
  } catch {
    return false;
  }
  if (!installation) return false;
  let occurredAt: string;
  let context: Awaited<ReturnType<typeof hashedContext>>;
  let sessionCaptureKey: string | null = null;
  try {
    occurredAt = new Date().toISOString();
    context = await hashedContext(input, installation.id);
    if (oncePerSession) {
      sessionCaptureKey = await sha256Hex(
        `dopedb-product-analytics:session-event:v1:${sessionId}:${input.name}:${context.actorKey ?? ""}:${context.workspaceKey ?? ""}:${JSON.stringify(input.properties)}`,
      );
    }
  } catch {
    return false;
  }
  if (sessionCaptureKey !== null) {
    if (completedSessionCaptures.has(sessionCaptureKey)) return true;
    const pending = pendingSessionCaptures.get(sessionCaptureKey);
    if (pending) return pending;
  }

  const attempt = (async () => {
    let eventId: string;
    try {
      if (input.dedupeId) {
        eventId = await sha256Hex(
          `dopedb-product-analytics:event:v1:${input.name}:${input.dedupeId.toLowerCase()}`,
        );
      } else if (sessionCaptureKey !== null) {
        eventId = sessionCaptureKey;
      } else {
        const nonce = crypto.randomUUID().toLowerCase();
        if (!isProductAnalyticsUuid(nonce)) return false;
        eventId = await sha256Hex(
          `dopedb-product-analytics:event:v1:${installation.id}:${sessionId}:${occurredAt}:${input.name}:${nonce}`,
        );
      }
    } catch {
      return false;
    }
    if (
      snapshot.consent !== "granted" ||
      availability !== "available" ||
      appVersion === null ||
      sessionId === null
    ) {
      return false;
    }
    const event = {
      eventId,
      name: input.name,
      occurredAt,
      properties: input.properties,
      ...context,
    } as ProductAnalyticsEvent;
    const queued: QueuedProductAnalyticsEvent = {
      sessionId,
      appVersion,
      platform: currentPlatform(),
      locale: currentLocale(),
      event,
    };
    if (!localStore.enqueue(queued)) return false;
    if (flushAfterCapture && isOnline()) void flushProductAnalytics();
    return true;
  })();

  if (sessionCaptureKey === null) return attempt;
  pendingSessionCaptures.set(sessionCaptureKey, attempt);
  try {
    const captured = await attempt;
    if (captured) completedSessionCaptures.add(sessionCaptureKey);
    return captured;
  } finally {
    if (pendingSessionCaptures.get(sessionCaptureKey) === attempt) {
      pendingSessionCaptures.delete(sessionCaptureKey);
    }
  }
}

export function captureProductEvent(input: ProductAnalyticsEventInput) {
  return captureProductEventInternal(input, false);
}

export function captureProductEventOncePerSession(
  input: ProductAnalyticsEventInput,
) {
  return captureProductEventInternal(input, true);
}

export async function flushProductAnalytics() {
  if (
    sending ||
    snapshot.consent !== "granted" ||
    availability !== "available" ||
    !isOnline()
  ) {
    return;
  }
  sending = true;
  publish();
  try {
    let installation = localStore.installation();
    if (!installation) {
      localStore.discardQueue();
      return;
    }
    if (!installation.readyRecorded) {
      const installationReady = await captureDesktopInstallationReady();
      installation = localStore.installation();
      if (!installationReady || !installation?.readyRecorded) {
        scheduleRetry();
        return;
      }
    }
    while (snapshot.consent === "granted") {
      const items = localStore.peekBatch();
      const first = items[0];
      if (!first) {
        clearRetry();
        break;
      }
      const receipt = await submitProductAnalyticsBatch({
        schemaVersion: 1,
        installationId: installation.id,
        sessionId: first.sessionId,
        appVersion: first.appVersion,
        platform: first.platform,
        locale: first.locale,
        events: items.map((item) => item.event),
      });
      if (receipt.accepted !== true) {
        const status = await productAnalyticsStatus();
        localStore.applyConsent(status.consent);
        availability = status.enabled ? "available" : "unavailable";
        publish();
        if (!status.enabled || status.consent !== "granted") break;
        throw new Error("analytics batch rejected");
      }
      localStore.removeEvents(items.map((item) => item.event.eventId));
      retryAttempt = 0;
    }
  } catch {
    scheduleRetry();
  } finally {
    sending = false;
    publish();
  }
}
