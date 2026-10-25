import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { PlanRequest, QueryRequest, type PlanResponse, type QueryResponse } from "@justask/shared";
import { makeClient, planStep } from "../lib/planStep";
import { searchQuery } from "../lib/searchQuery";

/** ConvexError data ("not paired") or a plain error's message ("rate limited"). */
function errorText(e: unknown): string {
  const data = (e as { data?: unknown } | null)?.data;
  return typeof data === "string" ? data : String((e as Error | null)?.message);
}

/**
 * Runs one Claude step for the `/plan` HTTP action. Called in-process, never through
 * `runAction`, so the snapshot (page text, element text, URL) is never a function argument
 * that Convex could record. It is passed through and never stored; logs are numbers only.
 */
export async function runPlan(ctx: ActionCtx, body: string): Promise<PlanResponse> {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, error: "bad request", retryable: false };
  }
  const parsed = PlanRequest.safeParse(json);
  if (!parsed.success) return { ok: false, error: "bad request", retryable: false };
  try {
    await ctx.runMutation(internal.devices.consumeStep, { token: parsed.data.deviceToken ?? "" });
  } catch (e) {
    const m = errorText(e);
    return { ok: false, error: /not paired/.test(m) ? "not paired" : /rate limited/.test(m) ? "rate limited" : "error", retryable: false };
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, error: "server not configured", retryable: false };
  // Log numbers only (stop reason, tokens), never the page.
  return planStep(makeClient(key), parsed.data, (l) => console.log("plan", JSON.stringify(l)));
}

/**
 * `/search-query`: the user's request rewritten as a web search (only their words; no page).
 * Same device check and hourly step budget as `/plan`.
 */
export async function runQuery(ctx: ActionCtx, body: string): Promise<QueryResponse> {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, error: "bad request" };
  }
  const parsed = QueryRequest.safeParse(json);
  if (!parsed.success) return { ok: false, error: "bad request" };
  try {
    await ctx.runMutation(internal.devices.consumeStep, { token: parsed.data.deviceToken ?? "" });
  } catch (e) {
    const m = errorText(e);
    return { ok: false, error: /not paired/.test(m) ? "not paired" : /rate limited/.test(m) ? "rate limited" : "error" };
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, error: "server not configured" };
  return searchQuery(makeClient(key), parsed.data.request);
}
