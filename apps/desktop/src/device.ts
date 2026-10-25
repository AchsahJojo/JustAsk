// The `device` argument for accounts:createSelf and devices:redeemCode (docs/refined-plan-2.md).

export type DesktopPlatform = "windows" | "macos";

export interface DeviceInfo {
  kind: "desktop";
  platform: DesktopPlatform;
  label: string;
  machineId: string;
}

/** Pick the platform from the WebView user agent. Anything that isn't a Mac is treated as Windows. */
export function detectPlatform(userAgent: string): DesktopPlatform {
  return /Mac OS X|Macintosh/i.test(userAgent) ? "macos" : "windows";
}

/** Build the device description sent when this install joins the user's account. */
export function deviceInfo(platform: DesktopPlatform, machineId: string): DeviceInfo {
  return {
    kind: "desktop",
    platform,
    label: platform === "macos" ? "JustAsk on Mac" : "JustAsk on Windows",
    machineId,
  };
}

/** A random id for this machine, generated once and stored (handoffs match devices by it). */
export function newMachineId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
