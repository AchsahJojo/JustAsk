// The fixed command surface between the desktop UI (TypeScript) and the Rust native layer
// (src-tauri/src/native). Frozen after Wave 0 (docs/refined-plan-2.md): change both sides together.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ActResult, ActSpec, FrameScan, FromContent } from "@justask/shared";

/** Scan the foreground window's accessibility tree into a snapshot (surface "native"). */
export const scanForeground = () => invoke<FrameScan>("scan_foreground");
/** Draw the overlay ring around element `localId` from the last scan. False if it can't be found. */
export const highlight = (localId: number, label: string) => invoke<boolean>("highlight", { localId, label });
/** Perform one action through accessibility patterns. Secure fields are refused. */
export const act = (spec: ActSpec) => invoke<ActResult>("act", { spec });
export const clear = () => invoke<void>("clear");
export const pulse = () => invoke<void>("pulse");
/** Resolves true once the foreground window changed and settled, false on timeout. */
export const waitForChange = (timeoutMs: number) => invoke<boolean>("wait_for_change", { timeoutMs });

/** Events from the native layer, same shapes as the extension's content-script events. */
export const NATIVE_EVENTS = ["ja:step-done", "ja:wrong", "ja:lost", "ja:page-changed"] as const;
export function onNativeEvent(fn: (e: FromContent) => void): Promise<UnlistenFn[]> {
  return Promise.all(NATIVE_EVENTS.map((name) => listen<FromContent>(name, (ev) => fn(ev.payload))));
}
