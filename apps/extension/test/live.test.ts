import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ clients: [] as Array<any> }));

vi.mock("convex/browser", () => ({
  ConvexClient: class {
    subscriptions: Array<{ name: string; onUpdate: (value: unknown) => void; onError: (error: Error) => void }> = [];
    unsubscriptions = 0;
    closed = false;

    constructor() {
      mocks.clients.push(this);
    }

    onUpdate(name: string, _args: unknown, onUpdate: (value: unknown) => void, onError: (error: Error) => void) {
      this.subscriptions.push({ name, onUpdate, onError });
      return () => this.unsubscriptions++;
    }

    async close() {
      this.closed = true;
    }
  },
}));

import { watchAccount } from "../src/lib/live";

afterEach(() => {
  vi.useRealTimers();
  mocks.clients.length = 0;
});

describe("watchAccount", () => {
  it("subscribes to tasks and prefs and closes after both initial results", () => {
    const onTasks = vi.fn();
    const onPrefs = vi.fn();
    const onFail = vi.fn();
    const stop = watchAccount("https://demo.convex.cloud", "token", { onTasks, onPrefs }, onFail);
    const client = mocks.clients[0];

    expect(client.subscriptions.map((s: { name: string }) => s.name)).toEqual(["tasks:pendingForDevice", "prefs:get"]);
    client.subscriptions[0].onUpdate([{ id: "task-1" }]);
    expect(onTasks).toHaveBeenCalledWith([{ id: "task-1" }]);
    client.subscriptions[1].onUpdate({ showMeInstead: true });
    expect(onPrefs).toHaveBeenCalledWith({ showMeInstead: true });

    stop();
    expect(client.unsubscriptions).toBe(2);
    expect(client.closed).toBe(true);
    expect(onFail).not.toHaveBeenCalled();
  });

  it("falls back when the socket does not deliver both initial results", () => {
    vi.useFakeTimers();
    const onFail = vi.fn();
    watchAccount("https://demo.convex.cloud", "token", { onTasks: vi.fn(), onPrefs: vi.fn() }, onFail, 100);

    vi.advanceTimersByTime(100);
    expect(onFail).toHaveBeenCalledOnce();
    expect(mocks.clients[0].closed).toBe(true);
  });

  it("falls back if either subscription errors", () => {
    const onFail = vi.fn();
    watchAccount("https://demo.convex.cloud", "token", { onTasks: vi.fn(), onPrefs: vi.fn() }, onFail);
    const client = mocks.clients[0];

    client.subscriptions[1].onError(new Error("query failed"));
    expect(onFail).toHaveBeenCalledWith(expect.objectContaining({ message: "query failed" }));
    expect(client.closed).toBe(true);
  });
});
