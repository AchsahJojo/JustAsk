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
  voice: "browser",
  rate: 0.9,
  showMeInstead: false,
};

/** Read settings from storage.local, filled in with defaults. */
export async function getSettings(): Promise<Settings> {
  const got = (await browser.storage.local.get("settings")) as { settings?: Partial<Settings> };
  return { ...DEFAULTS, ...(got.settings ?? {}) };
}

/** Merge a patch into the stored settings and return the result. */
export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await browser.storage.local.set({ settings: next });
  return next;
}
