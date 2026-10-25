import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settings: { convexUrl: "https://demo.convex.cloud", deviceToken: "old-token" as string | null },
  saved: [] as Array<Record<string, unknown>>,
  mutation: (async () => null) as (name: string, args: Record<string, unknown>) => Promise<unknown>,
  query: (async () => null) as (name: string, args: Record<string, unknown>) => Promise<unknown>,
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    mutation(name: string, args: Record<string, unknown>) {
      return mocks.mutation(name, args);
    }
    query(name: string, args: Record<string, unknown>) {
      return mocks.query(name, args);
    }
  },
}));

vi.mock("../src/lib/config", () => ({
  getSettings: async () => ({ ...mocks.settings }),
  saveSettings: async (patch: Record<string, unknown>) => {
    mocks.saved.push(patch);
    Object.assign(mocks.settings, patch);
    return { ...mocks.settings };
  },
}));

import { Backend, isNotPaired } from "../src/lib/backend";

afterEach(() => {
  mocks.settings.deviceToken = "old-token";
  mocks.saved.length = 0;
  mocks.mutation = async () => null;
  mocks.query = async () => null;
});

describe("joinWithCode", () => {
  it("saves the new token when the server returns a different one", async () => {
    mocks.mutation = async () => ({ token: "new-token", displayName: "Sam" });
    const r = await new Backend().joinWithCode("123456");
    expect(r).toEqual({ displayName: "Sam" });
    expect(mocks.saved).toEqual([{ deviceToken: "new-token" }]);
  });

  it("doesn't save when the token is the same", async () => {
    mocks.mutation = async () => ({ token: "old-token", displayName: "Sam" });
    await new Backend().joinWithCode("123456");
    expect(mocks.saved).toEqual([]);
  });
});

describe("isNotPaired", () => {
  it("recognizes ConvexError data and older messages", () => {
    expect(isNotPaired({ data: "not paired" })).toBe(true);
    expect(isNotPaired(new Error("[Request ID: x] Server Error Uncaught Error: not paired"))).toBe(true);
    expect(isNotPaired(new Error("network down"))).toBe(false);
    expect(isNotPaired(null)).toBe(false);
    expect(isNotPaired("not paired")).toBe(false);
  });
});

describe("not-paired state", () => {
  it("taskList sets it on a not-paired error and clears it on success", async () => {
    const b = new Backend();
    const seen: boolean[] = [];
    b.onNotPaired((v) => seen.push(v));
    mocks.query = async () => {
      throw Object.assign(new Error("not paired"), { data: "not paired" });
    };
    expect(await b.taskList()).toBeNull();
    expect(b.notPaired).toBe(true);

    mocks.query = async () => ({ open: [], done: [] });
    expect(await b.taskList()).toEqual({ open: [], done: [] });
    expect(b.notPaired).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  it("an ordinary failure doesn't set it", async () => {
    const b = new Backend();
    mocks.query = async () => {
      throw new Error("offline");
    };
    expect(await b.pendingTasks()).toEqual([]);
    expect(await b.me()).toBeNull();
    expect(b.notPaired).toBe(false);
  });

  it("a successful join clears it", async () => {
    const b = new Backend();
    b.setNotPaired(true);
    mocks.mutation = async () => ({ token: "new-token", displayName: "" });
    await b.joinWithCode("123456");
    expect(b.notPaired).toBe(false);
  });
});
