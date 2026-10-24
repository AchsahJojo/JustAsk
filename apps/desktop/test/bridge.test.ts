import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FrameScan, FromContent } from "@justask/shared";

const invoke = vi.fn();
const handlers = new Map<string, (ev: { payload: unknown }) => void>();
const unlisten = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, fn: (ev: { payload: unknown }) => void) => {
    handlers.set(name, fn);
    return unlisten;
  },
}));

const { NativeBridge } = await import("../src/bridge");

const nativeScan: FrameScan = {
  frameId: 7,
  isTop: false,
  visibleFrames: 0,
  snapshot: {
    url: "",
    title: "Settings",
    heading: "Display",
    pageText: "Display",
    elements: [],
    omitted: { count: 0, regions: [] },
    surface: "native",
  } as unknown as FrameScan["snapshot"],
};

const ref = { frameId: 0, localId: 12 };

beforeEach(() => {
  invoke.mockReset();
  handlers.clear();
  unlisten.mockReset();
});

describe("NativeBridge", () => {
  it("scan returns the foreground scan as frame 0, top frame", async () => {
    invoke.mockResolvedValueOnce(nativeScan);
    const scans = await new NativeBridge().scan(["help me"]);
    expect(invoke).toHaveBeenCalledWith("scan_foreground");
    expect(scans).toHaveLength(1);
    expect(scans[0].frameId).toBe(0);
    expect(scans[0].isTop).toBe(true);
    expect(scans[0].snapshot.title).toBe("Settings");
  });

  it("scan returns [] when the native side errors", async () => {
    invoke.mockRejectedValueOnce("native scan not implemented yet");
    expect(await new NativeBridge().scan([])).toEqual([]);
  });

  it("highlight passes localId and label", async () => {
    invoke.mockResolvedValueOnce(true);
    const ok = await new NativeBridge().highlight(ref, { localId: 12, expect: "click", option: null, label: "Click here" });
    expect(ok).toBe(true);
    expect(invoke).toHaveBeenCalledWith("highlight", { localId: 12, label: "Click here" });
  });

  it("highlight is false on error", async () => {
    invoke.mockRejectedValueOnce(new Error("x"));
    expect(await new NativeBridge().highlight(ref, { localId: 12, expect: "click", option: null, label: "Click here" })).toBe(false);
  });

  it("act sends the spec with the ref's localId", async () => {
    invoke.mockResolvedValueOnce({ ok: true });
    const res = await new NativeBridge().act(ref, { localId: 99, expect: "type", text: "large", option: null });
    expect(res).toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledWith("act", { spec: { localId: 12, expect: "type", text: "large", option: null } });
  });

  it("act is {ok:false} on error or a bad reply", async () => {
    invoke.mockRejectedValueOnce(new Error("secure field"));
    expect(await new NativeBridge().act(ref, { localId: 12, expect: "click", text: null, option: null })).toEqual({ ok: false });
    invoke.mockResolvedValueOnce(null);
    expect(await new NativeBridge().act(ref, { localId: 12, expect: "click", text: null, option: null })).toEqual({ ok: false });
  });

  it("clear, pulse and waitForChange map to their commands", async () => {
    const b = new NativeBridge();
    invoke.mockResolvedValue(undefined);
    await b.clear();
    await b.pulse(ref);
    expect(invoke).toHaveBeenCalledWith("clear");
    expect(invoke).toHaveBeenCalledWith("pulse");
    invoke.mockResolvedValueOnce(true);
    expect(await b.waitForChange(4000)).toBe(true);
    expect(invoke).toHaveBeenLastCalledWith("wait_for_change", { timeoutMs: 4000 });
    invoke.mockRejectedValueOnce(new Error("x"));
    expect(await b.waitForChange(700)).toBe(false);
  });

  it("clear and pulse swallow errors", async () => {
    invoke.mockRejectedValue(new Error("x"));
    const b = new NativeBridge();
    await expect(b.clear()).resolves.toBeUndefined();
    await expect(b.pulse(ref)).resolves.toBeUndefined();
  });

  it("connect forwards native events as frame 0; page-changed only while watching", async () => {
    const b = new NativeBridge();
    const got: Array<[FromContent, number]> = [];
    const off = await b.connect((e, f) => got.push([e, f]));
    expect([...handlers.keys()].sort()).toEqual(["ja:lost", "ja:page-changed", "ja:step-done", "ja:wrong"]);

    handlers.get("ja:step-done")!({ payload: { type: "ja:step-done", how: "click" } });
    handlers.get("ja:page-changed")!({ payload: { type: "ja:page-changed", reason: "mutation" } });
    expect(got).toEqual([[{ type: "ja:step-done", how: "click" }, 0]]);

    b.watch(true);
    handlers.get("ja:page-changed")!({ payload: { type: "ja:page-changed", reason: "mutation" } });
    expect(got).toHaveLength(2);
    expect(got[1]).toEqual([{ type: "ja:page-changed", reason: "mutation" }, 0]);

    b.watch(false);
    handlers.get("ja:page-changed")!({ payload: { type: "ja:page-changed", reason: "navigation" } });
    expect(got).toHaveLength(2);

    off();
    expect(unlisten).toHaveBeenCalledTimes(4);
  });
});
