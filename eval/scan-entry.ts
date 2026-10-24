// Browser bundle entry for eval capture. esbuild packs this into one IIFE that
// eval/capture.mjs injects into a Puppeteer page. It scans the page the same way the
// extension does (PageAgent.scan, then mergeScans), top frame only.
import type { PageSnapshot } from "@justask/shared";
import { PageAgent } from "../packages/page-agent/src/agent";
import { mergeScans } from "../packages/core/src/merge";

declare global {
  interface Window {
    __justaskScan: (context: string[], snapshotId: string) => PageSnapshot;
  }
}

/** Scan the top document once and return the merged, numbered snapshot. Never reads field values. */
window.__justaskScan = (context, snapshotId) => {
  const agent = new PageAgent({ frameId: 0, isTop: true, send: () => {} });
  try {
    const scan = agent.scan(context);
    return mergeScans([scan], snapshotId).snapshot;
  } finally {
    agent.destroy();
  }
};
