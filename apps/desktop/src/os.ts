// Thin wrappers over Tauri plugins (notification, opener) and the window API. Each one fails
// quietly, and outside Tauri (plain `vite dev`) falls back to the nearest browser equivalent.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { openUrl } from "@tauri-apps/plugin-opener";

export function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** OS notification, e.g. "Sam sent you a task". */
export async function notify(title: string, body: string): Promise<void> {
  if (!inTauri()) return;
  try {
    let ok = await isPermissionGranted();
    if (!ok) ok = (await requestPermission()) === "granted";
    if (ok) sendNotification({ title, body });
  } catch (e) {
    console.warn("[os] notification failed", e);
  }
}

/** Open an http(s) URL in the user's default browser. */
export async function openExternal(url: string): Promise<void> {
  try {
    if (inTauri()) await openUrl(url);
    else window.open(url, "_blank", "noopener");
  } catch (e) {
    console.warn("[os] open failed", e);
  }
}

/** Bring the Ask window back from the tray. */
export async function showWindow(): Promise<void> {
  if (!inTauri()) return;
  try {
    const w = getCurrentWindow();
    await w.unminimize();
    await w.show();
    await w.setFocus();
  } catch (e) {
    console.warn("[os] show window failed", e);
  }
}
