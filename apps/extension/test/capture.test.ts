import { describe, expect, it } from "vitest";
import type { PageSnapshot } from "@justask/shared";
import { buildCapture, captureFileName } from "../src/lib/capture";

const SNAP = { snapshotId: "s1", url: "https://example.com/", title: "Example", elements: [] } as unknown as PageSnapshot;

describe("buildCapture", () => {
  it("builds a PlanRequest-shaped capture with no token or session", () => {
    const c = buildCapture({ request: "find a water bottle", recipe: null, snapshot: SNAP, history: ["a", "b"], now: new Date("2026-10-24T12:00:00.123Z") });
    expect(c).toEqual({
      capturedAt: "2026-10-24T12:00:00.123Z",
      deviceToken: null,
      sessionId: null,
      request: "find a water bottle",
      history: ["a", "b"],
      recipe: null,
      snapshot: SNAP,
      retryNote: null,
    });
    expect(captureFileName(c!)).toBe("justask-snapshot-2026-10-24T12-00-00Z.json");
  });

  it("keeps only the last 30 history lines", () => {
    const history = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    expect(buildCapture({ request: "x", recipe: null, snapshot: SNAP, history })!.history).toHaveLength(30);
  });

  it("returns null before the first scan", () => {
    expect(buildCapture({ request: "x", recipe: null, snapshot: null, history: [] })).toBeNull();
  });
});
