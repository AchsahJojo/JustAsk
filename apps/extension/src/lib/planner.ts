import type { Planner } from "@justask/core";
import { PlanResponse, type PlanRequest } from "@justask/shared";

/** POST /plan to the Convex HTTP action (or the local dev planner). The extension holds no keys. */
export class HttpPlanner implements Planner {
  constructor(private baseUrl: () => string) {}

  async plan(req: PlanRequest, signal: AbortSignal) {
    const res = await fetch(`${this.baseUrl().replace(/\/$/, "")}/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
      signal,
    });
    if (res.status >= 500) return { ok: false as const, error: `http ${res.status}`, retryable: true };
    return PlanResponse.parse(await res.json());
  }
}
