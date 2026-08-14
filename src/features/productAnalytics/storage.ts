// Native app settings own consent. This store persists only the pseudonymous
// installation identity and bounded retry queue, and will expose neither until
// the native consent status has been applied for this process.
import type {
  ProductAnalyticsConsent,
  ProductAnalyticsEventInput,
  QueuedProductAnalyticsEvent,
} from "./domain";
import {
  isProductAnalyticsUuid,
  isQueuedProductAnalyticsEvent,
  PRODUCT_ANALYTICS_MAX_AGE_MS,
  PRODUCT_ANALYTICS_MAX_BATCH,
  PRODUCT_ANALYTICS_MAX_QUEUE,
} from "./domain";

const INSTALLATION_KEY = "dopedb:product-analytics:installation:v1";
const QUEUE_KEY = "dopedb:product-analytics:queue:v1";
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;

export type ProductAnalyticsStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

export type InstallationRecord = {
  id: string;
  readyRecorded: boolean;
};

export type ProductAnalyticsLocalSnapshot = {
  consent: ProductAnalyticsConsent;
  queueSize: number;
};

type Listener = () => void;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(storage: ProductAnalyticsStorage | null, key: string) {
  if (!storage) return null;
  try {
    const value = storage.getItem(key);
    return value === null ? null : JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function normalizeInstallation(value: unknown): InstallationRecord | null {
  if (!isObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 2 && keys.length !== 3) return null;
  if (!keys.every((key) => (
    key === "id" || key === "createdAt" || key === "readyRecorded"
  ))) {
    return null;
  }
  const legacyCreatedAt = "createdAt" in value;
  const hasReadyMarker = "readyRecorded" in value;
  if (!legacyCreatedAt && !hasReadyMarker) return null;
  if (typeof value.id !== "string" || !isProductAnalyticsUuid(value.id)) {
    return null;
  }
  if (
    (legacyCreatedAt && (
      typeof value.createdAt !== "string" ||
      !Number.isFinite(Date.parse(value.createdAt))
    )) ||
    (hasReadyMarker && typeof value.readyRecorded !== "boolean")
  ) {
    return null;
  }
  return {
    id: value.id,
    // Records written before the exactly-once marker carried a local creation
    // timestamp. It was never a real install timestamp, so migrate it away.
    readyRecorded: value.readyRecorded === true,
  };
}

function sameEnvelope(
  left: QueuedProductAnalyticsEvent,
  right: QueuedProductAnalyticsEvent,
) {
  return left.sessionId === right.sessionId &&
    left.appVersion === right.appVersion &&
    left.platform === right.platform &&
    left.locale === right.locale;
}

function sanitizeQueue(value: unknown, now: number) {
  if (!Array.isArray(value)) return [];
  const oldest = now - PRODUCT_ANALYTICS_MAX_AGE_MS;
  const newest = now + MAX_FUTURE_SKEW_MS;
  const eventIds = new Set<string>();
  const queue = value
    .filter(isQueuedProductAnalyticsEvent)
    .filter((item) => {
      const occurredAt = Date.parse(item.event.occurredAt);
      return occurredAt >= oldest && occurredAt <= newest;
    })
    .filter((item) => {
      if (eventIds.has(item.event.eventId)) return false;
      eventIds.add(item.event.eventId);
      return true;
    });
  return capQueue(queue);
}

function capQueue(queue: QueuedProductAnalyticsEvent[]) {
  if (queue.length <= PRODUCT_ANALYTICS_MAX_QUEUE) return queue;
  // The consent-gated installation event anchors every Desktop funnel. Keep its
  // one pending copy while dropping the oldest lower-value outcomes.
  const installation = [...queue].reverse().find(
    (item) => item.event.name === "desktop_installation_ready",
  );
  if (!installation) return queue.slice(-PRODUCT_ANALYTICS_MAX_QUEUE);
  const recent = queue
    .filter((item) => item.event.eventId !== installation.event.eventId)
    .slice(-(PRODUCT_ANALYTICS_MAX_QUEUE - 1));
  return [installation, ...recent];
}

export class ProductAnalyticsLocalStore {
  private consent: ProductAnalyticsConsent;
  private queue: QueuedProductAnalyticsEvent[];
  private snapshot: ProductAnalyticsLocalSnapshot;
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly storage: ProductAnalyticsStorage | null,
    private readonly now: () => number = Date.now,
  ) {
    this.consent = "pending";
    // Preserve a previous official build's bounded queue until the asynchronous
    // native consent source is known. Pending state still prevents every read,
    // capture, and send path from consuming it.
    this.queue = sanitizeQueue(readJson(storage, QUEUE_KEY), this.now());
    this.snapshot = {
      consent: this.consent,
      queueSize: this.queue.length,
    };
  }

  getSnapshot = () => this.snapshot;

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  reload() {
    const queue = this.consent === "granted"
      ? sanitizeQueue(readJson(this.storage, QUEUE_KEY), this.now())
      : [];
    if (this.consent !== "granted") this.clearPrivateState();
    this.queue = queue;
    this.publish();
  }

  applyConsent(consent: ProductAnalyticsConsent) {
    this.consent = consent;
    if (consent !== "granted") {
      this.queue = [];
      this.clearPrivateState();
    }
    this.publish();
  }

  installation() {
    if (this.consent !== "granted") return null;
    const value = readJson(this.storage, INSTALLATION_KEY);
    return normalizeInstallation(value);
  }

  ensureInstallation(randomUuid: () => string): InstallationRecord | null {
    const current = this.installation();
    if (current) return current;
    if (this.consent !== "granted") return null;
    const id = randomUuid().toLowerCase();
    if (!isProductAnalyticsUuid(id)) return null;
    const installation = {
      id,
      readyRecorded: false,
    };
    try {
      this.storage?.setItem(INSTALLATION_KEY, JSON.stringify(installation));
      if (!this.storage) return null;
    } catch {
      return null;
    }
    return installation;
  }

  markInstallationReadyRecorded(installationId: string) {
    if (this.consent !== "granted") return false;
    const current = this.installation();
    if (!current || current.id !== installationId) return false;
    if (current.readyRecorded) return true;
    try {
      if (!this.storage) return false;
      this.storage.setItem(INSTALLATION_KEY, JSON.stringify({
        ...current,
        readyRecorded: true,
      }));
      return this.installation()?.readyRecorded === true;
    } catch {
      return false;
    }
  }

  enqueue(item: QueuedProductAnalyticsEvent) {
    if (
      this.consent !== "granted" ||
      !isQueuedProductAnalyticsEvent(item)
    ) {
      return false;
    }
    let isolated: unknown;
    try {
      isolated = JSON.parse(JSON.stringify(item)) as unknown;
    } catch {
      return false;
    }
    if (!isQueuedProductAnalyticsEvent(isolated)) return false;
    const current = sanitizeQueue(this.queue, this.now());
    if (current.some((queued) => (
      queued.event.eventId === isolated.event.eventId
    ))) {
      if (current.length !== this.queue.length) {
        this.persistQueue(current);
        this.publish();
      }
      return true;
    }
    const next = capQueue([...current, isolated]);
    if (!this.persistQueue(next)) return false;
    this.publish();
    return true;
  }

  peekBatch() {
    const queue = sanitizeQueue(this.queue, this.now());
    if (queue.length !== this.queue.length) {
      this.persistQueue(queue);
      this.publish();
    }
    const first = queue[0];
    if (!first) return [];
    const batch: QueuedProductAnalyticsEvent[] = [];
    for (const item of queue) {
      if (batch.length >= PRODUCT_ANALYTICS_MAX_BATCH) break;
      if (!sameEnvelope(first, item)) break;
      batch.push(item);
    }
    return batch;
  }

  removeEvents(eventIds: readonly string[]) {
    if (eventIds.length === 0) return;
    const accepted = new Set(eventIds);
    const next = this.queue.filter((item) => !accepted.has(item.event.eventId));
    if (next.length === this.queue.length || !this.persistQueue(next)) return;
    this.publish();
  }

  discardQueue() {
    if (this.queue.length === 0) return;
    if (!this.persistQueue([])) this.queue = [];
    this.publish();
  }

  private persistQueue(next: QueuedProductAnalyticsEvent[]) {
    try {
      if (next.length === 0) this.storage?.removeItem(QUEUE_KEY);
      else this.storage?.setItem(QUEUE_KEY, JSON.stringify(next));
      if (!this.storage && next.length > 0) return false;
    } catch {
      return false;
    }
    this.queue = next;
    return true;
  }

  private clearPrivateState() {
    try {
      this.storage?.removeItem(QUEUE_KEY);
      this.storage?.removeItem(INSTALLATION_KEY);
    } catch {
      // The in-memory queue and identity remain cleared even if the host store fails.
    }
  }

  private publish() {
    const next = { consent: this.consent, queueSize: this.queue.length };
    if (
      next.consent === this.snapshot?.consent &&
      next.queueSize === this.snapshot?.queueSize
    ) {
      return;
    }
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

export function productAnalyticsInstallationReadyInput(
  installation: InstallationRecord,
): ProductAnalyticsEventInput {
  return {
    name: "desktop_installation_ready",
    dedupeId: installation.id,
    properties: {},
  };
}
