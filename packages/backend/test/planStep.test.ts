import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { planStep } from "../lib/planStep";
import { mockPlan, type MockRule } from "../lib/mockPlanner";
import type { PageSnapshot, PlanRequest, SnapshotElement } from "@justask/shared";

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

const good = JSON.stringify({ kind: "guide", say: "Click the blue Refill button.", target: 1, expect: "click", option: null, risk: "none" });

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

  it("parses a guide reply with no text field", async () => {
    const res = await planStep(client([message("end_turn", good)], []), req);
    expect(res).toEqual({ ok: true, snapshotId: "snap-1", latencyMs: expect.any(Number), step: JSON.parse(good) });
  });

  it("rejects the old act kind and a text field (guide-only schema)", async () => {
    const act = JSON.stringify({ kind: "act", say: "I'm clicking Refill.", target: 1, expect: "click", option: null, risk: "none" });
    expect(await planStep(client([message("end_turn", act)], []), req)).toEqual({ ok: false, error: "unparseable reply", retryable: true });
    const withText = JSON.stringify({ ...JSON.parse(good), text: null });
    expect(await planStep(client([message("end_turn", withText)], []), req)).toEqual({ ok: false, error: "unparseable reply", retryable: true });
  });

  it("the JSON Schema sent to Claude has no act kind and no text field", async () => {
    const seen: Array<{ headers: Headers; body: any }> = [];
    await planStep(client([message("end_turn", good)], seen), req);
    const schema = seen[0].body.output_config.format.schema;
    expect(Object.keys(schema.properties)).not.toContain("text");
    expect(JSON.stringify(schema.properties.kind)).not.toContain('"act"');
  });

  it("fallback blocked steps carry no text field", async () => {
    const refused = await planStep(client([message("refusal", "", { stop_details: { type: "refusal", category: "cyber", explanation: null } })], []), req);
    const exhausted = await planStep(client([message("max_tokens", ""), message("max_tokens", "")], []), req);
    for (const r of [refused, exhausted]) {
      if (!r.ok) throw new Error("expected ok");
      expect(r.step).not.toHaveProperty("text");
    }
  });

  it("takes eval options (model, effort) as the third or fourth argument; defaults unchanged", async () => {
    const seen: Array<{ headers: Headers; body: any }> = [];
    await planStep(client([message("end_turn", good)], seen), req, { model: "claude-sonnet-5-5", effort: "medium" });
    expect(seen[0].body.model).toBe("claude-sonnet-5-5");
    expect(seen[0].body.output_config.effort).toBe("medium");
    const logs: unknown[] = [];
    await planStep(client([message("end_turn", good)], seen), req, (l) => logs.push(l), { effort: "high" });
    expect(seen[1].body.model).toBe("claude-opus-5-5");
    expect(seen[1].body.output_config.effort).toBe("high");
    expect(logs.length).toBe(1);
    await planStep(client([message("end_turn", good)], seen), req);
    expect(seen[2].body.output_config.effort).toBe("low");
  });

  it("keeps the system prompt byte-stable across calls (cache prefix)", async () => {
    const seen: Array<{ headers: Headers; body: any }> = [];
    await planStep(client([message("end_turn", good)], seen), req);
    await planStep(client([message("end_turn", good)], seen), { ...req, request: "something else", history: ["x"] });
    expect(seen[0].body.system).toEqual(seen[1].body.system);
    expect(seen[0].body.system[0].text.length).toBeGreaterThan(3000);
  });
});

