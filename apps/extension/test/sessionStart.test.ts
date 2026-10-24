import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ events: [] as string[] }));

vi.mock("@justask/core", () => ({
  lines: {},
  SessionController: class {
    state = { phase: "idle" };
    subscribe() {
      return () => {};
    }
    async start() {
      mocks.events.push("controller.start");
    }
  },
}));

vi.mock("../src/lib/backend", () => ({
  backend: {
    startSession: async () => {
      mocks.events.push("session.start");
      return "session-id";
    },
    setTaskStatus: async (_taskId: string, status: string) => {
      mocks.events.push(`task.${status}.start`);
      await Promise.resolve();
      mocks.events.push(`task.${status}.done`);
    },
    logEvent: async () => {},
  },
}));

import { SessionHost } from "../src/lib/session";

afterEach(() => {
  mocks.events.length = 0;
});

describe("SessionHost.start", () => {
  it("awaits the active status write before starting the controller", async () => {
    const host = new SessionHost({ pinnedTabId: 42 });

    await host.start("open my task", { taskId: "task-1" });

    expect(mocks.events).toEqual(["session.start", "task.active.start", "task.active.done", "controller.start"]);
  });

  it("does not write task status for a regular request", async () => {
    const host = new SessionHost({ pinnedTabId: 42 });

    await host.start("help me find a page");

    expect(mocks.events).toEqual(["session.start", "controller.start"]);
  });
});
