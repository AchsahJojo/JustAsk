import type { Planner } from "@justask/core";
import { cleanQuery, PlanResponse, QueryResponse, type PlanRequest } from "@justask/shared";

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

  /**
   * The user's request as a coherent web search ("I want to buy a pink owala on Amazon" becomes
   * "pink owala water bottle amazon"), from Claude via POST /search-query. Only their words are sent.
   * Null on any failure or after `timeoutMs`, so the caller can fall back to its own words.
   */
  async searchQuery(request: string, deviceToken: string | null, timeoutMs = 5000): Promise<string | null> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl().replace(/\/$/, "")}/search-query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceToken, request: request.slice(0, 500) }),
        signal: ctl.signal,
      });
      const out = QueryResponse.safeParse(await res.json());
      return out.success && out.data.ok ? cleanQuery(out.data.query) : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
