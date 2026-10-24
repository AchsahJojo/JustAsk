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

  it("accepts an act reply with text", async () => {
    const reply = JSON.stringify({ kind: "act", say: "I'm clicking Refill.", target: 1, expect: "click", option: null, text: null, risk: "none" });
    const res = await planStep(client([message("end_turn", reply)], []), req);
    expect(res).toMatchObject({ ok: true, step: { kind: "act", target: 1 } });
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

describe("mock-script drive-mode rules (titles are a contract with the fixture pages)", () => {
  const rules: MockRule[] = JSON.parse(readFileSync(fileURLToPath(new URL("../../../apps/fixtures/mock-script.json", import.meta.url)), "utf8"));
  let n = 0;
  const el = (role: string, text: string, field?: SnapshotElement["field"], label: string | null = null): SnapshotElement => ({
    n: ++n, role, text, label, nearby: null, color: null, big: false, disabled: false, inModal: false, inViewport: true, region: "main", ...(field ? { field } : {}),
  });
  const plan = (title: string, elements: SnapshotElement[], history: string[] = [], request = "find me a water bottle") => {
    const snapshot: PageSnapshot = { snapshotId: "s", url: "http://localhost/", title, heading: "", pageText: "", elements: elements.map((e, i) => ({ ...e, n: i + 1 })), omitted: { count: 0, regions: [] }, surface: "web" };
    const res = mockPlan({ ...req, request, history, snapshot }, rules);
    if (!res.ok) throw new Error("mock failed");
    return res.step;
  };
  const search = (hasValue: boolean) => el("search box", "", { kind: "search", hasValue, valid: true }, "Search products");

  it("Store | Home: types the request words, then submits", () => {
    expect(plan("Store | Home", [el("button", "Shop by room"), search(false)])).toMatchObject({ kind: "act", expect: "type", text: "water bottle", target: 2 });
    const typed = ['On "Store | Home": JustAsk did: "I\'m typing water bottle in the search box." (type)'];
    expect(plan("Store | Home", [el("button", "Shop by room"), search(true)], typed)).toMatchObject({ kind: "act", expect: "submit", target: 2 });
  });

  it("Store | Results: clicks Add to cart, then done", () => {
    expect(plan("Store | Results", [el("link", "Water bottle 24 oz"), el("button", "Add to cart")])).toMatchObject({ kind: "act", expect: "click", target: 2 });
    expect(plan("Store | Results", [el("button", "Add to cart")], ['JustAsk did: "I\'m clicking the Add to cart button." (click)'])).toMatchObject({ kind: "done" });
  });

  it("Checkout: guides the card number, asks first on Place order", () => {
    const card = (hasValue: boolean) => el("text box", "", { kind: "text", hasValue, valid: true, sensitive: true }, "Card number");
    expect(plan("Checkout", [card(false), el("button", "Place order $42.10")])).toMatchObject({ kind: "guide", expect: "type", target: 1 });
    expect(plan("Checkout", [card(true), el("button", "Place order $42.10")])).toMatchObject({ kind: "act", expect: "click", target: 2, risk: "money" });
  });

  it("Sign in: guides email and password, never acts on them", () => {
    const email = (v: boolean) => el("text box", "", { kind: "email", hasValue: v, valid: true }, "Email");
    const pw = (v: boolean) => el("text box", "", { kind: "password", hasValue: v, valid: true, sensitive: true }, "Password");
    const btn = el("button", "Sign in");
    expect(plan("Sign in", [email(false), pw(false), btn])).toMatchObject({ kind: "guide", target: 1 });
    expect(plan("Sign in", [email(true), pw(false), btn])).toMatchObject({ kind: "guide", target: 2 });
    expect(plan("Sign in", [email(true), pw(true), btn])).toMatchObject({ kind: "act", expect: "click", target: 3 });
  });

  it("Composer: waits while loading, then clicks the post box", () => {
    expect(plan("Composer", [el("button", "Close")])).toMatchObject({ kind: "wait", target: null });
    expect(plan("Composer", [el("button", "Close"), el("text box", "What's on your mind?", { kind: "contenteditable", hasValue: false, valid: true })])).toMatchObject({ kind: "act", expect: "click", target: 2 });
  });

  it("Notepad (native): opens the browser for a web task, with no URL", () => {
    const snapshot: PageSnapshot = {
      snapshotId: "s", url: "", title: "Untitled - Notepad", heading: "", pageText: "", elements: [{ ...el("document", "Text editor"), n: 1 }],
      omitted: { count: 0, regions: [] }, surface: "native", app: { name: "Notepad", window: "Untitled - Notepad" },
    };
    const run = (history: string[] = []) => {
      const res = mockPlan({ ...req, request: "find a banana bread recipe", history, snapshot }, rules);
      if (!res.ok) throw new Error("mock failed");
      return res.step;
    };
    expect(run()).toEqual({ kind: "open_browser", say: "I'm opening your web browser.", target: null, expect: null, option: null, text: null, risk: "none" });
    // The history note core writes after a successful open (packages/core/src/lines.ts OPENED_BROWSER_NOTE).
    expect(run(['On "Untitled - Notepad": JustAsk did: opened her web browser at its start page'])).toMatchObject({ kind: "done" });
  });

  it("existing fixture rules stay guide steps", () => {
    expect(plan("Maple Pharmacy | Home", [el("button", "Refill a prescription")])).toMatchObject({ kind: "guide" });
  });
});
