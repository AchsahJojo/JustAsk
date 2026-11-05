import { v } from "convex/values";
import { EventType } from "@justask/shared";
import { mutation } from "./_generated/server";
import { findLink, requireDevice } from "./lib";

const EVENT_TYPES = new Set<string>(EventType.options);
/** Events that end a run. `deferred`: the user put it off (no code yet, or said no to a risky step). */
const ENDING = new Set(["done", "abandoned", "blocked", "loop", "deferred"]);

export const start = mutation({
  args: { token: v.string(), request: v.string(), taskId: v.optional(v.id("tasks")) },
  returns: v.id("sessions"),
  handler: async (ctx, { token, request, taskId }) => {
    const device = await requireDevice(ctx, token);
    // Only the user's own task can be attached: a session's events change the task's status.
    if (taskId) {
      const task = await ctx.db.get(taskId);
      if (!task || task.seniorId !== device.seniorId) throw new Error("not found");
      if (task.status === "pending" || task.status === "active") await ctx.db.patch(taskId, { touchedAt: Date.now() });
    }
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
    // A known kind only, so a device can't fill the table with made-up strings.
    if (!EVENT_TYPES.has(type)) return null;
    // A run that already ended takes no more outcomes (late or repeated calls). A stuck press still counts
    // right after a loop, since the extension may send `loop` before the `stuck` that explains it.
    if (session.endedAt && (ENDING.has(type) || (type === "stuck" && session.outcome !== "loop"))) return null;
    const now = Date.now();
    await ctx.db.insert("events", { sessionId, type, at: now, latencyMs });
    // `loop`: JustAsk stopped because the same step or question kept coming back. A stuck-type loop
    // also sends `stuck` first, which is what tells the caregiver; a "not yet" loop doesn't.
    const ending = ENDING.has(type);
    if (ending) await ctx.db.patch(sessionId, { endedAt: now, outcome: type });

    if (!session.taskId) return null;
    const task = await ctx.db.get(session.taskId);
    if (!task) return null;
    // A completed or explicitly dismissed task is terminal. Only an active run can finish it
    // or return it to pending.
    const wasActive = task.status === "active";
    if (wasActive) {
      if (type === "done") await ctx.db.patch(task._id, { status: "done", doneAt: now, touchedAt: now, lastOutcome: "done" });
      else if (ending) await ctx.db.patch(task._id, { status: "pending", touchedAt: now, lastOutcome: type });
      else await ctx.db.patch(task._id, { touchedAt: now });
    }

    // Stuck still counts on a task a loop just returned to pending, in case `loop` arrived first.
    const open = wasActive || (type === "stuck" && task.status === "pending");
    const tells = type === "done" || type === "blocked" || (type === "stuck" && !session.notifiedStuck);
    if (!open || !tells) return null;
    const senior = await ctx.db.get(session.seniorId);
    if (!senior) return null;
    const allowed = type === "done" ? senior.consent.notifyOnComplete : senior.consent.notifyOnStuck;
    // Only a helper the user is still connected to hears about it.
    if (!allowed || !(await findLink(ctx, task.assignedBy, senior._id))) return null;
    const text =
      type === "done"
        ? `${senior.displayName} finished "${task.title}" and did every step themselves.`
        : type === "blocked"
          ? `JustAsk paused "${task.title}" for ${senior.displayName}. It's back on their list.`
          : `${senior.displayName} got stuck on "${task.title}".`;
    await ctx.db.insert("notifications", { toCaregiverId: task.assignedBy, seniorId: senior._id, text, at: now, read: false });
    if (type === "stuck") await ctx.db.patch(sessionId, { notifiedStuck: true });
    return null;
  },
});
