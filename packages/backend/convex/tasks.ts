import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { TASK_LIMITS, isSafeStartUrl } from "@justask/shared";
import { clean, requireCaregiver, requireDevice, requireLink } from "./lib";

/**
 * Caregiver: send a task. Only a draft that taskCheck:review said is clear can be sent, so a vague
 * task ("get the new book") never reaches the older adult. The draft is used as checked.
 */
export const assign = mutation({
  args: { seniorId: v.id("seniors"), checkId: v.id("taskChecks") },
  handler: async (ctx, { seniorId, checkId }) => {
    const { cg } = await requireLink(ctx, seniorId);
    const check = await ctx.db.get(checkId);
    if (!check || check.caregiverId !== cg._id || check.seniorId !== seniorId) throw new Error("Check the task again before sending it.");
    if (check.expiresAt <= Date.now()) throw new Error("That check is out of date. Check the task again before sending it.");
    const title = clean(check.title, TASK_LIMITS.title);
    const spokenPrompt = clean(check.spokenPrompt, TASK_LIMITS.spokenPrompt) || title;
    let r: { startUrl?: string; steps: string[] } | undefined;
    if (check.recipe) {
      const steps = check.recipe.steps.map((s) => clean(s, TASK_LIMITS.step)).filter(Boolean).slice(0, TASK_LIMITS.steps);
      const startUrl = check.recipe.startUrl?.trim();
      if (startUrl && (startUrl.length > TASK_LIMITS.startUrl || !isSafeStartUrl(startUrl))) throw new Error("The start page must be a web address that begins with https://");
      if (steps.length || startUrl) r = { ...(startUrl ? { startUrl } : {}), steps };
    }
    if (!title) throw new Error("Give the task a short name.");
    const pending = await ctx.db
      .query("tasks")
      .withIndex("by_senior_status", (q) => q.eq("seniorId", seniorId).eq("status", "pending"))
      .collect();
    if (pending.length >= 10) throw new Error("They already have 10 tasks waiting. Cancel one first.");
    await ctx.db.delete(checkId);
    return ctx.db.insert("tasks", { seniorId, title, spokenPrompt, ...(r ? { recipe: r } : {}), assignedBy: cg._id, status: "pending", createdAt: Date.now() });
  },
});

/** Caregiver: take back a task that hasn't been started. */
export const cancel = mutation({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const cg = await requireCaregiver(ctx);
    const task = await ctx.db.get(taskId);
    if (!task || task.assignedBy !== cg._id) throw new Error("not found");
    if (task.status !== "pending") throw new Error("They already started this task.");
    await ctx.db.delete(taskId);
  },
});

/** Extension: pending tasks for this device (polled by the background, subscribed by the panel). */
export const pendingForDevice = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const device = await requireDevice(ctx, token);
    const rows = await ctx.db
      .query("tasks")
      .withIndex("by_senior_status", (q) => q.eq("seniorId", device.seniorId).eq("status", "pending"))
      .take(100);
    return Promise.all(
      rows.map(async (t) => {
        const cg = await ctx.db.get(t.assignedBy);
        return { id: t._id, title: t.title, spokenPrompt: t.spokenPrompt, recipe: t.recipe ?? null, from: cg?.name ?? "Your helper" };
      }),
    );
  },
});

/**
 * Extension: the user's task list. Open tasks (waiting or started) stay until the user finishes or removes them,
 * so closing the panel never loses one. Plus what the user finished in the last two weeks.
 */
export const listForDevice = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const device = await requireDevice(ctx, token);
    const by = (status: "pending" | "active" | "done") =>
      ctx.db
        .query("tasks")
        .withIndex("by_senior_status", (q) => q.eq("seniorId", device.seniorId).eq("status", status))
        .collect();
    const [pending, active, done] = await Promise.all([by("pending"), by("active"), by("done")]);
    const names = new Map<string, string>();
    const row = async (t: (typeof pending)[number]) => {
      if (!names.has(t.assignedBy)) names.set(t.assignedBy, (await ctx.db.get(t.assignedBy))?.name ?? "Your helper");
      return { id: t._id, title: t.title, spokenPrompt: t.spokenPrompt, recipe: t.recipe ?? null, from: names.get(t.assignedBy)!, status: t.status, createdAt: t.createdAt };
    };
    const since = Date.now() - 14 * 86_400_000;
    return {
      open: await Promise.all([...active, ...pending].sort((a, b) => a.createdAt - b.createdAt).map(row)),
      done: await Promise.all(done.filter((t) => t.createdAt > since).sort((a, b) => b.createdAt - a.createdAt).slice(0, 10).map(row)),
    };
  },
});

export const setStatus = mutation({
  args: { token: v.string(), taskId: v.id("tasks"), status: v.union(v.literal("active"), v.literal("done"), v.literal("dismissed"), v.literal("pending")) },
  handler: async (ctx, { token, taskId, status }) => {
    const device = await requireDevice(ctx, token);
    const task = await ctx.db.get(taskId);
    if (!task || task.seniorId !== device.seniorId) throw new Error("not found");
    await ctx.db.patch(taskId, { status });
    // "I did it" from the user's task list: the same consent-gated note as finishing with JustAsk.
    if (status === "done" && task.status !== "done") {
      const senior = await ctx.db.get(device.seniorId);
      const linked = (await ctx.db.query("careLinks").withIndex("by_senior", (q) => q.eq("seniorId", device.seniorId)).collect()).some((l) => l.caregiverId === task.assignedBy);
      if (senior?.consent.notifyOnComplete && linked) {
        const who = senior.displayName || senior.name || "They";
        await ctx.db.insert("notifications", { toCaregiverId: task.assignedBy, seniorId: senior._id, text: `${who} finished "${task.title}".`, at: Date.now(), read: false });
      }
    }
  },
});
