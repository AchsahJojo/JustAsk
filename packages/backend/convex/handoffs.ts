import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, mutation, query } from "./_generated/server";
import { kindOf, requireDevice } from "./lib";
import { deviceKind, recipeValidator } from "./validators";

/**
 * Handoffs move one session between the extension and the desktop app on the same machine
 * (ARCHITECTURE.md §9). They carry only request, taskId, recipe and a fixed note. Never page content.
 */

export const HANDOFF_TTL_MS = 10 * 60 * 1000;
const NOTES = {
  extension: "Continuing from your web browser.",
  desktop: "Continuing from the JustAsk app.",
} as const;

/** Handoffs are restricted to the same machine; an unknown machineId cannot be verified. */
function machineMatches(h: Doc<"handoffs">, device: Doc<"devices">) {
  return h.toMachineId !== undefined && device.machineId !== undefined && h.toMachineId === device.machineId;
}

/** Hand the current request to her other surface. Expires in 10 minutes. */
export const create = mutation({
  args: { token: v.string(), toKind: deviceKind, request: v.string(), taskId: v.optional(v.id("tasks")), recipe: v.optional(recipeValidator) },
  returns: v.object({ handoffId: v.id("handoffs") }),
  handler: async (ctx, { token, toKind, request, taskId, recipe }) => {
    const device = await requireDevice(ctx, token);
    if (taskId) {
      const task = await ctx.db.get(taskId);
      if (!task || task.seniorId !== device.seniorId) throw new Error("not found");
    }
    if (recipe && (recipe.steps.length > 30 || recipe.steps.some((s) => s.length > 300) || (recipe.startUrl?.length ?? 0) > 2000)) {
      throw new Error("recipe too large");
    }
    const now = Date.now();
    const expiresAt = now + HANDOFF_TTL_MS;
    const handoffId = await ctx.db.insert("handoffs", {
      seniorId: device.seniorId,
      fromDeviceId: device._id,
      toKind,
      ...(device.machineId !== undefined ? { toMachineId: device.machineId } : {}),
      request: request.slice(0, 200),
      ...(taskId ? { taskId } : {}),
      ...(recipe ? { recipe } : {}),
      note: NOTES[kindOf(device)],
      createdAt: now,
      expiresAt,
    });
    // Deleting at expiry also refreshes live `pendingForDevice` subscriptions.
    await ctx.scheduler.runAt(expiresAt, internal.handoffs.expire, { handoffId });
    return { handoffId };
  },
});

/** The receiving install takes the handoff. Single claim; `null` if gone, expired, claimed or not for this install. */
export const claim = mutation({
  args: { token: v.string(), handoffId: v.id("handoffs") },
  returns: v.union(
    v.object({ request: v.string(), taskId: v.union(v.id("tasks"), v.null()), recipe: v.union(recipeValidator, v.null()) }),
    v.null(),
  ),
  handler: async (ctx, { token, handoffId }) => {
    const device = await requireDevice(ctx, token);
    const h = await ctx.db.get(handoffId);
    if (!h || h.seniorId !== device.seniorId) return null;
    if (h.claimedAt !== undefined || h.expiresAt <= Date.now()) return null;
    if (h.toKind !== kindOf(device) || !machineMatches(h, device)) return null;
    await ctx.db.patch(handoffId, { claimedByDeviceId: device._id, claimedAt: Date.now() });
    return { request: h.request, taskId: h.taskId ?? null, recipe: h.recipe ?? null };
  },
});

/** Live query: unclaimed, unexpired handoffs for this install's kind (and machine, when known). */
export const pendingForDevice = query({
  args: { token: v.string() },
  returns: v.array(
    v.object({
      handoffId: v.id("handoffs"),
      request: v.string(),
      taskId: v.union(v.id("tasks"), v.null()),
      recipe: v.union(recipeValidator, v.null()),
      note: v.string(),
      createdAt: v.number(),
      expiresAt: v.number(),
    }),
  ),
  handler: async (ctx, { token }) => {
    const device = await requireDevice(ctx, token);
    const now = Date.now();
    const rows = await ctx.db
      .query("handoffs")
      .withIndex("by_senior_and_toKind_and_expiresAt", (q) =>
        q.eq("seniorId", device.seniorId).eq("toKind", kindOf(device)).gt("expiresAt", now).lte("expiresAt", now + HANDOFF_TTL_MS + 60_000),
      )
      .take(20);
    return rows
      .filter((h) => h.claimedAt === undefined && machineMatches(h, device))
      .map((h) => ({
        handoffId: h._id,
        request: h.request,
        taskId: h.taskId ?? null,
        recipe: h.recipe ?? null,
        note: h.note,
        createdAt: h.createdAt,
        expiresAt: h.expiresAt,
      }));
  },
});

/** Scheduled at creation for the expiry time. */
export const expire = internalMutation({
  args: { handoffId: v.id("handoffs") },
  returns: v.null(),
  handler: async (ctx, { handoffId }) => {
    const h = await ctx.db.get(handoffId);
    if (h) await ctx.db.delete(handoffId);
    return null;
  },
});
