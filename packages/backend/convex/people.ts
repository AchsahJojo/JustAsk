import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { CaregiverTaskStatus } from "@justask/shared";
import { clean, prefsOf, requireCaregiver, requireLink, resolveSenior } from "./lib";

async function deviceCount(ctx: QueryCtx | MutationCtx, seniorId: Id<"seniors">) {
  return (await ctx.db.query("devices").withIndex("by_senior", (q) => q.eq("seniorId", seniorId)).collect()).filter((d) => d.revokedAt === undefined).length;
}

/** Without her consent to share results, a caregiver only sees that a task was sent. */
function statusFor(task: Doc<"tasks">, senior: Doc<"seniors">): CaregiverTaskStatus {
  if (!senior.consent.notifyOnComplete) return "sent";
  return task.status === "pending" ? "sent" : task.status === "active" ? "started" : task.status;
}

/** Caregiver: everyone they help, for the home screen. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const cg = await requireCaregiver(ctx);
    const links = await ctx.db.query("careLinks").withIndex("by_caregiver", (q) => q.eq("caregiverId", cg._id)).collect();
    const rows = await Promise.all(
      links.map(async (l) => {
        const s = await ctx.db.get(l.seniorId);
        if (!s) return null;
        const devices = await deviceCount(ctx, s._id);
        const tasks = await ctx.db.query("tasks").withIndex("by_assigner", (q) => q.eq("assignedBy", cg._id)).collect();
        const mine = tasks.filter((t) => t.seniorId === s._id);
        return {
          id: s._id,
          name: s.name || s.displayName,
          displayName: s.displayName,
          relation: l.relation,
          connected: devices > 0,
          waiting: mine.filter((t) => t.status === "pending").length,
          finished: s.consent.notifyOnComplete ? mine.filter((t) => t.status === "done").length : null,
          linkedAt: l.linkedAt ?? l._creationTime,
        };
      }),
    );
    return rows.filter((r) => r !== null).sort((a, b) => a.linkedAt - b.linkedAt);
  },
});

/** Caregiver: one person's page. Outcomes and counts only, never page content or what she asked for herself. */
export const get = query({
  args: { seniorId: v.id("seniors") },
  handler: async (ctx, { seniorId }) => {
    // Her own profile was kept when she connected: send the caregiver's page to it.
    const resolved = await resolveSenior(ctx, seniorId);
    if (resolved && resolved !== seniorId) {
      await requireLink(ctx, resolved);
      return { moved: true as const, movedTo: resolved };
    }
    const { cg, link } = await requireLink(ctx, seniorId);
    const s = await ctx.db.get(seniorId);
    if (!s) throw new Error("not your senior");
    const devices = await deviceCount(ctx, seniorId);
    const otherHelpers = (await ctx.db.query("careLinks").withIndex("by_senior", (q) => q.eq("seniorId", seniorId)).collect()).length - 1;
    const tasks = (await ctx.db.query("tasks").withIndex("by_assigner", (q) => q.eq("assignedBy", cg._id)).collect())
      .filter((t) => t.seniorId === seniorId && t.status !== "dismissed")
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 50);

    let stats: { finished: number; stuck: number | null; medianStepMs: number | null } | null = null;
    if (s.consent.notifyOnComplete) {
      // Sessions for tasks this caregiver sent. Sessions she started herself stay private.
      const myTaskIds = new Set(tasks.map((t) => t._id));
      const mineSessions = (await ctx.db.query("sessions").withIndex("by_senior", (q) => q.eq("seniorId", seniorId)).order("desc").take(200)).filter(
        (x) => x.taskId && myTaskIds.has(x.taskId),
      );
      const latencies: number[] = [];
      let stuck = 0;
      for (const x of mineSessions) {
        for (const e of await ctx.db.query("events").withIndex("by_session", (q) => q.eq("sessionId", x._id)).collect()) {
          if (e.type === "stuck") stuck++;
          if (e.type === "step_shown" && e.latencyMs !== undefined) latencies.push(e.latencyMs);
        }
      }
      latencies.sort((a, b) => a - b);
      stats = {
        finished: tasks.filter((t) => t.status === "done").length,
        stuck: s.consent.notifyOnStuck ? stuck : null,
        medianStepMs: latencies.length ? latencies[Math.floor(latencies.length / 2)] : null,
      };
    }

    return {
      moved: false as const,
      id: s._id,
      name: s.name || s.displayName,
      displayName: s.displayName,
      relation: link.relation,
      origin: s.createdBy ?? "caregiver",
      devices,
      otherHelpers,
      consent: s.consent,
      showMeInstead: prefsOf(s).showMeInstead,
      showMeSetBy: s.showMeSetBy ?? null,
      tasks: tasks.map((t) => ({ id: t._id, title: t.title, spokenPrompt: t.spokenPrompt, recipe: t.recipe ?? null, createdAt: t.createdAt, status: statusFor(t, s), canCancel: t.status === "pending" })),
      stats,
    };
  },
});

