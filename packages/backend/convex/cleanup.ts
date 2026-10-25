import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";

const BATCH = 200;

/**
 * Hourly (crons.ts): delete step counters older than the current and previous hour, and expired
 * pairing codes. Reschedules itself while a batch is full.
 */
export const run = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const hour = Math.floor(now / 3_600_000);
    const steps = await ctx.db
      .query("stepCounts")
      .withIndex("by_hour", (q) => q.lt("hour", hour - 1))
      .take(BATCH);
    const codes = await ctx.db
      .query("pairingCodes")
      .withIndex("by_expiresAt", (q) => q.lte("expiresAt", now))
      .take(BATCH);
    for (const r of steps) await ctx.db.delete(r._id);
    for (const r of codes) await ctx.db.delete(r._id);
    if (steps.length === BATCH || codes.length === BATCH) {
      await ctx.scheduler.runAfter(0, internal.cleanup.run, {});
    }
    return null;
  },
});
