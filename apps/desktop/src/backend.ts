// Convex client for the desktop app. A long-lived ConvexClient (WebSocket) so tasks and handoffs
// are live queries (docs/ARCHITECTURE.md §8). Function names are the Wave 0 contract strings
// (docs/refined-plan-2.md); every device call takes the device token. No API keys here.
import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type { EventType, Recipe } from "@justask/shared";
import type { DeviceInfo } from "./device";

export interface PendingTask {
  id: string;
  title: string;
  spokenPrompt: string;
  recipe: Recipe | null;
  from: string;
}

export interface PendingHandoff {
  id: string;
  toKind: string | null;
  request: string;
  taskId: string | null;
  recipe: Recipe | null;
}

export interface ClaimedHandoff {
  request: string;
  taskId: string | null;
  recipe: Recipe | null;
}

const q = (name: string) => makeFunctionReference<"query">(name);
const m = (name: string) => makeFunctionReference<"mutation">(name);
const a = (name: string) => makeFunctionReference<"action">(name);

/** Drop undefined/null optional fields: Convex validators want them absent. */
function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as Partial<T>;
}

/** Read a handoff row defensively: the id may come as `_id`, `id` or `handoffId`. */
export function normalizeHandoff(row: unknown): PendingHandoff | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const id = r._id ?? r.id ?? r.handoffId;
  if (typeof id !== "string" || !id) return null;
  return {
    id,
    toKind: typeof r.toKind === "string" ? r.toKind : null,
    request: typeof r.request === "string" ? r.request : "",
    taskId: typeof r.taskId === "string" ? r.taskId : null,
    recipe: (r.recipe as Recipe | null | undefined) ?? null,
  };
}

/** voice:cartesiaToken returns `{token, expiresAt}`; accept a bare string too. */
export function readToken(res: unknown): string | null {
  if (typeof res === "string") return res || null;
  if (res && typeof res === "object" && typeof (res as { token?: unknown }).token === "string") return (res as { token: string }).token || null;
  return null;
}

export class DesktopBackend {
  readonly client: ConvexClient | null;

  constructor(url: string | undefined) {
    let c: ConvexClient | null = null;
    if (url) {
      try {
        c = new ConvexClient(url);
      } catch (e) {
        console.warn("[backend] bad VITE_CONVEX_URL", e);
      }
    }
    this.client = c;
  }

  get configured(): boolean {
    return !!this.client;
  }

  private need(): ConvexClient {
    if (!this.client) throw new Error("JustAsk isn't set up to connect yet.");
    return this.client;
  }

  // ───── accounts ─────

  /** First install: create her account. */
  async createSelf(displayName: string, device: DeviceInfo): Promise<{ token: string }> {
    return this.need().mutation(m("accounts:createSelf"), { displayName, device });
  }

  /** Join her account with a 6-digit code. Null means the code didn't work. Throws on lockout ("Too many tries"). */
  async redeemCode(code: string, device: DeviceInfo): Promise<{ token: string; displayName: string } | null> {
    return this.need().mutation(m("devices:redeemCode"), { code: code.trim(), device });
  }

  async createLinkCode(token: string): Promise<{ code: string; expiresAt: number }> {
    return this.need().mutation(m("devices:createLinkCode"), { token });
  }

  async heartbeat(token: string): Promise<void> {
    await this.client?.mutation(m("devices:heartbeat"), { token }).catch(() => {});
  }

  async getPrefs(token: string): Promise<{ showMeInstead?: boolean } | null> {
    try {
      return (await this.client?.query(q("prefs:get"), { token })) ?? null;
    } catch {
      return null;
    }
  }

  // ───── live queries ─────

  onTasks(token: string, cb: (tasks: PendingTask[]) => void): () => void {
    if (!this.client) return () => {};
    return this.client.onUpdate(
      q("tasks:pendingForDevice"),
      { token },
      (rows: PendingTask[] | null) => cb(rows ?? []),
      (e) => console.warn("[backend] tasks", e.message),
    );
  }

  onHandoffs(token: string, cb: (rows: PendingHandoff[]) => void): () => void {
    if (!this.client) return () => {};
    return this.client.onUpdate(
      q("handoffs:pendingForDevice"),
      { token },
      (rows: unknown[] | null) => cb((rows ?? []).map(normalizeHandoff).filter((h): h is PendingHandoff => !!h)),
      (e) => console.warn("[backend] handoffs", e.message),
    );
  }

  // ───── handoffs ─────

  async claimHandoff(token: string, handoffId: string): Promise<ClaimedHandoff | null> {
    try {
      return (await this.need().mutation(m("handoffs:claim"), { token, handoffId })) ?? null;
    } catch {
      return null;
    }
  }

  async createHandoff(token: string, h: { toKind: "extension" | "desktop"; request: string; taskId?: string | null; recipe?: Recipe | null }): Promise<string> {
    const res = await this.need().mutation(m("handoffs:create"), { token, ...compact(h) });
    const id = (res as { handoffId?: string })?.handoffId ?? (typeof res === "string" ? res : null);
    if (!id) throw new Error("no handoff id");
    return id;
  }

  // ───── voice ─────

  async cartesiaToken(token: string): Promise<string | null> {
    try {
      return readToken(await this.need().action(a("voice:cartesiaToken"), { token }));
    } catch {
      return null;
    }
  }

  // ───── sessions and tasks ─────

  async startSession(token: string, request: string, taskId: string | null): Promise<string | null> {
    try {
      return await this.need().mutation(m("sessions:start"), { token, request, ...(taskId ? { taskId } : {}) });
    } catch {
      return null;
    }
  }

  async logEvent(token: string, sessionId: string, type: EventType, latencyMs?: number) {
    await this.client?.mutation(m("sessions:logEvent"), { token, sessionId, type, ...(latencyMs !== undefined ? { latencyMs } : {}) }).catch(() => {});
  }

  async setTaskStatus(token: string, taskId: string, status: "active" | "done" | "dismissed" | "pending") {
    await this.client?.mutation(m("tasks:setStatus"), { token, taskId, status }).catch(() => {});
  }
}
