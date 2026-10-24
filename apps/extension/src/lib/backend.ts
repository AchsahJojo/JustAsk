import { ConvexHttpClient } from "convex/browser";
import type { EventType, Recipe } from "@justask/shared";
import { getSettings, saveSettings, type Settings } from "./config";

export interface Helper {
  id: string;
  name: string;
}

export type RedeemResult = { ok: true; token: string; displayName: string } | { ok: false; error: string };

export interface PendingTask {
  id: string;
  title: string;
  spokenPrompt: string;
  recipe: Recipe | null;
  from: string;
}

/** Thin Convex client for the device side. Every call takes the device token; no keys. */
export class Backend {
  private client: ConvexHttpClient | null = null;
  private url = "";

  private async c(): Promise<{ client: ConvexHttpClient; token: string } | null> {
    const s = await getSettings();
    if (!s.convexUrl || !s.deviceToken) return null;
    if (!this.client || this.url !== s.convexUrl) {
      this.client = new ConvexHttpClient(s.convexUrl);
      this.url = s.convexUrl;
    }
    return { client: this.client, token: s.deviceToken };
  }

  private registering: Promise<void> | null = null;

  /**
   * Make sure this computer has its own account. JustAsk works without a caregiver, so a fresh
   * install signs itself up silently (no password, no email). Safe to call often.
   */
  async ensureDevice(): Promise<void> {
    const s = await getSettings();
    if (!s.convexUrl || s.deviceToken) return;
    this.registering ??= (async () => {
      try {
        const client = new ConvexHttpClient(s.convexUrl);
        const { token } = await client.mutation("devices:registerStandalone" as never, { displayName: s.displayName } as never) as { token: string };
        const now = await getSettings();
        if (!now.deviceToken) await saveSettings({ deviceToken: token });
      } catch {
        /* offline or rate limited: try again next time */
      } finally {
        this.registering = null;
      }
    })();
    return this.registering;
  }

  /** Type a caregiver's code. With an existing account, the caregiver joins it; nothing is lost. */
  async redeem(convexUrl: string, code: string): Promise<RedeemResult> {
    const s = await getSettings();
    const client = new ConvexHttpClient(convexUrl);
    return client.mutation("devices:redeemCode" as never, { code, ...(s.deviceToken ? { token: s.deviceToken } : {}) } as never);
  }

  async me(): Promise<{ displayName: string; consent: Settings["consent"]; helpers: Helper[] } | null> {
    const c = await this.c();
    if (!c) return null;
    try {
      return await c.client.query("devices:me" as never, { token: c.token } as never);
    } catch {
      return null;
    }
  }

  async setDisplayName(displayName: string) {
    const c = await this.c();
    if (!c) return;
    await c.client.mutation("devices:setDisplayName" as never, { token: c.token, displayName } as never).catch(() => {});
  }

  /** Stop working with one helper, or all of them. This computer keeps its own account. */
  async leaveHelpers(caregiverId?: string) {
    const c = await this.c();
    if (!c) return;
    await c.client.mutation("devices:leaveHelpers" as never, { token: c.token, ...(caregiverId ? { caregiverId } : {}) } as never);
  }

  async pendingTasks(): Promise<PendingTask[]> {
    const c = await this.c();
    if (!c) return [];
    try {
      return await c.client.query("tasks:pendingForDevice" as never, { token: c.token } as never);
    } catch {
      return [];
    }
  }

  async setTaskStatus(taskId: string, status: "active" | "done" | "dismissed" | "pending") {
    const c = await this.c();
    if (!c) return;
    await c.client.mutation("tasks:setStatus" as never, { token: c.token, taskId, status } as never).catch(() => {});
  }

  async startSession(request: string, taskId: string | null): Promise<string | null> {
    const c = await this.c();
    if (!c) return null;
    try {
      return await c.client.mutation("sessions:start" as never, { token: c.token, request, ...(taskId ? { taskId } : {}) } as never);
    } catch {
      return null;
    }
  }

  async logEvent(sessionId: string, type: EventType, latencyMs?: number) {
    const c = await this.c();
    if (!c) return;
    await c.client.mutation("sessions:logEvent" as never, { token: c.token, sessionId, type, ...(latencyMs !== undefined ? { latencyMs } : {}) } as never).catch(() => {});
  }

  async setConsent(consent: { notifyOnComplete: boolean; notifyOnStuck: boolean }) {
    const c = await this.c();
    if (!c) return;
    await c.client.mutation("devices:setConsent" as never, { token: c.token, ...consent } as never).catch(() => {});
  }
}

export const backend = new Backend();
