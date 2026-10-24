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
  it("has no way to act for her: no act or openBrowser", () => {
    const b = new NativeBridge() as unknown as Record<string, unknown>;
    expect(b.act).toBeUndefined();
    expect(b.openBrowser).toBeUndefined();
    expect("act" in b).toBe(false);
    expect("openBrowser" in b).toBe(false);
  });

  it("never invokes act or open_browser", async () => {
    invoke.mockResolvedValue(undefined);
    const b = new NativeBridge();
    await b.scan([]);
    await b.highlight(ref, { localId: 12, expect: "click", option: null, label: "Click here" });
    await b.clear();
    await b.pulse(ref);
    await b.waitForChange(10);
    const names = invoke.mock.calls.map((c) => c[0]);
    expect(names).not.toContain("act");
    expect(names).not.toContain("open_browser");
  });

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

  it("forwards the exact payloads the Rust layer emits (type plus fields)", async () => {
    const b = new NativeBridge();
    const got: FromContent[] = [];
    await b.connect((e) => got.push(e));
    b.watch(true);
    // Shapes built by event_payload() in src-tauri/src/native/windows.rs.
    handlers.get("ja:step-done")!({ payload: { type: "ja:step-done", how: "click" } });
    handlers.get("ja:wrong")!({ payload: { type: "ja:wrong", what: "click" } });
    handlers.get("ja:page-changed")!({ payload: { type: "ja:page-changed", reason: "navigation" } });
    handlers.get("ja:lost")!({ payload: { type: "ja:lost" } });
    expect(got.map((e) => e.type)).toEqual(["ja:step-done", "ja:wrong", "ja:page-changed", "ja:lost"]);
    // A payload without type (the old Rust shape) is dropped.
    handlers.get("ja:step-done")!({ payload: { how: "click" } });
    expect(got).toHaveLength(4);
  });
});
