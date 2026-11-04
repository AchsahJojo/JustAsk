import { describe, expect, it, vi } from "vitest";
import { SYSTEM_PROMPT } from "@justask/core";
import type { PlanRequest, StepResponse } from "@justask/shared";
import type { PlanLog } from "../lib/planStep";
import { DEEPSEEK_EXTRA_RULES, DEEPSEEK_STEP_SYSTEM, DEEPSEEK_URL, INVALID_JSON_NOTE, deepseekCheckTask, deepseekPlanStep, deepseekSearchQuery } from "../lib/providers/deepseek";
import { deepseekAllowed, pickProvider } from "../lib/providers";
import { checkOutsideKnowledge } from "../lib/providers/guard";

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

const good: StepResponse = { kind: "guide", say: "Click the big blue button that says Refill.", target: 1, expect: "click", option: null, text: null, risk: "none", choices: null };

/** A DeepSeek chat completion with this content. */
const reply = (content: string, finish = "stop", usage: Record<string, number> = { completion_tokens: 30, prompt_cache_hit_tokens: 640 }) =>
  new Response(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finish }], usage }), { status: 200, headers: { "content-type": "application/json" } });

/** A mocked fetch that answers each call in turn, and keeps the parsed request bodies. */
function mockFetch(...answers: Array<Response | Error>) {
  const bodies: Array<{ model: string; response_format: unknown; messages: Array<{ role: string; content: string }> }> = [];
  const headers: Array<Record<string, string>> = [];
  let i = 0;
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe(DEEPSEEK_URL);
    bodies.push(JSON.parse(String(init.body)));
    headers.push(init.headers as Record<string, string>);
    const a = answers[Math.min(i++, answers.length - 1)];
    if (a instanceof Error) throw a;
    return a.clone();
  });
  return { fetch: fn as unknown as typeof fetch, bodies, headers, calls: () => fn.mock.calls.length };
}

describe("DeepSeek planStep (mocked fetch)", () => {
  it("valid JSON: parsed with the Zod StepResponse, cache hits logged as cacheReadTokens", async () => {
    const f = mockFetch(reply(JSON.stringify(good)));
    const logs: PlanLog[] = [];
    const res = await deepseekPlanStep("dk-test", req, (l) => logs.push(l), { fetch: f.fetch });
    expect(res).toMatchObject({ ok: true, snapshotId: "snap-1", step: good });
    expect(f.calls()).toBe(1);
    expect(logs[0]).toMatchObject({ stopReason: "stop", outputTokens: 30, cacheReadTokens: 640, checkFail: null });
    // The key goes in the header only; json_object mode; the same system prompt and page_content turn as Claude gets.
    expect(f.headers[0].authorization).toBe("Bearer dk-test");
    expect(f.bodies[0].response_format).toEqual({ type: "json_object" });
    expect(f.bodies[0].messages[0]).toEqual({ role: "system", content: DEEPSEEK_STEP_SYSTEM });
    expect(DEEPSEEK_STEP_SYSTEM.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(f.bodies[0].messages[1].content).toContain("<page_content>");
  });

  it("invalid JSON, then a retry with the note, then a valid step", async () => {
    const f = mockFetch(reply("Sure! Click Refill."), reply(JSON.stringify(good)));
    const res = await deepseekPlanStep("k", req, () => {}, { fetch: f.fetch });
    expect(res).toMatchObject({ ok: true, step: good });
    expect(f.calls()).toBe(2);
    expect(f.bodies[1].messages[1].content).toContain(INVALID_JSON_NOTE);
    // Byte-identical system prompt between calls, so DeepSeek's cache prefix holds.
    expect(f.bodies[1].messages[0].content).toBe(f.bodies[0].messages[0].content);
  });

  it("JSON that breaks the schema twice blocks", async () => {
    const f = mockFetch(reply(JSON.stringify({ ...good, extra: 1 })), reply(JSON.stringify({ kind: "guide" })));
    const res = await deepseekPlanStep("k", req, () => {}, { fetch: f.fetch });
    expect(res).toMatchObject({ ok: true, step: { kind: "blocked" } });
    expect(f.calls()).toBe(2);
  });

  it("a reply that fails checkStep retries once with the reason, then blocks", async () => {
    const bad = { ...good, target: 9 };
    const f = mockFetch(reply(JSON.stringify(bad)), reply(JSON.stringify(bad)));
    const res = await deepseekPlanStep("k", req, () => {}, { fetch: f.fetch });
    expect(f.bodies[1].messages[1].content).toContain("target 9 is not in the current list");
    expect(res).toMatchObject({ ok: true, step: { kind: "blocked" } });
  });

  it("429 and 5xx are retryable; other statuses are not", async () => {
    expect(await deepseekPlanStep("k", req, () => {}, { fetch: mockFetch(new Response("", { status: 429 })).fetch })).toEqual({ ok: false, error: "api 429", retryable: true });
    expect(await deepseekPlanStep("k", req, () => {}, { fetch: mockFetch(new Response("", { status: 503 })).fetch })).toEqual({ ok: false, error: "api 503", retryable: true });
    expect(await deepseekPlanStep("k", req, () => {}, { fetch: mockFetch(new Response("", { status: 401 })).fetch })).toEqual({ ok: false, error: "api 401", retryable: false });
  });

  it("a network error or the 10 s timeout is retryable", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(await deepseekPlanStep("k", req, () => {}, { fetch: mockFetch(abort).fetch })).toEqual({ ok: false, error: "timeout", retryable: true });
    expect(await deepseekPlanStep("k", req, () => {}, { fetch: mockFetch(new TypeError("fetch failed")).fetch })).toEqual({ ok: false, error: "TypeError", retryable: true });
  });

  it("content_filter is the refusal: blocked, no retry", async () => {
    const f = mockFetch(reply("", "content_filter"));
    const res = await deepseekPlanStep("k", req, () => {}, { fetch: f.fetch });
    expect(res).toMatchObject({ ok: true, step: { kind: "blocked", say: "I can't help with this page. Let's ask your helper." } });
    expect(f.calls()).toBe(1);
  });
});

