// Pure helpers for synced account data. Everything from Convex is read defensively:
// the backend is written in parallel, so unknown or malformed fields are ignored.
import { Recipe } from "@justask/shared";
import type { Settings } from "./config";

/** The preferences that live on the user's account and follow them to every install. */
export type SyncedPrefs = Pick<Settings, "voice" | "rate" | "consent" | "showMeInstead">;

export const RATE_MIN = 0.5;
export const RATE_MAX = 1.5;

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * Merge `prefs:get` output over the local cache. Returns only the fields that are valid
 * and differ from `local`, so the result can go straight into `saveSettings`.
 */
export function mergePrefs(local: SyncedPrefs, remote: unknown): Partial<SyncedPrefs> {
  if (!isObj(remote)) return {};
  const out: Partial<SyncedPrefs> = {};
  if ((remote.voice === "browser" || remote.voice === "cartesia") && remote.voice !== local.voice) out.voice = remote.voice;
  if (typeof remote.rate === "number" && Number.isFinite(remote.rate)) {
    const rate = Math.min(RATE_MAX, Math.max(RATE_MIN, remote.rate));
    if (rate !== local.rate) out.rate = rate;
  }
  if (isObj(remote.consent)) {
    const c = remote.consent;
    const consent = {
      notifyOnComplete: typeof c.notifyOnComplete === "boolean" ? c.notifyOnComplete : local.consent.notifyOnComplete,
      notifyOnStuck: typeof c.notifyOnStuck === "boolean" ? c.notifyOnStuck : local.consent.notifyOnStuck,
    };
    if (consent.notifyOnComplete !== local.consent.notifyOnComplete || consent.notifyOnStuck !== local.consent.notifyOnStuck) out.consent = consent;
  }
  return out;
}

/** Turn a Convex error into a short, kind sentence for the user. */
export function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  if (/too many tries/i.test(msg)) return "Too many tries. Please wait a few minutes, then try again.";
  if (/could not find public function|server error.*not found|function.*not.*exist/i.test(msg)) return "This part of JustAsk isn't ready yet. Please try again later.";
  if (/failed to fetch|network|fetch failed|ECONNREFUSED/i.test(msg)) return "JustAsk can't reach the internet right now. Please try again in a moment.";
  return "Something went wrong. Please try again, or ask your helper.";
}

/** One row of the devices list, normalised from whatever `devices:list` returns. */
export interface DeviceRow {
  id: string;
  label: string;
  kind: string;
  lastSeenAt: number | null;
  current: boolean;
}

/** Normalise `devices:list` output. Rows without an id are dropped. */
export function parseDevices(x: unknown): DeviceRow[] {
  const rows = Array.isArray(x) ? x : isObj(x) && Array.isArray(x.devices) ? x.devices : [];
  return rows.flatMap((r: unknown): DeviceRow[] => {
    if (!isObj(r)) return [];
    const id = typeof r._id === "string" ? r._id : typeof r.id === "string" ? r.id : typeof r.deviceId === "string" ? r.deviceId : null;
    if (!id) return [];
    const kind = typeof r.kind === "string" ? r.kind : "extension";
    const label = typeof r.label === "string" && r.label.trim() ? r.label : "A browser";
    const seen = typeof r.lastSeenAt === "number" ? r.lastSeenAt : null;
    const current = r.current === true || r.isCurrent === true || r.thisDevice === true || r.isThisDevice === true;
    return [{ id, label, kind, lastSeenAt: seen, current }];
  });
}

/** Pull a string `code` out of a code-minting reply (`{code}` or a bare string). */
export function parseCode(x: unknown): string | null {
  const code = typeof x === "string" ? x : isObj(x) && typeof x.code === "string" ? x.code : isObj(x) && typeof x.code === "number" ? String(x.code) : null;
  return code && /^\d{6}$/.test(code.trim()) ? code.trim() : null;
}

/** "123456" -> "123 456", easier to read aloud. */
export function spacedCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

/** "Used today" / "Used yesterday" / "Used 5 days ago" for the devices list. */
export function seenAgo(ts: number, now = Date.now()): string {
  const days = Math.floor((now - ts) / 86_400_000);
  if (days <= 0) return "Used today";
  if (days === 1) return "Used yesterday";
  return `Used ${days} days ago`;
}
