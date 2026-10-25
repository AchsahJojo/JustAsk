import type { FrameScan, PageSnapshot } from "@justask/shared";

export interface TargetRef {
  frameId: number;
  localId: number;
}

/** Merge per-frame scans into one numbered list. Claude only sees plain numbers. */
export function mergeScans(scans: FrameScan[], snapshotId: string, cap = 150): { snapshot: PageSnapshot; map: Map<number, TargetRef> } {
  const sorted = [...scans].sort((a, b) => Number(b.isTop) - Number(a.isTop) || a.frameId - b.frameId);
  const top = sorted.find((s) => s.isTop) ?? sorted[0];
  const map = new Map<number, TargetRef>();
  const elements: PageSnapshot["elements"] = [];
  let omitted = 0;
  const regions = new Set<string>();
  for (const s of sorted) {
    omitted += s.snapshot.omitted.count;
    s.snapshot.omitted.regions.forEach((r) => regions.add(r));
    for (const el of s.snapshot.elements) {
      if (elements.length >= cap) {
        omitted++;
        regions.add(el.region);
        continue;
      }
      const n = elements.length + 1;
      elements.push({ ...el, n });
      map.set(n, { frameId: s.frameId, localId: el.n });
    }
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
    },
    map,
  };
}
