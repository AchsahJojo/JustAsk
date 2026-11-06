import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { PENDING_LINK_MS } from "./careLinks";
import { refuseJoin } from "./devices";

const BATCH = 200;
/** A computer waiting for Allow is turned away after a day. */
export const PENDING_DEVICE_MS = 24 * 60 * 60 * 1000;
/** A task "active" this long with no word from its run goes back to the list (the browser closed mid-task). */
export const STALE_TASK_MS = 2 * 60 * 60 * 1000;

/**
 * Hourly (crons.ts): delete step counters older than the current and previous hour, expired
 * pairing codes, expired handoffs and expired task checks. Handoffs are also deleted by a scheduled function at
 * expiry; this catches any that were missed. Also: helper links and computers nobody said yes to within a day,
 * and started tasks that went quiet (back to pending). Reschedules itself while a batch is full.
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
    const handoffs = await ctx.db
      .query("handoffs")
      .withIndex("by_expiresAt", (q) => q.lte("expiresAt", now))
      .take(BATCH);
    const checks = await ctx.db
      .query("taskChecks")
      .withIndex("by_expiresAt", (q) => q.lte("expiresAt", now))
      .take(BATCH);
    // `gt(0)` skips rows with no pendingSince (undefined sorts first in an index).
    const links = await ctx.db
      .query("careLinks")
      .withIndex("by_pendingSince", (q) => q.gt("pendingSince", 0).lte("pendingSince", now - PENDING_LINK_MS))
      .take(BATCH);
    const joins = await ctx.db
      .query("devices")
      .withIndex("by_pendingSince", (q) => q.gt("pendingSince", 0).lte("pendingSince", now - PENDING_DEVICE_MS))
      .take(BATCH);
    // Rows from before `touchedAt` existed sort first and count as quiet.
    const quiet = await ctx.db
      .query("tasks")
      .withIndex("by_status_and_touchedAt", (q) => q.eq("status", "active").lte("touchedAt", now - STALE_TASK_MS))
      .take(BATCH);
    for (const r of links) await ctx.db.delete(r._id);
    for (const r of joins) await refuseJoin(ctx, r);
    for (const r of quiet) await ctx.db.patch(r._id, { status: "pending", touchedAt: now, lastOutcome: "abandoned" });
    for (const r of checks) await ctx.db.delete(r._id);
    for (const r of steps) await ctx.db.delete(r._id);
    for (const r of codes) await ctx.db.delete(r._id);
    for (const r of handoffs) await ctx.db.delete(r._id);
    if ([steps, codes, handoffs, checks, links, joins, quiet].some((b) => b.length === BATCH)) {
      await ctx.scheduler.runAfter(0, internal.cleanup.run, {});
    }
    return null;
  },
});
