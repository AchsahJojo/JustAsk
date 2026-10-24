// Small persistent settings for the desktop app, via tauri-plugin-store (a JSON file in the app
// data dir). Hackathon trade-off: the device token is a bearer credential and belongs in the OS
// keychain later (docs/ARCHITECTURE.md §8). Outside Tauri (plain `vite dev`) it uses localStorage.
import { load, type Store } from "@tauri-apps/plugin-store";

export interface Saved {
  deviceToken: string | null;
  displayName: string;
  machineId: string | null;
}

const DEFAULTS: Saved = { deviceToken: null, displayName: "", machineId: null };
const FILE = "justask.json";

type Backing = { get(k: string): Promise<unknown>; set(k: string, v: unknown): Promise<void>; save(): Promise<void> };

let backing: Promise<Backing> | null = null;

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function localBacking(): Backing {
  const key = (k: string) => `justask:${k}`;
  return {
    async get(k) {
      try {
        const raw = localStorage.getItem(key(k));
        return raw === null ? undefined : JSON.parse(raw);
      } catch {
        return undefined;
      }
    },
    async set(k, v) {
      try {
        localStorage.setItem(key(k), JSON.stringify(v));
      } catch {
        /* storage blocked */
      }
    },
    async save() {},
  };
}

function open(): Promise<Backing> {
  if (!backing) {
    backing = inTauri()
      ? load(FILE, { defaults: {}, autoSave: true })
          .then((s: Store): Backing => s)
          .catch(() => localBacking())
      : Promise.resolve(localBacking());
  }
  return backing;
}

/** Read all saved settings, with defaults. */
export async function getSaved(): Promise<Saved> {
  const s = await open();
  const out = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS) as (keyof Saved)[]) {
    const v = await s.get(k);
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** Merge and persist. */
export async function save(patch: Partial<Saved>): Promise<Saved> {
  const s = await open();
  for (const [k, v] of Object.entries(patch)) await s.set(k, v);
  await s.save();
  return getSaved();
}