describe("mock-script guide rules (titles are a contract with the fixture pages)", () => {
  const rules: MockRule[] = JSON.parse(readFileSync(fileURLToPath(new URL("../../../apps/fixtures/mock-script.json", import.meta.url)), "utf8"));
  let n = 0;
  const el = (role: string, text: string, field?: SnapshotElement["field"], label: string | null = null): SnapshotElement => ({
    n: ++n, role, text, label, nearby: null, color: null, big: false, disabled: false, inModal: false, inViewport: true, region: "main", ...(field ? { field } : {}),
  });
  const plan = (title: string, elements: SnapshotElement[], history: string[] = [], request = "find me a water bottle") => {
    const snapshot: PageSnapshot = { snapshotId: "s", url: "http://localhost/", title, heading: "", pageText: "", elements: elements.map((e, i) => ({ ...e, n: i + 1 })), omitted: { count: 0, regions: [] } };
    const res = mockPlan({ ...req, request, history, snapshot }, rules);
    if (!res.ok) throw new Error("mock failed");
    expect(res.step).not.toHaveProperty("text");
    return res.step;
  };
  const search = (hasValue: boolean) => el("search box", "", { kind: "search", hasValue, valid: true }, "Search products");

  it("every rule is a guide-only kind with no text field", () => {
    for (const r of rules) {
      expect(["guide", "clarify", "wait", "done", "blocked"]).toContain(r.step.kind);
      expect(r.step).not.toHaveProperty("text");
    }
  });

  it("Store | Home: tells her to type in the search box, then click Search", () => {
    const page = (v: boolean) => [el("button", "Shop by room"), search(v), el("button", "Search")];
    expect(plan("Store | Home", page(false))).toMatchObject({ kind: "guide", expect: "type", target: 2, say: "Type water bottle in the search box." });
    expect(plan("Store | Home", page(true))).toMatchObject({ kind: "guide", expect: "click", target: 3 });
  });

  it("Store | Results: tells her to click Add to cart, then done", () => {
    expect(plan("Store | Results", [el("link", "Water bottle 24 oz"), el("button", "Add to cart")])).toMatchObject({ kind: "guide", expect: "click", target: 2 });
    const added = ['On "Store | Results": She did: "Click the button that says Add to cart." (click)'];
    expect(plan("Store | Results", [el("button", "Add to cart")], added)).toMatchObject({ kind: "done" });
  });

  it("Checkout: guides the card number, then Place order (money)", () => {
    const card = (hasValue: boolean) => el("text box", "", { kind: "text", hasValue, valid: true, sensitive: true }, "Card number");
    expect(plan("Checkout", [card(false), el("button", "Place order $42.10")])).toMatchObject({ kind: "guide", expect: "type", target: 1 });
    expect(plan("Checkout", [card(true), el("button", "Place order $42.10")])).toMatchObject({
      kind: "guide", expect: "click", target: 2, risk: "money", say: "Click the green button that says Place order.",
    });
  });

  it("Sign in: guides email, password, then the Sign in button", () => {
    const email = (v: boolean) => el("text box", "", { kind: "email", hasValue: v, valid: true }, "Email");
    const pw = (v: boolean) => el("text box", "", { kind: "password", hasValue: v, valid: true, sensitive: true }, "Password");
    const btn = el("button", "Sign in");
    expect(plan("Sign in", [email(false), pw(false), btn])).toMatchObject({ kind: "guide", target: 1 });
    expect(plan("Sign in", [email(true), pw(false), btn])).toMatchObject({ kind: "guide", target: 2 });
    expect(plan("Sign in", [email(true), pw(true), btn])).toMatchObject({ kind: "guide", expect: "click", target: 3 });
  });

  it("Composer: Start a post, then the post box, then done; waits while loading", () => {
    expect(plan("Composer", [el("button", "Start a post")])).toMatchObject({ kind: "guide", expect: "click", target: 1 });
    expect(plan("Composer", [el("button", "Close")])).toMatchObject({ kind: "wait", target: null });
    const box = el("text box", "", { kind: "contenteditable", hasValue: false, valid: true }, "What's on your mind?");
    const step = plan("Composer", [el("button", "Close"), box]);
    expect(step).toMatchObject({ kind: "guide", expect: "click", target: 2 });
    const clicked = [`On "Composer": She did: ${JSON.stringify(step.say)} (click)`];
    expect(plan("Composer", [el("button", "Close"), box], clicked)).toMatchObject({ kind: "done" });
  });

  it("existing fixture rules stay guide steps", () => {
    expect(plan("Maple Pharmacy | Home", [el("button", "Refill a prescription")])).toMatchObject({ kind: "guide" });
  });

  it("the heuristic fallback and blocked step are guide-only with no text", () => {
    expect(plan("Unknown page", [el("button", "Water bottle deals")])).toMatchObject({ kind: "guide", target: 1 });
    expect(plan("Unknown page", [el("button", "Nothing related")])).toMatchObject({ kind: "blocked", target: null });
  });
});
