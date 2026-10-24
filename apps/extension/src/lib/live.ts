// Live task updates for the side panel over a ConvexClient WebSocket (ARCHITECTURE.md §8).
// The MV3 service worker can't hold a socket, so it keeps polling with ConvexHttpClient.
import { ConvexClient } from "convex/browser";
import type { TaskList } from "./backend";

export interface LiveAccountUpdates {
  onTasks: (tasks: TaskList) => void;
  onPrefs: (prefs: unknown) => void;
}

/**
 * Subscribe to her task list (open and recently done) and preferences over one ConvexClient socket. Calls `onFail`
 * once if the client can't be created or either subscription errors (for example, the function
 * doesn't exist yet), so the caller can fall back to polling. Both queries must deliver an initial
 * result before `firstResultMs`; otherwise a blocked network or wrong URL also counts as failure.
 * The returned function unsubscribes and closes the socket.
 */
export function watchAccount(
  convexUrl: string,
  token: string,
  updates: LiveAccountUpdates,
  onFail: (e: unknown) => void,
  firstResultMs = 10_000,
): () => void {
  let client: ConvexClient | null = null;
  let closed = false;
  const initialResults = new Set<string>();
  const subscriptions: Array<() => void> = [];
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    for (const unsubscribe of subscriptions) unsubscribe();
    void client?.close().catch(() => {});
  };
  const fail = (e: unknown) => {
    if (closed) return;
    close();
    onFail(e);
  };
  const timer = setTimeout(() => fail(new Error("no initial live account data")), firstResultMs);
  const received = (name: string) => {
    initialResults.add(name);
    if (initialResults.size === 2) clearTimeout(timer);
  };
  try {
    client = new ConvexClient(convexUrl, { unsavedChangesWarning: false, skipConvexDeploymentUrlCheck: true });
    subscriptions.push(client.onUpdate(
      "tasks:listForDevice" as never,
      { token } as never,
      (list: unknown) => {
        if (closed) return;
        received("tasks");
        updates.onTasks(asTaskList(list));
      },
      (e: Error) => fail(e),
    ));
    subscriptions.push(client.onUpdate(
      "prefs:get" as never,
      { token } as never,
      (prefs: unknown) => {
        if (closed) return;
        received("prefs");
        updates.onPrefs(prefs);
      },
      (e: Error) => fail(e),
    ));
  } catch (e) {
    fail(e);
  }
  return close;
}

/** A `tasks:listForDevice` reply, or an empty list for anything malformed. */
export function asTaskList(x: unknown): TaskList {
  const o = (typeof x === "object" && x !== null ? x : {}) as { open?: unknown; done?: unknown };
  return { open: Array.isArray(o.open) ? (o.open as TaskList["open"]) : [], done: Array.isArray(o.done) ? (o.done as TaskList["done"]) : [] };
}
