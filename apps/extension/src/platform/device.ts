// Device identity for account linking. Feature detection first (userAgentData brands),
// the UA string only as a fallback. No wxt imports so it stays unit-testable.

export type BrowserPlatform = "chrome" | "edge" | "brave" | "opera" | "other";
export type OsName = "Windows" | "Mac" | "ChromeOS" | "Linux" | "computer";

/** What an install tells Convex about itself. Matches the Wave 0 `device` argument. */
export interface DeviceInfo {
  kind: "extension";
  platform: BrowserPlatform;
  label: string;
}

export interface BrowserHints {
  /** `navigator.userAgentData.brands[].brand`, when available. */
  brands?: string[];
  /** `navigator.userAgent`. */
  ua?: string;
  /** `navigator.brave` exists (Brave hides itself from the UA string). */
  isBrave?: boolean;
}

/** Pick the browser family from brand hints, falling back to the UA string. */
export function detectBrowser(h: BrowserHints): BrowserPlatform {
  if (h.isBrave) return "brave";
  const brands = (h.brands ?? []).map((b) => b.toLowerCase());
  if (brands.some((b) => b.includes("edge"))) return "edge";
  if (brands.some((b) => b.includes("opera"))) return "opera";
  if (brands.some((b) => b.includes("brave"))) return "brave";
  if (brands.some((b) => b === "google chrome")) return "chrome";
  const ua = h.ua ?? "";
  if (/\bEdg(e|A|iOS)?\//.test(ua)) return "edge";
  if (/\bOPR\/|\bOpera\b/.test(ua)) return "opera";
  if (/\bChrome\//.test(ua) && !brands.length) return "chrome";
  if (brands.some((b) => b === "chromium")) return "chrome";
  return "other";
}

/** Operating system name from `userAgentData.platform` or the UA string. */
export function detectOs(h: { platform?: string; ua?: string }): OsName {
  const p = (h.platform ?? "").toLowerCase();
  const ua = h.ua ?? "";
  if (p.startsWith("win") || /Windows/.test(ua)) return "Windows";
  if (p.startsWith("mac") || /Macintosh|Mac OS X/.test(ua)) return "Mac";
  if (p.includes("chrome os") || p === "chromeos" || /CrOS/.test(ua)) return "ChromeOS";
  if (p.includes("linux") || /Linux/.test(ua)) return "Linux";
  return "computer";
}

const BROWSER_NAMES: Record<BrowserPlatform, string> = {
  chrome: "Chrome",
  edge: "Edge",
  brave: "Brave",
  opera: "Opera",
  other: "Browser",
};

/** A label she can recognise in the devices list, e.g. "Chrome on Windows". */
export function deviceLabel(browser: BrowserPlatform, os: OsName): string {
  return os === "computer" ? `${BROWSER_NAMES[browser]} on this computer` : `${BROWSER_NAMES[browser]} on ${os}`;
}

/** Read this browser's hints and describe the install. Only call from extension pages. */
export function currentDevice(): DeviceInfo {
  const nav = (typeof navigator !== "undefined" ? navigator : {}) as {
    userAgent?: string;
    userAgentData?: { brands?: Array<{ brand: string }>; platform?: string };
    brave?: unknown;
  };
  const ua = nav.userAgent ?? "";
  const platform = detectBrowser({ brands: nav.userAgentData?.brands?.map((b) => b.brand), ua, isBrave: !!nav.brave });
  const os = detectOs({ platform: nav.userAgentData?.platform, ua });
  return { kind: "extension", platform, label: deviceLabel(platform, os) };
}