describe("DeepSeek search query and task check (mocked fetch)", () => {
  it("search query: only the user's words go in", async () => {
    const f = mockFetch(reply(JSON.stringify({ query: "owala water bottle" })));
    expect(await deepseekSearchQuery("k", "help me find an owala", { fetch: f.fetch })).toEqual({ ok: true, query: "owala water bottle" });
    expect(f.bodies[0].messages[1].content).toBe("<request>help me find an owala</request>");
    expect(await deepseekSearchQuery("k", "x", { fetch: mockFetch(reply("nope")).fetch })).toEqual({ ok: false, error: "unparseable reply" });
  });

  it("task check: a clear draft is tidied; content_filter becomes a question", async () => {
    const draft = { title: "Buy The Midnight Library", spokenPrompt: "help me buy The Midnight Library on Amazon", startUrl: "https://www.amazon.com/", steps: ["Search for it"] };
    const f = mockFetch(reply(JSON.stringify({ clear: true, question: null, draft })));
    const out = await deepseekCheckTask("k", { name: "Ruth", request: "buy The Midnight Library on Amazon", answers: [] }, { fetch: f.fetch });
    expect(out).toEqual({ ok: true, reply: { clear: true, question: null, draft } });
    const blocked = await deepseekCheckTask("k", { name: "Ruth", request: "x", answers: [] }, { fetch: mockFetch(reply("", "content_filter")).fetch });
    expect(blocked).toMatchObject({ ok: true, reply: { clear: false, draft: null } });
  });
});

