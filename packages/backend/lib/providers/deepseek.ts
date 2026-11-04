import { buildTurn, SYSTEM_PROMPT, userText } from "@justask/core";
import { checkStep, cleanQuery, fixStep, StepResponse, stepJsonSchema, TaskCheckReply, taskCheckJsonSchema, type PlanRequest, type PlanResponse, type QueryResponse } from "@justask/shared";
import { checkLog, type PlanLog } from "../planStep";
import { checkOutsideKnowledge } from "./guard";
import { QUERY_SYSTEM } from "../searchQuery";
import { TASK_CHECK_SYSTEM, taskCheckTurn, tidyReply, type TaskCheckInput, type TaskCheckOutcome } from "../taskCheck";
import type { StepProvider } from "./types";

// DeepSeek planner (feature branch, issue #18). Dev and eval only until the privacy review is done:
// the snapshot (page text, element labels, URL) would go to a second provider. `pickProvider` refuses
// it on anything but a local or explicitly-marked dev deployment.

export const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
export const DEEPSEEK_MODEL = "deepseek-chat";

/**
 * DeepSeek has `response_format: json_object`, not a strict JSON Schema, so the schema goes in the
 * system prompt. Each system prompt is a constant: byte-identical between calls, so DeepSeek's own
 * context cache (no `cache_control`) keeps the prefix.
 */
const jsonNote = (schema: unknown) =>
  `\n\nReply with one JSON object only, no other text. It must match this JSON Schema exactly, with every property present (use null where allowed):\n${JSON.stringify(schema)}`;
/**
 * Extra rules for DeepSeek only. The 2026-11-04 eval showed it guessing which medicine, account or plan the user
 * meant from their description. The examples use names that are not in the eval fixtures, so a better score means
 * the rule took, not that the answers were copied.
 */
export const DEEPSEEK_EXTRA_RULES = `

Ask, don't guess (read this twice; it matters more than finishing the task):
- When the user describes the item by what it is for or who it is ("the blood pressure one", "my savings", "my son", "the cheaper plan") and no words on the page say which item that is, reply "clarify". Say the names from the screen and ask which one. Put those names in "choices", copied exactly from the page. Never connect their description to an item using your own knowledge, even if you are sure. A wrong guess here can cost money or harm health.
- Medicines, money, accounts, people and plans: never pick one for the user. This stays true after "I'm not sure", "either is fine" or "you pick". If you already asked, don't ask again: reply "done" and tell them to check the name (on the bottle, the statement, the card) and press the big button again.
- Never write what a medicine is for, which account is savings, who a person is, or which plan costs less, unless those exact words are on the page.
- Before you reply "guide", check: did the user's own words name this item, or is it the only item that can do what they asked? If two or more items fit and their words don't pick one, reply "clarify".
- When only one item can do what they asked (the others say Not due, Needs renewal, Out of stock, or are disabled), guide them to that one and say why in a few words. Don't ask.
- Risk: picking an item, opening a page or a Refill button is "none". Use "personal_info" only for the button that sends their details, and "money" only for the button that pays.
- If the user forgot their password or doesn't know it, point at the "Forgot password" or "Can't sign in" link if there is one. Never point at the password box again.

More worked examples (shapes only):
A. Page text "Atorvastatin 20mg - Refill. Omeprazole 40mg - Refill." History: JustAsk asked which one; the user answered "the cholesterol one". Reply: {"kind":"clarify","say":"The page doesn't say what each is for. Is it Atorvastatin or Omeprazole?","target":null,"expect":null,"option":null,"text":null,"risk":"none","choices":["Atorvastatin 20mg","Omeprazole 40mg"]}
B. Request "send money from my savings". List has [3] radio "Main 4410" and [4] radio "Holiday Fund 9902". Neither says savings. Reply: {"kind":"clarify","say":"I don't see which one is savings. Should it come from Main or Holiday Fund?","target":null,"expect":null,"option":null,"text":null,"risk":"none","choices":["Main 4410","Holiday Fund 9902"]}
C. Same page as A. History: JustAsk asked "Is it Atorvastatin or Omeprazole?" and the user answered "either is fine". Reply: {"kind":"done","say":"Let's not guess. Check the name on your bottle, then press the big button again.","target":null,"expect":null,"option":null,"text":null,"risk":"none","choices":null}
D. Request "refill my prescription". List has [5] button "Refill" near "Amlodipine 5mg", [6] text "Not due until June" near "Sertraline 50mg". Reply: {"kind":"guide","say":"Click the blue Refill button next to Amlodipine. It's the only one ready now.","target":5,"expect":"click","option":null,"text":null,"risk":"none","choices":null}
E. Request "log in to my bank". History: the user answered "I forgot my password". List has [2] password box and [7] link "Forgot password?". Reply: {"kind":"guide","say":"Click the link that says Forgot password? to set a new one.","target":7,"expect":"click","option":null,"text":null,"risk":"none","choices":null}`;

