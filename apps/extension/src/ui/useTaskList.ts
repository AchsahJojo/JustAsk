import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { browser } from "wxt/browser";
import { backend, isNotPaired, type TaskList } from "../lib/backend";
import { getSettings } from "../lib/config";
import { watchAccount } from "../lib/live";
import { applyPrefs, pullPrefs } from "../lib/prefsSync";

const POLL_MS = 15_000;
const EMPTY: TaskList = { open: [], done: [] };

/**
 * The user's task list (open tasks stay until the user finishes or removes them, plus recently done) and
 * settings, live over one ConvexClient subscription. Falls back to polling every 15 s if either
 * subscription fails. Restarts when the account or server changes. When offline, the last list stays.
 */
export function useTaskList(): [TaskList, Dispatch<SetStateAction<TaskList>>] {
  const [tasks, setTasks] = useState<TaskList>(EMPTY);
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
    setTasks(EMPTY);
    if (!account.url || !account.token) return;
    let iv: ReturnType<typeof setInterval> | null = null;
    const poll = async () => {
      const [list] = await Promise.all([backend.taskList(), pullPrefs()]);
      if (list) setTasks(list);
    };
    const stop = watchAccount(account.url, account.token, {
      onTasks: (list) => {
        backend.setNotPaired(false);
        setTasks(list);
      },
      onPrefs: (prefs) => void applyPrefs(prefs),
    }, (e) => {
      if (isNotPaired(e)) backend.setNotPaired(true);
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

/**
 * True when the server said this browser's token no longer works (revoked or missing). Pass the
 * current token to check it now (devices:me); otherwise this follows what other calls found.
 */
export function useNotPaired(checkToken?: string | null): boolean {
  const [notPaired, setNotPaired] = useState(backend.notPaired);
  useEffect(() => {
    const off = backend.onNotPaired(setNotPaired);
    setNotPaired(backend.notPaired);
    if (checkToken) void backend.me();
    return off;
  }, [checkToken]);
  return notPaired;
}
