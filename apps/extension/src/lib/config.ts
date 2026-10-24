import { browser } from "wxt/browser";

export interface Settings {
  plannerUrl: string;
  convexUrl: string;
  deviceToken: string | null;
  displayName: string;
  setupDone: boolean;
  consent: { notifyOnComplete: boolean; notifyOnStuck: boolean };
  /** "Type it for me" on search boxes. Null until she (or her helper) chooses. */
  assistTyping: boolean | null;
  voice: "browser" | "cartesia";
  rate: number;
}

export const DEFAULTS: Settings = {
  plannerUrl: import.meta.env.VITE_PLANNER_URL || "http://localhost:8787",
  convexUrl: import.meta.env.VITE_CONVEX_URL || "",
  deviceToken: null,
  displayName: "",
  setupDone: false,
  consent: { notifyOnComplete: false, notifyOnStuck: false },
  assistTyping: null,
  voice: "browser",
  rate: 0.9,
};

export async function getSettings(): Promise<Settings> {
  const got = (await browser.storage.local.get("settings")) as { settings?: Partial<Settings> };
  return { ...DEFAULTS, ...(got.settings ?? {}) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await browser.storage.local.set({ settings: next });
  return next;
}
