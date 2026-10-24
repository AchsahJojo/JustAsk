import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { requireDevice } from "./lib";

export const start = mutation({
  args: { token: v.string(), request: v.string(), taskId: v.optional(v.id("tasks")) },
  returns: v.id("sessions"),
  handler: async (ctx, { token, request, taskId }) => {
    const device = await requireDevice(ctx, token);
    return ctx.db.insert("sessions", { seniorId: device.seniorId, deviceId: device._id, taskId, request: request.slice(0, 200), startedAt: Date.now() });
  },
});

/** Outcome events only. Never page content. */
export const logEvent = mutation({
  args: { token: v.string(), sessionId: v.id("sessions"), type: v.string(), latencyMs: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { token, sessionId, type, latencyMs }) => {
    const device = await requireDevice(ctx, token);
    const session = await ctx.db.get(sessionId);
    if (!session || session.seniorId !== device.seniorId) throw new Error("not found");
    await ctx.db.insert("events", { sessionId, type, at: Date.now(), latencyMs });
    const ending = ["done", "abandoned", "blocked"].includes(type);
    if (ending && !session.endedAt) await ctx.db.patch(sessionId, { endedAt: Date.now(), outcome: type });

    if (session.taskId && (type === "done" || type === "stuck")) {
      const task = await ctx.db.get(session.taskId);
      const senior = await ctx.db.get(session.seniorId);
      if (task && senior) {
        if (type === "done") await ctx.db.patch(task._id, { status: "done" });
        const allowed = type === "done" ? senior.consent.notifyOnComplete : senior.consent.notifyOnStuck;
        if (allowed) {
          const text = type === "done" ? `${senior.displayName} finished "${task.title}" on their own.` : `${senior.displayName} got stuck on "${task.title}".`;
          await ctx.db.insert("notifications", { toCaregiverId: task.assignedBy, text, at: Date.now(), read: false });
        }
      }
    }
    return null;
  },
});