export const DEEPSEEK_STEP_SYSTEM = SYSTEM_PROMPT + DEEPSEEK_EXTRA_RULES + jsonNote(stepJsonSchema());
export const DEEPSEEK_TASK_SYSTEM = TASK_CHECK_SYSTEM + jsonNote(taskCheckJsonSchema());

/** The note for the one retry after a reply that isn't valid JSON for the schema. */
export const INVALID_JSON_NOTE = "Your last reply was not one JSON object matching the schema. Reply again with exactly one JSON object with every field.";

const BLOCKED_REFUSAL = "I can't help with this page. Let's ask your helper.";
const BLOCKED_TROUBLE = "I'm having trouble. Let's try again in a moment.";

export interface DeepSeekOptions {
  model?: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  /** Per attempt. The controller expects 10 s per planner call. */
  timeoutMs?: number;
}

interface ChatReply {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>;
  usage?: { completion_tokens?: number; prompt_cache_hit_tokens?: number };
}

/** One chat call. Status codes and error names only come back, never the request or reply text. */
type Chat =
  | { ok: true; content: string; finish: string | null; outputTokens: number; cacheHitTokens: number }
  | { ok: false; error: string; retryable: boolean };

async function chat(key: string, system: string, user: string, maxTokens: number, o: DeepSeekOptions): Promise<Chat> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 10_000);
  try {
    const res = await (o.fetch ?? fetch)(DEEPSEEK_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: o.model ?? DEEPSEEK_MODEL,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: ctrl.signal,
    });
    // The same split as the Anthropic path: rate limits and server errors are worth one more try.
    if (!res.ok) return { ok: false, error: `api ${res.status}`, retryable: res.status === 429 || res.status >= 500 };
    const body = (await res.json()) as ChatReply;
    const c = body.choices?.[0];
    return {
      ok: true,
      content: c?.message?.content ?? "",
      finish: c?.finish_reason ?? null,
      outputTokens: body.usage?.completion_tokens ?? 0,
      cacheHitTokens: body.usage?.prompt_cache_hit_tokens ?? 0,
    };
  } catch (err) {
    const name = (err as Error | null)?.name;
    return { ok: false, error: name === "AbortError" ? "timeout" : (name ?? "network"), retryable: true };
  } finally {
    clearTimeout(timer);
  }
}

const blocked = (req: PlanRequest, say: string, started: number): PlanResponse => ({
  ok: true,
  snapshotId: req.snapshot.snapshotId,
  latencyMs: Date.now() - started,
  step: { kind: "blocked", say, target: null, expect: null, option: null, text: null, risk: "none" },
});

/**
 * One planner step from DeepSeek. Every reply is parsed with the Zod `StepResponse` and checked with
 * `checkStep` (after `fixStep`, as in the extension). An invalid reply gets one retry with the reason as
 * `retryNote`; a second invalid reply blocks. `content_filter` is the refusal: blocked, no retry.
 */
