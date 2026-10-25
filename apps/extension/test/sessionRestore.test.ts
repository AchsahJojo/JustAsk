import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: {} as Record<string, unknown>,
  local: {} as Record<string, unknown>,
  logged: [] as Array<{ sessionId: string; type: string }>,
  deps: null as null | {
    store: { save: (view: unknown, extra: { history: string[]; recipe: unknown }) => void };
    events: { log: (type: string) => void };
  },
  restored: null as null | { view: unknown; history: string[]; recipe: unknown },
}));

vi.mock("wxt/browser", () => {
  const listener = { addListener() {}, removeListener() {} };
  return { browser: {
    storage: {
      session: {
        set: async (o: Record<string, unknown>) => void Object.assign(mocks.session, o),
        get: async (k: string) => (k in mocks.session ? { [k]: mocks.session[k] } : {}),
        remove: async (k: string) => void delete mocks.session[k],
      },
      local: {
        set: async (o: Record<string, unknown>) => void Object.assign(mocks.local, o),
        remove: async (k: string) => void delete mocks.local[k],
      },
      onChanged: listener,
    },
    runtime: { onMessage: listener },
    tabs: { onCreated: listener, onActivated: listener, onRemoved: listener, onUpdated: listener, query: async () => [{ id: 7 }] },
    webNavigation: { onCreatedNavigationTarget: listener },
  } };
});

vi.mock("@justask/core", () => ({
  lines: {},
  SessionController: class {
    state = { phase: "idle" };
    constructor(deps: typeof mocks.deps) {
      mocks.deps = deps;
    }
    subscribe() {
      return () => {};
    }
    async start() {}
    restore(view: unknown, history: string[], recipe: unknown) {
      mocks.restored = { view, history, recipe };
    }
  },
}));

vi.mock("../src/lib/config", () => ({
  getSettings: async () => ({ rate: 1, deviceToken: "t", plannerUrl: "http://x" }),
}));

vi.mock("../src/lib/backend", () => ({
  backend: {
    startSession: async () => "session-1",
    setTaskStatus: async () => {},
    logEvent: async (sessionId: string, type: string) => void mocks.logged.push({ sessionId, type }),
  },
}));

import { SessionHost } from "../src/lib/session";

afterEach(() => {
  for (const k of Object.keys(mocks.session)) delete mocks.session[k];
  for (const k of Object.keys(mocks.local)) delete mocks.local[k];
  mocks.logged.length = 0;
  mocks.restored = null;
});

const recipe = { title: "Pay the water bill", startUrl: "https://example.test/", steps: [] };

describe("SessionHost save and restore", () => {
  it("saves the session id and recipe, and a reloaded panel keeps logging to the same session", async () => {
    const first = new SessionHost({ pinnedTabId: 7 });
    await first.start("pay my bill", { recipe: recipe as never, taskId: "task-1" });
    const view = { phase: "guiding", request: "pay my bill", taskId: "task-1", stepNo: 2 };
    mocks.deps!.store.save(view, { history: ["did a thing"], recipe });

    expect(mocks.session.session).toMatchObject({ sessionId: "session-1", recipe, tabId: 7, history: ["did a thing"] });
    expect(mocks.local.resume).toEqual({ request: "pay my bill", taskId: "task-1", stepNo: 2, recipe });

    // The panel reloads: a new host rehydrates from storage.session.
    const second = new SessionHost({ pinnedTabId: 7 });
    await second.init();
    expect(mocks.restored).toMatchObject({ view, recipe });
    mocks.deps!.events.log("step_done");
    expect(mocks.logged).toEqual([{ sessionId: "session-1", type: "step_done" }]);
  });
});
