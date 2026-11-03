import Anthropic from "@anthropic-ai/sdk";
import { buildTurn, SYSTEM_PROMPT } from "@justask/core";
import { checkStep, fixStep, sayWords, StepResponse, stepJsonSchema, type CheckCode, type PageSnapshot, type PlanRequest, type PlanResponse } from "@justask/shared";

export const MODEL = "claude-opus-5-5";
export const EFFORT = "low";
const STEP_JSON_SCHEMA = stepJsonSchema();

export function makeClient(apiKey: string, timeoutMs = 10_000): Anthropic {
  // plan §4.2: timeout in milliseconds for TypeScript, one SDK retry.
  return new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 1 });
}

export interface PlanLog {
  stopReason: string | null;
  refusalCategory?: string | null;
  outputTokens?: number;
  cacheReadTokens?: number;
  /** Words in the reply's `say`, before any trim. A number only: the line itself is never logged. */
  sayWords?: number;
  /** True when `fixStep` cut a long `say` at a sentence end instead of a re-plan. */
  trimmed?: boolean;
  /** The `checkStep` failure code the extension will re-plan on (after `fixStep`), or null when it passes. */
  checkFail?: CheckCode | null;
}

/** What `checkStep` will make of this reply in the extension, as numbers and codes for `PlanLog`. */
export function checkLog(step: StepResponse, snapshot: PageSnapshot): Pick<PlanLog, "sayWords" | "trimmed" | "checkFail"> {
  const fixed = fixStep(step, snapshot);
  const check = checkStep(fixed, snapshot);
  return { sayWords: sayWords(step.say), trimmed: fixed !== step, checkFail: check.ok ? null : check.code };
}

/** Overrides for the prompt eval (docs/ARCHITECTURE.md §12). Defaults: `claude-opus-5-5`, effort `low`. */
export interface PlanOptions {
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

/**
 * One planStep call. The snapshot goes to Claude and is never stored or logged here
 * (plan §3.7: no page data in Convex storage); only `PlanLog` numbers come back for logging.
 * The third argument is either the log callback (existing callers) or the eval options;
 * options can also come fourth, after a log callback.
 */
export async function planStep(
  client: Anthropic,
  req: PlanRequest,
  logOrOptions: ((l: PlanLog) => void) | PlanOptions = () => {},
  options: PlanOptions = {},
): Promise<PlanResponse> {
  const log = typeof logOrOptions === "function" ? logOrOptions : () => {};
  const opts: PlanOptions = typeof logOrOptions === "function" ? options : { ...logOrOptions, ...options };
  const started = Date.now();
  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try {
      res = await client.beta.messages.create({
        model: opts.model ?? MODEL,
        max_tokens: 4096, // covers low-effort thinking + the reply
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: {
          effort: opts.effort ?? EFFORT,
          format: { type: "json_schema", schema: STEP_JSON_SCHEMA },
        },
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: buildTurn(req.request, req.history, req.recipe, req.snapshot, req.retryNote) }],
      });
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError || err instanceof Anthropic.APIConnectionError) {
        return { ok: false, error: err.constructor.name, retryable: true };
      }
      if (err instanceof Anthropic.APIError) return { ok: false, error: `api ${err.status}`, retryable: false };
      throw err;
    }

    const entry: PlanLog = {
      stopReason: res.stop_reason,
      refusalCategory: res.stop_reason === "refusal" ? (res.stop_details?.category ?? null) : undefined,
      outputTokens: res.usage.output_tokens,
      cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
    };

    if (res.stop_reason === "refusal" || res.stop_reason === "max_tokens") log(entry);
    if (res.stop_reason === "refusal") {
      // Final: the fallback model also refused, or the category is never retried. Discard partial output.
      return {
        ok: true,
        snapshotId: req.snapshot.snapshotId,
        latencyMs: Date.now() - started,
        step: { kind: "blocked", say: "I can't help with this page. Let's ask your helper.", target: null, expect: null, option: null, text: null, risk: "none" },
      };
    }
    if (res.stop_reason === "max_tokens") continue; // retry once, then blocked

    const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    let step: StepResponse;
    try {
      step = StepResponse.parse(JSON.parse(text));
    } catch {
      log(entry);
      return { ok: false, error: "unparseable reply", retryable: true };
    }
    log({ ...entry, ...checkLog(step, req.snapshot) });
    return { ok: true, snapshotId: req.snapshot.snapshotId, step, latencyMs: Date.now() - started };
  }
  return {
    ok: true,
    snapshotId: req.snapshot.snapshotId,
    latencyMs: Date.now() - started,
    step: { kind: "blocked", say: "I'm having trouble. Let's try again in a moment.", target: null, expect: null, option: null, text: null, risk: "none" },
  };
}
