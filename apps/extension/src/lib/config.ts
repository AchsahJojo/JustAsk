import { browser } from "wxt/browser";

export interface Settings {
  plannerUrl: string;
  convexUrl: string;
  deviceToken: string | null;
  displayName: string;
  setupDone: boolean;
  consent: { notifyOnComplete: boolean; notifyOnStuck: boolean };
  voice: "browser" | "cartesia";
  rate: number;
  /** Synced. When on, JustAsk shows the user where to click instead of doing it. */
  showMeInstead: boolean;
}

export const DEFAULTS: Settings = {
  plannerUrl: import.meta.env.VITE_PLANNER_URL || "http://localhost:8787",
  convexUrl: import.meta.env.VITE_CONVEX_URL || "",
  deviceToken: null,
  displayName: "",
  setupDone: false,
  consent: { notifyOnComplete: false, notifyOnStuck: false },
  voice: "cartesia",
  rate: 0.9,
  showMeInstead: true,
};

/** Server addresses from the build. They win over saved ones, so a rebuild always takes effect. */
const BUILT = {
  plannerUrl: import.meta.env.VITE_PLANNER_URL || "",
  convexUrl: import.meta.env.VITE_CONVEX_URL || "",
};

/** Read settings from storage.local, filled in with defaults. A saved address counts only when the build has none. */
export async function getSettings(): Promise<Settings> {
  const got = (await browser.storage.local.get("settings")) as { settings?: Partial<Settings> };
  const s = { ...DEFAULTS, ...(got.settings ?? {}) };
  if (BUILT.plannerUrl) s.plannerUrl = BUILT.plannerUrl;
  if (BUILT.convexUrl) s.convexUrl = BUILT.convexUrl;
  // Without an account there's no way to opt in to JustAsk clicking: always guide.
  if (!s.deviceToken) s.showMeInstead = true;
  return s;
}

/** Merge a patch into the stored settings and return the result. */
export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await browser.storage.local.set({ settings: next });
  return next;
}
