import { ConvexHttpClient } from "convex/browser";
import type { EventType, Recipe } from "@justask/shared";
import { getSettings } from "./config";
import type { DeviceInfo } from "../platform/device";
import { parseCode, parseDevices, parseHandoff, type DeviceRow, type Handoff, type SyncedPrefs } from "./prefs";

export interface PendingTask {
  id: string;
  title: string;
  spokenPrompt: string;
  recipe: Recipe | null;
  from: string;
}

const NOT_CONNECTED = "JustAsk isn't connected to an account on this browser yet.";

/** True when Convex rejected an argument we sent (an older backend without that field). */
const isArgError = (e: unknown) => e instanceof Error && /validator|extra field|unexpected field|ArgumentValidationError/i.test(e.message);

/**
 * Thin Convex client for the device side. Every call takes the device token; no keys.
 * Functions are called by string name (refined-plan-2, Wave 0 table), so the extension
 * doesn't depend on generated types. Account-screen calls throw (the UI shows a kind
 * message); background calls swallow errors.
 */
export class Backend {
  private client: ConvexHttpClient | null = null;
  private url = "";

  private async c(): Promise<{ client: ConvexHttpClient; token: string } | null> {
    const s = await getSettings();
    if (!s.convexUrl || !s.deviceToken) return null;
    if (!this.client || this.url !== s.convexUrl) {
      this.client = new ConvexHttpClient(s.convexUrl, { skipConvexDeploymentUrlCheck: true });
      this.url = s.convexUrl;
    }
    return { client: this.client, token: s.deviceToken };
  }

  private async must() {
    const c = await this.c();
    if (!c) throw new Error(NOT_CONNECTED);
    return c;
  }

  private mutation<T>(client: ConvexHttpClient, name: string, args: Record<string, unknown>): Promise<T> {
    return client.mutation(name as never, args as never) as Promise<T>;
  }

  private query<T>(client: ConvexHttpClient, name: string, args: Record<string, unknown>): Promise<T> {
    return client.query(name as never, args as never) as Promise<T>;
  }

  /** "I'm new": create her account with this install as its first device. */
  async createSelf(convexUrl: string, displayName: string, device: DeviceInfo): Promise<{ token: string }> {
    const client = new ConvexHttpClient(convexUrl, { skipConvexDeploymentUrlCheck: true });
    const r = await this.mutation<{ token?: unknown } | null>(client, "accounts:createSelf", { displayName, device });
    if (!r || typeof r.token !== "string") throw new Error("createSelf returned no token");
    return { token: r.token };
  }

  /** Redeem a 6-digit code. Resolves null for a wrong or expired code; throws on lockout or network trouble. */
  async redeem(convexUrl: string, code: string, device?: DeviceInfo): Promise<{ token: string; displayName: string } | null> {
    const client = new ConvexHttpClient(convexUrl, { skipConvexDeploymentUrlCheck: true });
    let r: { token?: unknown; displayName?: unknown } | null;
    try {
      r = await this.mutation(client, "devices:redeemCode", device ? { code, device } : { code });
    } catch (e) {
      if (!device || !isArgError(e)) throw e;
      r = await this.mutation(client, "devices:redeemCode", { code });
    }
    if (!r || typeof r.token !== "string") return null;
    return { token: r.token, displayName: typeof r.displayName === "string" ? r.displayName : "" };
  }

  /** Whose account a code links to, without using it up. Null if unknown or not supported yet. */
  async peekCode(convexUrl: string, code: string): Promise<string | null> {
    try {
      const client = new ConvexHttpClient(convexUrl, { skipConvexDeploymentUrlCheck: true });
      const r = await this.query<{ displayName?: unknown } | null>(client, "devices:peekCode", { code });
      return r && typeof r.displayName === "string" && r.displayName.trim() ? r.displayName.trim() : null;
    } catch {
      return null;
    }
  }