/** Caregiver: fix a name typo or the relation. What JustAsk calls her can only change before she connects. */
export const update = mutation({
  args: { seniorId: v.id("seniors"), name: v.string(), displayName: v.string(), relation: v.string() },
  handler: async (ctx, args) => {
    const { link } = await requireLink(ctx, args.seniorId);
    const name = clean(args.name, 60);
    if (!name) throw new Error("Add their name.");
    const connected = (await deviceCount(ctx, args.seniorId)) > 0;
    await ctx.db.patch(args.seniorId, { name, ...(connected ? {} : { displayName: clean(args.displayName, 40) || name.split(" ")[0] }) });
    await ctx.db.patch(link._id, { relation: clean(args.relation, 40) });
  },
});

/**
 * Caregiver: turn "Show me instead" on or off for someone they help. Kept for compatibility with the
 * caregiver app: the setting is still stored, but it no longer changes behavior. JustAsk always shows
 * her each step and she does it herself.
 */
export const setShowMe = mutation({
  args: { seniorId: v.id("seniors"), on: v.boolean() },
  handler: async (ctx, { seniorId, on }) => {
    await requireLink(ctx, seniorId);
    const s = await ctx.db.get(seniorId);
    if (!s) throw new Error("not your senior");
    const { voice, rate } = prefsOf(s);
    await ctx.db.patch(seniorId, { prefs: { voice, rate, showMeInstead: on }, showMeSetBy: "caregiver" });
  },
});

/**
 * Caregiver: stop helping someone. Her JustAsk keeps working on its own. A profile that was never
 * connected to a computer and has no other helper is deleted outright.
 */
export const remove = mutation({
  args: { seniorId: v.id("seniors") },
  handler: async (ctx, { seniorId }) => {
    // Her own profile was kept when she connected: send the caregiver's page to it.
    const resolved = await resolveSenior(ctx, seniorId);
    if (resolved && resolved !== seniorId) {
      await requireLink(ctx, resolved);
      return { moved: true as const, movedTo: resolved };
    }
    const { cg, link } = await requireLink(ctx, seniorId);
    await ctx.db.delete(link._id);
    for (const t of await ctx.db.query("tasks").withIndex("by_senior_status", (q) => q.eq("seniorId", seniorId).eq("status", "pending")).collect()) {
      if (t.assignedBy === cg._id) await ctx.db.delete(t._id);
    }
    const devices = await ctx.db.query("devices").withIndex("by_senior", (q) => q.eq("seniorId", seniorId)).first();
    const others = await ctx.db.query("careLinks").withIndex("by_senior", (q) => q.eq("seniorId", seniorId)).first();
    if (!devices && !others) {
      for (const c of await ctx.db.query("pairingCodes").withIndex("by_senior", (q) => q.eq("seniorId", seniorId)).collect()) await ctx.db.delete(c._id);
      for (const status of ["pending", "active", "done", "dismissed"] as const) {
        for (const t of await ctx.db.query("tasks").withIndex("by_senior_status", (q) => q.eq("seniorId", seniorId).eq("status", status)).collect()) await ctx.db.delete(t._id);
      }
      await ctx.db.delete(seniorId);
    }
  },
});
