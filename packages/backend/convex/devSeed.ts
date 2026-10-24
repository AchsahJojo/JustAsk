import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

/**
 * Dev-only seed: a caregiver, a senior, a pairing code and a task with a recipe.
 * Internal, so it can only be run from the CLI: `npx convex run devSeed:seed`.
 */
export const seed = internalMutation({
  args: { code: v.optional(v.string()), startUrl: v.optional(v.string()) },
  handler: async (ctx, { code, startUrl }) => {
    const caregiverId = await ctx.db.insert("caregivers", { name: "Sam" });
    const seniorId = await ctx.db.insert("seniors", { name: "Margaret Hill", displayName: "Mom", consent: { notifyOnComplete: true, notifyOnStuck: false }, createdBy: "caregiver", createdAt: Date.now() });
    await ctx.db.insert("careLinks", { caregiverId, seniorId, relation: "son", linkedAt: Date.now() });
    const pairing = code ?? String(100000 + Math.floor(Math.random() * 900000));
    await ctx.db.insert("pairingCodes", { seniorId, code: pairing, expiresAt: Date.now() + 15 * 60 * 1000 });
    const taskId = await ctx.db.insert("tasks", {
      seniorId,
      assignedBy: caregiverId,
      title: "Refill your prescription",
      spokenPrompt: "help me refill my prescription",
      recipe: { startUrl: startUrl ?? "http://localhost:5174/", steps: ["Click Refill a prescription", "Click Refill next to Lisinopril", "Choose pick up in store", "Send the refill request"] },
      status: "pending",
      createdAt: Date.now(),
    });
    return { code: pairing, seniorId, taskId, caregiverId };
  },
});

export const notifications = internalMutation({
  args: {},
  handler: async (ctx) => ctx.db.query("notifications").collect(),
});