describe("pickProvider (PLANNER_PROVIDER)", () => {
  it("unset or anthropic: today's Anthropic path", () => {
    for (const PLANNER_PROVIDER of [undefined, "", "anthropic", "Anthropic"]) {
      const p = pickProvider({ PLANNER_PROVIDER, ANTHROPIC_API_KEY: "sk-ant-x", DEEPSEEK_API_KEY: "dk" });
      expect(p).toMatchObject({ ok: true, warning: null, provider: { name: "anthropic" } });
    }
    expect(pickProvider({})).toEqual({ ok: false, error: "server not configured" });
  });

  it("deepseek in dev needs DEEPSEEK_API_KEY", () => {
    expect(pickProvider({ PLANNER_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "dk" })).toMatchObject({ ok: true, provider: { name: "deepseek" } });
    expect(pickProvider({ PLANNER_PROVIDER: "deepseek", CONVEX_CLOUD_URL: "http://127.0.0.1:3210", DEEPSEEK_API_KEY: "dk" })).toMatchObject({ ok: true, provider: { name: "deepseek" } });
    expect(pickProvider({ PLANNER_PROVIDER: "deepseek", ANTHROPIC_API_KEY: "sk-ant-x" })).toEqual({ ok: false, error: "server not configured" });
  });

  it("refuses deepseek on a cloud deployment unless marked dev, and falls back to anthropic", () => {
    const prod = { PLANNER_PROVIDER: "deepseek", CONVEX_CLOUD_URL: "https://happy-otter-123.convex.cloud", DEEPSEEK_API_KEY: "dk", ANTHROPIC_API_KEY: "sk-ant-x" };
    expect(deepseekAllowed(prod)).toBe(false);
    const p = pickProvider(prod);
    expect(p).toMatchObject({ ok: true, provider: { name: "anthropic" } });
    expect(p.ok && p.warning).toMatch(/refused/);
    expect(pickProvider({ ...prod, PLANNER_ALLOW_DEEPSEEK: "dev" })).toMatchObject({ ok: true, provider: { name: "deepseek" } });
  });

  it("an unknown provider name falls back to anthropic with a warning", () => {
    const p = pickProvider({ PLANNER_PROVIDER: "gpt", ANTHROPIC_API_KEY: "sk-ant-x" });
    expect(p).toMatchObject({ ok: true, provider: { name: "anthropic" } });
    expect(p.ok && p.warning).toMatch(/unknown/);
  });
});

describe("DeepSeek outside-knowledge guard", () => {
  const meds: PlanRequest = {
    ...req,
    history: ['JustAsk said: "Which one?"', 'The user answered: "the blood pressure one"'],
    snapshot: {
      ...req.snapshot,
      pageText: "Choose a prescription. Amlodipine 5mg - Refill. Sertraline 50mg - Refill.",
      elements: [
        { ...req.snapshot.elements[0], n: 1, nearby: "Amlodipine 5mg" },
        { ...req.snapshot.elements[0], n: 2, nearby: "Sertraline 50mg" },
      ],
    },
  };
  const guess: StepResponse = { ...good, say: "Click the Refill button next to Amlodipine, the blood pressure one." };
  const ask: StepResponse = { kind: "clarify", say: "The page doesn't say what each is for. Amlodipine or Sertraline?", target: null, expect: null, option: null, text: null, risk: "none", choices: ["Amlodipine 5mg", "Sertraline 50mg"] };

  it("a guide line claiming what the page never says is re-planned with the reason, and a clarify passes", async () => {
    const f = mockFetch(reply(JSON.stringify(guess)), reply(JSON.stringify(ask)));
    const res = await deepseekPlanStep("dk-test", meds, () => {}, { fetch: f.fetch });
    expect(res).toMatchObject({ ok: true, step: { kind: "clarify" } });
    expect(f.calls()).toBe(2);
    expect(f.bodies[1].messages[1].content).toContain('the page never says "blood pressure"');
  });

  it("guessing twice blocks", async () => {
    const f = mockFetch(reply(JSON.stringify(guess)));
    const res = await deepseekPlanStep("dk-test", meds, () => {}, { fetch: f.fetch });
    expect(res).toMatchObject({ ok: true, step: { kind: "blocked" } });
    expect(f.calls()).toBe(2);
  });

  it("the claim is fine when the page says it", () => {
    const labelled = { ...meds.snapshot, pageText: meds.snapshot.pageText + " Amlodipine (blood pressure)." };
    expect(checkOutsideKnowledge(guess, labelled)).toEqual({ ok: true });
    expect(checkOutsideKnowledge(guess, meds.snapshot)).toMatchObject({ ok: false, code: "outside_knowledge" });
    // A done line has no target, so it may repeat the user's words.
    expect(checkOutsideKnowledge({ kind: "done", say: "That's fine. When your daughter sends it, press the big button.", target: null, expect: null, option: null, text: null, risk: "none", choices: null }, meds.snapshot)).toEqual({ ok: true });
    // Whole words only: "reason" is not "son".
    expect(checkOutsideKnowledge({ ...good, say: "Click Refill for that reason." }, meds.snapshot)).toEqual({ ok: true });
  });

  it("the extra rules sit between the shared prompt and the schema, as one constant", () => {
    expect(DEEPSEEK_STEP_SYSTEM.startsWith(SYSTEM_PROMPT + DEEPSEEK_EXTRA_RULES)).toBe(true);
  });
});
