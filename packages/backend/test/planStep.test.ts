import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { planStep } from "../lib/planStep";
import type { PlanRequest } from "@justask/shared";

const req: PlanRequest = {
  deviceToken: null,
  sessionId: null,
  request: "refill my prescription",
  history: [],
  recipe: null,
  retryNote: null,
  snapshot: {
    snapshotId: "snap-1",
    url: "http://x/",
    title: "Home",
    heading: "",
    pageText: "",
    omitted: { count: 0, regions: [] },
    surface: "web",
    elements: [{ n: 1, role: "button", text: "Refill", label: null, nearby: null, color: "blue", big: true, disabled: false, inModal: false, inViewport: true, region: "main" }],
  },
};

function message(stop_reason: string, text: string, extra: Record<string, unknown> = {}) {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: text ? [{ type: "text", text }] : [],
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 600 },
    ...extra,
  };
}

function client(replies: unknown[], seen: Array<{ headers: Headers; body: any }>) {
  let i = 0;
  return new Anthropic({
    apiKey: "test",
    maxRetries: 0,
    fetch: (async (_url: string, init: RequestInit) => {
      seen.push({ headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(replies[Math.min(i++, replies.length - 1)]), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch,
  });
}

const good = JSON.stringify({ kind: "guide", say: "Click the blue Refill button.", target: 1, expect: "click", option: null, text: null, risk: "none" });

describe("planStep request shape (plan §4.2)", () => {
  it("uses the beta endpoint with fallbacks default, low effort, json_schema, cached system, no sampling params or thinking", async () => {
    const seen: Array<{ headers: Headers; body: any }> = [];
    const res = await planStep(client([message("end_turn", good)], seen), req);
    expect(res).toMatchObject({ ok: true, snapshotId: "snap-1", step: { kind: "guide", target: 1 } });
    const { headers, body } = seen[0];
    expect(headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.fallbacks).toBe("default");
    expect(body.max_tokens).toBe(4096);
    expect(body.output_config.effort).toBe("low");
    expect(body.output_config.format.type).toBe("json_schema");
    expect(body.output_config.format.schema.additionalProperties).toBe(false);
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
    for (const k of ["temperature", "top_p", "top_k", "thinking", "output_format", "betas"]) expect(body).not.toHaveProperty(k);
    expect(body.messages[0].content).toContain("<page_content>");
  });

  it("maps refusal to blocked and discards partial output", async () => {
    const seen: any[] = [];
    const res = await planStep(client([message("refusal", '{"kind":"gui', { stop_details: { type: "refusal", category: "cyber", explanation: null } })], seen), req);
    expect(res).toMatchObject({ ok: true, step: { kind: "blocked", target: null } });
  });

  it("retries max_tokens once, then blocks", async () => {
    const seen: any[] = [];
    const res = await planStep(client([message("max_tokens", ""), message("max_tokens", "")], seen), req);
    expect(seen.length).toBe(2);
    expect(res).toMatchObject({ ok: true, step: { kind: "blocked" } });
    const seen2: any[] = [];
    const res2 = await planStep(client([message("max_tokens", ""), message("end_turn", good)], seen2), req);
    expect(res2).toMatchObject({ ok: true, step: { kind: "guide" } });
  });

  it("an unparseable reply is retryable", async () => {
    const res = await planStep(client([message("end_turn", "not json")], []), req);
    expect(res).toEqual({ ok: false, error: "unparseable reply", retryable: true });
  });
});
