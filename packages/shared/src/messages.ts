import type { Expect } from "./step";
import type { PageSnapshot } from "./snapshot";

/** Frame-local snapshot: the controller merges these into one numbered PageSnapshot. */
export interface FrameScan {
  frameId: number;
  isTop: boolean;
  /** Same shape as snapshot elements, numbered locally from 1. */
  snapshot: Omit<PageSnapshot, "snapshotId">;
  /** Visible child iframes (top frame only reports this usefully). */
  visibleFrames: number;
}

export interface HighlightSpec {
  localId: number;
  expect: Expect;
  option: string | null;
  label: string;
}

/** Panel/background -> content script. */
export type ToContent =
  | { type: "ja:ping" }
  | { type: "ja:scan"; context: string[] }
  | { type: "ja:highlight"; spec: HighlightSpec }
  | { type: "ja:clear" }
  | { type: "ja:pulse" }
  | { type: "ja:banner"; text: string }
  | { type: "ja:wait-change"; timeoutMs: number };

/** Content script -> panel/background. */
export type FromContent =
  | { type: "ja:step-done"; how: "click" | "typed" | "chose" | "hovered" | "file" }
  | { type: "ja:wrong"; what: "click" | "typing" | "choice" }
  | { type: "ja:lost" }
  | { type: "ja:page-changed"; reason: "mutation" | "navigation" }
  | { type: "ja:banner-start" }
  | { type: "ja:clicked" };

export interface ScanReply {
  ok: boolean;
  scan?: FrameScan;
}
