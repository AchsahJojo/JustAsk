// Preference sync: storage.local is the cache, the user's account (prefs:get / prefs:set) is the source.
import { backend } from "./backend";
import { getSettings, saveSettings, type Settings } from "./config";
import { mergePrefs, type SyncedPrefs } from "./prefs";

/** Fetch the user's synced prefs and update the local cache. Returns the (possibly unchanged) settings. */
export async function pullPrefs(): Promise<Settings> {
  return applyPrefs(await backend.getPrefs());
}

/** Apply a live `prefs:get` result to the local cache without another HTTP request. */
export async function applyPrefs(remote: unknown): Promise<Settings> {
  const s = await getSettings();
  if (!s.deviceToken) return s;
  const patch = mergePrefs(s, remote);
  return Object.keys(patch).length ? saveSettings(patch) : s;
}

/** Save prefs locally first (so the UI never waits), then write them to the user's account. */
export async function pushPrefs(patch: Partial<SyncedPrefs>): Promise<Settings> {
  const next = await saveSettings(patch);
  if (next.deviceToken) {
    void backend.setPrefs(patch).then((ok) => {
      // Older backends only know devices:setConsent.
      if (!ok && patch.consent) void backend.setConsent(patch.consent);
    });
  }
  return next;
}
