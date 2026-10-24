// PageBridge for the desktop app: the controller's page operations go to the Rust native layer
// through the frozen command surface in ./native.ts. No OS calls here, only Tauri invoke + events.
import type { PageBridge, TargetRef } from "@justask/core";
import type { ActResult, ActSpec, FrameScan, FromContent, HighlightSpec } from "@justask/shared";
import * as native from "./native";

/** The native layer scans one window, so it is always frame 0 and the top frame. */
export const NATIVE_FRAME_ID = 0;

export class NativeBridge implements PageBridge {
  private watching = false;

  /** Scan the foreground window. An empty array means "can't see it" (the controller pauses). */
  async scan(_context: string[]): Promise<FrameScan[]> {
    try {
      const scan = await native.scanForeground();
      if (!scan || !scan.snapshot) return [];
      return [{ ...scan, frameId: NATIVE_FRAME_ID, isTop: true }];
    } catch (e) {
      // The native error says why (no window, UI Automation failed). It holds no page content.
      console.warn("[bridge] scan failed:", e);
      return [];
    }
  }

  async highlight(ref: TargetRef, spec: HighlightSpec): Promise<boolean> {
    try {
      return await native.highlight(ref.localId, spec.label);
    } catch {
      return false;
    }
  }

  async clear(): Promise<void> {
    await native.clear().catch(() => {});
  }

  async pulse(_ref: TargetRef): Promise<void> {
    await native.pulse().catch(() => {});
  }

  async waitForChange(timeoutMs: number): Promise<boolean> {
    try {
      return await native.waitForChange(timeoutMs);
    } catch {
      return false;
    }
  }

  /** Perform one action. Any failure is `{ok: false}`, so the step falls back to guiding her. */
  async act(ref: TargetRef, spec: ActSpec): Promise<ActResult> {
    try {
      const res = await native.act({ ...spec, localId: ref.localId });
      return { ok: res?.ok === true };
    } catch {
      return { ok: false };
    }
  }

  /** Open her default browser at its start page (no URL). False on any failure. */
  async openBrowser(): Promise<boolean> {
    try {
      return (await native.openBrowser()) === true;
    } catch (e) {
      console.warn("[bridge] open browser failed:", e);
      return false;
    }
  }

  /** While on, `ja:page-changed` events reach the controller (the waiting phase). */
  watch(on: boolean): void {
    this.watching = on;
  }

  get isWatching(): boolean {
    return this.watching;
  }

  /**
   * Forward native events to `fn` (the host passes them to `controller.onContent(e, 0)`).
   * `ja:page-changed` is only forwarded while `watch(true)` is on. Returns a disposer.
   * If the native side never emits, this is a no-op.
   */
  async connect(fn: (e: FromContent, frameId: number) => void): Promise<() => void> {
    let offs: Array<() => void> = [];
    try {
      offs = await native.onNativeEvent((e) => {
        if (!e || typeof e !== "object" || !("type" in e)) return;
        if (e.type === "ja:page-changed" && !this.watching) return;
        fn(e, NATIVE_FRAME_ID);
      });
    } catch {
      offs = [];
    }
    return () => offs.forEach((off) => off());
  }
}
