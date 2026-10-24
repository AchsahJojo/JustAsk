import type { FrameScan, PageSnapshot } from "@justask/shared";

export interface TargetRef {
  frameId: number;
  localId: number;
}

type El = PageSnapshot["elements"][number];

/**
 * Second ranking pass across frames, from what each element reports (each frame already ranked
 * its own). Mirrors the scanner's weights, so a busy parent page can't crowd out the one button
 * that lives in a child frame (a payment or sign-in iframe).
 */
export function crossFrameScore(el: El): number {
  let s = 0;
  if (el.inModal) s += 5;
  if (el.inViewport) s += 3;
  if (el.region === "main" || el.region === "modal") s += 2;
  if (el.field) s += 1;
  if (el.big || el.color) s += 1;
  if (el.region === "nav" || el.region === "footer" || el.region === "aside") s -= 1;
  if (el.disabled) s -= 1;
  return s;
}

/** Merge per-frame scans into one numbered list. Claude only sees plain numbers. */
export function mergeScans(scans: FrameScan[], snapshotId: string, cap = 150): { snapshot: PageSnapshot; map: Map<number, TargetRef> } {
  const sorted = [...scans].sort((a, b) => Number(b.isTop) - Number(a.isTop) || a.frameId - b.frameId);
  const top = sorted.find((s) => s.isTop) ?? sorted[0];
  const map = new Map<number, TargetRef>();
  const elements: PageSnapshot["elements"] = [];
  let omitted = 0;
  const regions = new Set<string>();
  // Reading order: top frame first, then child frames, each in its own document order.
  const all = sorted.flatMap((s, fi) => s.snapshot.elements.map((el, i) => ({ s, el, order: fi * 100_000 + i })));
  let keep = all;
  if (all.length > cap) {
    keep = [...all].sort((a, b) => crossFrameScore(b.el) - crossFrameScore(a.el) || a.order - b.order).slice(0, cap);
    const kept = new Set(keep);
    for (const x of all) {
      if (kept.has(x)) continue;
      omitted++;
      regions.add(x.el.region);
    }
    keep.sort((a, b) => a.order - b.order);
  }
  for (const s of sorted) {
    omitted += s.snapshot.omitted.count;
    s.snapshot.omitted.regions.forEach((r) => regions.add(r));
  }
  for (const { s, el } of keep) {
    const n = elements.length + 1;
    elements.push({ ...el, n });
    map.set(n, { frameId: s.frameId, localId: el.n });
  }
  const frameText = sorted
    .filter((s) => !s.isTop)
    .map((s) => s.snapshot.pageText)
    .filter(Boolean)
    .join("\n");
  const pageText = [top?.snapshot.pageText ?? "", frameText].filter(Boolean).join("\n").slice(0, 1800);
  return {
    snapshot: {
      snapshotId,
      url: top?.snapshot.url ?? "",
      title: top?.snapshot.title ?? "",
      heading: top?.snapshot.heading ?? "",
      pageText,
      elements,
      omitted: { count: omitted, regions: [...regions] },
      surface: top?.snapshot.surface ?? "web",
      ...(top?.snapshot.app ? { app: top.snapshot.app } : {}),
    },
    map,
  };
}
