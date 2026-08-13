import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./tauriAdapter", () => ({
  listAgentAcpSessions: vi.fn(),
  onAgentAcpChanged: vi.fn(),
}));

import type { AcpSessionChanged, AcpSessionSummary } from "./domain";
import { listAgentAcpSessions, onAgentAcpChanged } from "./tauriAdapter";
import {
  AcpSessionStore,
  mergeAcpSessionSummaries,
} from "./sessionStore";

function session(
  id: string,
  updatedAt = "2026-08-13T00:00:00.000Z",
): AcpSessionSummary {
  return {
    id: id as AcpSessionSummary["id"],
    connectionId: "11111111-1111-4111-8111-111111111111" as AcpSessionSummary["connectionId"],
    provider: "codex",
    title: id,
    lifecycle: "running",
    acpSessionId: id,
    knowledgeGrantId: "grant",
    projectEnvironmentId: "environment",
    environmentRevision: 1,
    graphRevisionIds: [],
    environmentConnections: [],
    error: null,
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt,
  };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("ACP session store", () => {
  const list = vi.mocked(listAgentAcpSessions);
  const listen = vi.mocked(onAgentAcpChanged);
  let change: ((event: AcpSessionChanged) => void) | null;
  let unlisten: () => void;
  let unlistenCalls: number;

  beforeEach(() => {
    list.mockReset();
    listen.mockReset();
    change = null;
    unlistenCalls = 0;
    unlisten = () => {
      unlistenCalls += 1;
    };
    listen.mockImplementation(async (listener) => {
      change = listener;
      return unlisten;
    });
    list.mockResolvedValue([]);
  });

  it("adds an observed session without mutating the prior snapshot", () => {
    const prior: readonly AcpSessionSummary[] = [];
    const merged = mergeAcpSessionSummaries(prior, [session("one")]);
    expect(merged).toHaveLength(1);
    expect(prior).toHaveLength(0);
  });

  it("rejects an older event for the same exact session", () => {
    const current = session("one", "2026-08-13T00:00:02.000Z");
    const merged = mergeAcpSessionSummaries(
      [current],
      [session("one", "2026-08-13T00:00:01.000Z")],
    );
    expect(merged).toEqual([current]);
  });

  it("retains independent session identities", () => {
    expect(mergeAcpSessionSummaries([session("one")], [session("two")]))
      .toHaveLength(2);
  });

  it("registers one listener before reading the initial snapshot", async () => {
    const store = new AcpSessionStore();
    store.activate("workspace:a");
    await settle();
    expect(listen).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("does not duplicate the listener for the same scope generation", async () => {
    const store = new AcpSessionStore();
    store.activate("workspace:a");
    store.activate("workspace:a");
    await settle();
    expect(listen).toHaveBeenCalledTimes(1);
  });

  it("clears the old account sessions synchronously on a scope change", async () => {
    list.mockResolvedValueOnce([session("private")]);
    const store = new AcpSessionStore();
    store.activate("workspace:a");
    await settle();
    store.activate("workspace:b");
    expect(store.getSnapshot()).toMatchObject({
      scopeKey: "workspace:b",
      sessions: [],
      loading: true,
    });
    expect(unlistenCalls).toBe(1);
  });

  it("keeps a newer event that races ahead of the initial list response", async () => {
    let resolveList: (sessions: AcpSessionSummary[]) => void = () => {
      throw new Error("initial session list was not requested");
    };
    list.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveList = resolve;
      }),
    );
    const store = new AcpSessionStore();
    store.activate("workspace:a");
    await Promise.resolve();
    change?.({
      session: session("event", "2026-08-13T00:00:02.000Z"),
      event: null,
    });
    expect(store.getSnapshot()).toMatchObject({
      sessions: [expect.objectContaining({ id: "event" })],
      loading: true,
      error: null,
    });
    resolveList([session("event", "2026-08-13T00:00:01.000Z")]);
    await settle();
    expect(store.getSnapshot().sessions).toEqual([
      session("event", "2026-08-13T00:00:02.000Z"),
    ]);
  });

  it("surfaces an inventory failure without retaining a prior scope and can retry", async () => {
    list.mockRejectedValueOnce(new Error("denied"));
    const store = new AcpSessionStore();
    store.activate("workspace:a");
    await settle();
    expect(store.getSnapshot()).toMatchObject({
      scopeKey: "workspace:a",
      sessions: [],
      loading: false,
    });
    expect(store.getSnapshot().error).toEqual(new Error("denied"));
    change?.({
      session: session("partial-event"),
      event: null,
    });
    expect(store.getSnapshot()).toMatchObject({
      sessions: [expect.objectContaining({ id: "partial-event" })],
      error: new Error("denied"),
    });
    list.mockResolvedValueOnce([session("recovered")]);
    store.activate("workspace:a");
    await settle();
    expect(store.getSnapshot()).toMatchObject({
      scopeKey: "workspace:a",
      sessions: [expect.objectContaining({ id: "recovered" })],
      loading: false,
      error: null,
    });
    expect(listen).toHaveBeenCalledTimes(2);
  });
});