export async function deepseekPlanStep(key: string, req: PlanRequest, log: (l: PlanLog) => void = () => {}, o: DeepSeekOptions = {}): Promise<PlanResponse> {
  const started = Date.now();
  const said = userText(req.request, req.history, req.recipe);
  let retryNote = req.retryNote;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await chat(key, DEEPSEEK_STEP_SYSTEM, buildTurn(req.request, req.history, req.recipe, req.snapshot, retryNote), 1024, o);
    if (!r.ok) return { ok: false, error: r.error, retryable: r.retryable };
    const entry: PlanLog = { stopReason: r.finish, outputTokens: r.outputTokens, cacheReadTokens: r.cacheHitTokens };
    if (r.finish === "content_filter") {
      log(entry);
      return blocked(req, BLOCKED_REFUSAL, started);
    }
    let step: StepResponse;
    try {
      step = StepResponse.parse(JSON.parse(r.content));
    } catch {
      log(entry);
      retryNote = INVALID_JSON_NOTE;
      continue;
    }
    log({ ...entry, ...checkLog(step, req.snapshot, said) });
    const fixed = fixStep(step, req.snapshot);
    const base = checkStep(fixed, req.snapshot, said);
    // DeepSeek only: a guide line may not claim what the page never says (which medicine, which account).
    const check = base.ok ? checkOutsideKnowledge(fixed, req.snapshot) : base;
    if (!check.ok) {
      // The same note the controller sends on a re-plan. The extension's own check still runs on what we return.
      retryNote = check.reason;
      continue;
    }
    return { ok: true, snapshotId: req.snapshot.snapshotId, step, latencyMs: Date.now() - started };
  }
  return blocked(req, BLOCKED_TROUBLE, started);
}

/** `/search-query` on DeepSeek: only the user's words go in. */
export async function deepseekSearchQuery(key: string, request: string, o: DeepSeekOptions = {}): Promise<QueryResponse> {
  const r = await chat(key, QUERY_SYSTEM, `<request>${request.slice(0, 500)}</request>`, 200, o);
  if (!r.ok) return { ok: false, error: r.error };
  if (r.finish === "content_filter") return { ok: false, error: "refusal" };
  if (r.finish === "length") return { ok: false, error: "max_tokens" };
  try {
    const query = cleanQuery((JSON.parse(r.content) as { query?: unknown }).query);
    return query ? { ok: true, query } : { ok: false, error: "empty query" };
  } catch {
    return { ok: false, error: "unparseable reply" };
  }
}

/** The caregiver task check on DeepSeek. Only the caregiver's words go in. */
export async function deepseekCheckTask(key: string, input: TaskCheckInput, o: DeepSeekOptions = {}): Promise<TaskCheckOutcome> {
  const r = await chat(key, DEEPSEEK_TASK_SYSTEM, taskCheckTurn(input), 2048, { timeoutMs: 45_000, ...o });
  if (!r.ok) return { ok: false, error: r.error };
  if (r.finish === "content_filter") return { ok: true, reply: { clear: false, question: "JustAsk can't help with this one. What else should it help them do?", draft: null } };
  if (r.finish === "length") return { ok: false, error: "max_tokens" };
  try {
    return { ok: true, reply: tidyReply(TaskCheckReply.parse(JSON.parse(r.content))) };
  } catch {
    return { ok: false, error: "unparseable reply" };
  }
}

export function deepseekProvider(key: string, o: DeepSeekOptions = {}): StepProvider {
  return {
    name: "deepseek",
    planStep: (req, log) => deepseekPlanStep(key, req, log, o),
    searchQuery: (request) => deepseekSearchQuery(key, request, o),
    checkTask: (input, timeoutMs = 45_000) => deepseekCheckTask(key, input, { ...o, timeoutMs }),
  };
}
