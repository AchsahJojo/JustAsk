import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireCaregiver, requireDevice } from "./lib";

const recipe = v.optional(v.object({ startUrl: v.optional(v.string()), steps: v.array(v.string()) }));

/** Caregiver: assign a task, optionally with a recipe. */
export const assign = mutation({
  args: { seniorId: v.id("seniors"), title: v.string(), spokenPrompt: v.string(), recipe },
  handler: async (ctx, args) => {
    const cg = await requireCaregiver(ctx);
    const link = await ctx.db
      .query("careLinks")
      .withIndex("by_caregiver", (q) => q.eq("caregiverId", cg._id))
      .filter((q) => q.eq(q.field("seniorId"), args.seniorId))
      .first();
    if (!link) throw new Error("not your senior");
    return ctx.db.insert("tasks", { ...args, assignedBy: cg._id, status: "pending", createdAt: Date.now() });
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

export const setStatus = mutation({
  args: { token: v.string(), taskId: v.id("tasks"), status: v.union(v.literal("active"), v.literal("done"), v.literal("dismissed"), v.literal("pending")) },
  handler: async (ctx, { token, taskId, status }) => {
    const device = await requireDevice(ctx, token);
    const task = await ctx.db.get(taskId);
    if (!task || task.seniorId !== device.seniorId) throw new Error("not found");
    await ctx.db.patch(taskId, { status });
  },
});
