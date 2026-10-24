import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { PlanRequest, type PlanResponse } from "@justask/shared";
import { makeClient, planStep } from "../lib/planStep";

/** Runs one Claude step. The snapshot is passed through and never stored. */
export const run = internalAction({
  args: { body: v.string() },
  handler: async (ctx, { body }): Promise<PlanResponse> => {
    const parsed = PlanRequest.safeParse(JSON.parse(body));
    if (!parsed.success) return { ok: false, error: "bad request", retryable: false };
    try {
      await ctx.runMutation(internal.devices.consumeStep, { token: parsed.data.deviceToken ?? "" });
    } catch (e) {
      const m = String((e as Error).message);
      return { ok: false, error: /not paired/.test(m) ? "not paired" : /rate limited/.test(m) ? "rate limited" : "error", retryable: false };
    }
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return { ok: false, error: "server not configured", retryable: false };
    // Log numbers only (stop reason, tokens), never the page.
    return planStep(makeClient(key), parsed.data, (l) => console.log("plan", JSON.stringify(l)));
  },
});
