import { ConvexHttpClient } from "convex/browser";
import type { EventType, Recipe } from "@justask/shared";
import { getSettings } from "./config";

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

  async redeem(convexUrl: string, code: string): Promise<{ token: string; displayName: string }> {
    const client = new ConvexHttpClient(convexUrl);
    return client.mutation("devices:redeemCode" as never, { code } as never);
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
