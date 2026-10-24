import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { browser } from "wxt/browser";
import { backend, type PendingTask } from "../lib/backend";
import { getSettings } from "../lib/config";
import { watchAccount } from "../lib/live";
import { applyPrefs, pullPrefs } from "../lib/prefsSync";

const POLL_MS = 15_000;

/**
 * Her pending tasks and settings, live over one ConvexClient subscription. Falls back to
 * polling every 15 s if either subscription fails. Restarts when the account or server changes.
 */
export function usePendingTasks(): [PendingTask[], Dispatch<SetStateAction<PendingTask[]>>] {
  const [tasks, setTasks] = useState<PendingTask[]>([]);
  const [account, setAccount] = useState<{ url: string; token: string | null } | null>(null);

  useEffect(() => {
    const read = () => void getSettings().then((s) => setAccount((a) => (a && a.url === s.convexUrl && a.token === s.deviceToken ? a : { url: s.convexUrl, token: s.deviceToken })));
    read();
    const onChanged = (changes: Record<string, unknown>) => {
      if (changes.settings) read();
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => browser.storage.onChanged.removeListener(onChanged);
  }, []);

  useEffect(() => {
    if (!account) return;
    if (!account.url || !account.token) {
      setTasks([]);
      return;
    }
    setTasks([]);
    let iv: ReturnType<typeof setInterval> | null = null;
    const poll = async () => {
      const [tasks] = await Promise.all([backend.pendingTasks(), pullPrefs()]);
      setTasks(tasks);
    };
    const stop = watchAccount(account.url, account.token, {
      onTasks: setTasks,
      onPrefs: (prefs) => void applyPrefs(prefs),
    }, () => {
      void poll();
      iv = setInterval(poll, POLL_MS);
    });
    return () => {
      stop();
      if (iv) clearInterval(iv);
    };
  }, [account]);

  return [tasks, setTasks];
}
