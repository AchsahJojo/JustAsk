// Dev-only capture of the current plan request for the eval harness (ARCHITECTURE.md §12).
// The file is downloaded locally and never sent anywhere. No device token goes in it.
import type { PageSnapshot, Recipe } from "@justask/shared";

export interface Capture {
  capturedAt: string;
  deviceToken: null;
  sessionId: null;
  request: string;
  history: string[];
  recipe: Recipe | null;
  snapshot: PageSnapshot;
  retryNote: null;
}

/** Build a PlanRequest-shaped capture. Returns null when there is no snapshot yet. */
export function buildCapture(opts: { request: string; recipe: Recipe | null; snapshot: PageSnapshot | null; history: string[]; now?: Date }): Capture | null {
  if (!opts.snapshot) return null;
  return {
    capturedAt: (opts.now ?? new Date()).toISOString(),
    deviceToken: null,
    sessionId: null,
    request: opts.request,
    history: opts.history.slice(-30),
    recipe: opts.recipe,
    snapshot: opts.snapshot,
    retryNote: null,
  };
}

/** A safe file name like `justask-snapshot-2026-10-24T12-00-00.json`. */
export function captureFileName(c: Capture): string {
  return `justask-snapshot-${c.capturedAt.replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z")}.json`;
}
