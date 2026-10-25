import { describe, expect, it } from "vitest";
import { snapshotSignature } from "../src/signature";
import type { PageSnapshot, SnapshotElement } from "@justask/shared";

const box = (field: SnapshotElement["field"] = { kind: "search", hasValue: false, valid: true }): SnapshotElement => ({
  n: 1, role: "search box", text: "", label: "Search", nearby: null, color: null, big: false, disabled: false, inModal: false, inViewport: true, region: "main", field,
});

describe("snapshotSignature", () => {
  const snap = (els: SnapshotElement[]): PageSnapshot => ({ snapshotId: "x", url: "", title: "", heading: "", pageText: "", elements: els, omitted: { count: 0, regions: [] } });
  it("changes with the elements, not the snapshot id", () => {
    const a = snapshotSignature(snap([box()]));
    expect(snapshotSignature({ ...snap([box()]), snapshotId: "y", pageText: "other" })).toBe(a);
    expect(snapshotSignature(snap([box({ kind: "search", hasValue: true, valid: true })]))).not.toBe(a);
    expect(snapshotSignature(snap([box(), { ...box(), n: 2, text: "Go" }]))).not.toBe(a);
  });
});