  /** "Add another device": a single-use 6-digit code that lasts 15 minutes. */
  async createLinkCode(): Promise<{ code: string; expiresAt: number | null }> {
    const c = await this.must();
    const r = await this.mutation<unknown>(c.client, "devices:createLinkCode", { token: c.token });
    const code = parseCode(r);
    if (!code) throw new Error("createLinkCode returned no code");
    const expiresAt = (r as { expiresAt?: unknown }).expiresAt;
    return { code, expiresAt: typeof expiresAt === "number" ? expiresAt : null };
  }

  /** Every install linked to her account. */
  async listDevices(): Promise<DeviceRow[]> {
    const c = await this.must();
    return parseDevices(await this.query<unknown>(c.client, "devices:list", { token: c.token }));
  }

  /** Unlink one install. Its token stops working at once. */
  async revokeDevice(deviceId: string): Promise<void> {
    const c = await this.must();
    await this.mutation(c.client, "devices:revoke", { token: c.token, deviceId });
  }

  /** "Share with my helper": a code a caregiver redeems in the web app. */
  async createHelperCode(): Promise<string> {
    const c = await this.must();
    const code = parseCode(await this.mutation<unknown>(c.client, "careLinks:createHelperCode", { token: c.token }));
    if (!code) throw new Error("createHelperCode returned no code");
    return code;
  }

  /** Mark this install as recently used. Never throws. */
  async heartbeat(): Promise<void> {
    const c = await this.c();
    if (!c) return;
    await this.mutation(c.client, "devices:heartbeat", { token: c.token }).catch(() => {});
  }

  /** Her synced preferences, unvalidated (see `mergePrefs`). Null when unavailable. */
  async getPrefs(): Promise<unknown> {
    const c = await this.c();
    if (!c) return null;
    try {
      return await this.query<unknown>(c.client, "prefs:get", { token: c.token });
    } catch {
      return null;
    }
  }

  /** Write synced preferences. Resolves false when the server didn't take them. */
  async setPrefs(patch: Partial<SyncedPrefs>): Promise<boolean> {
    const c = await this.c();
    if (!c) return false;
    try {
      await this.mutation(c.client, "prefs:set", { token: c.token, ...patch });
      return true;
    } catch {
      return false;
    }
  }

  /** Claim a handoff from the desktop app. Null when it isn't ours, was already claimed, or failed. */
  async claimHandoff(handoffId: string): Promise<Handoff | null> {
    const c = await this.c();
    if (!c) return null;
    try {
      return parseHandoff(await this.mutation<unknown>(c.client, "handoffs:claim", { token: c.token, handoffId }));
    } catch {
      return null;
    }
  }

  async pendingTasks(): Promise<PendingTask[]> {
    const c = await this.c();
    if (!c) return [];
    try {
      return await this.query<PendingTask[]>(c.client, "tasks:pendingForDevice", { token: c.token });
    } catch {
      return [];
    }
  }

  async setTaskStatus(taskId: string, status: "active" | "done" | "dismissed" | "pending") {
    const c = await this.c();
    if (!c) return;
    await this.mutation(c.client, "tasks:setStatus", { token: c.token, taskId, status }).catch(() => {});
  }

  async startSession(request: string, taskId: string | null): Promise<string | null> {
    const c = await this.c();
    if (!c) return null;
    try {
      return await this.mutation<string>(c.client, "sessions:start", { token: c.token, request, ...(taskId ? { taskId } : {}) });
    } catch {
      return null;
    }
  }

  async logEvent(sessionId: string, type: EventType, latencyMs?: number) {
    const c = await this.c();
    if (!c) return;
    await this.mutation(c.client, "sessions:logEvent", { token: c.token, sessionId, type, ...(latencyMs !== undefined ? { latencyMs } : {}) }).catch(() => {});
  }

  /** Legacy consent write, kept as a fallback for backends without `prefs:set`. */
  async setConsent(consent: { notifyOnComplete: boolean; notifyOnStuck: boolean }) {
    const c = await this.c();
    if (!c) return;
    await this.mutation(c.client, "devices:setConsent", { token: c.token, ...consent }).catch(() => {});
  }
}

export const backend = new Backend();
