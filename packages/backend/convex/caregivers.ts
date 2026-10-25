import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query } from "./_generated/server";
import { clean, currentCaregiver, requireCaregiver } from "./lib";

/** The signed-in caregiver's profile, or null before `ensureProfile` has run. */
export const me = query({
  args: {},
  handler: async (ctx) => {
    const cg = await currentCaregiver(ctx);
    return cg && { id: cg._id, name: cg.name, email: cg.email ?? "" };
  },
});

/** Create the caregiver row on first sign-in. Safe to call on every sign-in. */
export const ensureProfile = mutation({
  args: { name: v.optional(v.string()) },
  handler: async (ctx, { name }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("not signed in");
    const existing = await ctx.db
      .query("caregivers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (existing) return existing._id;
    const user = await ctx.db.get(userId);
    const email = user?.email ?? undefined;
    const n = clean(name ?? user?.name ?? "", 60) || (email ? email.split("@")[0] : "Helper");
    return ctx.db.insert("caregivers", { userId, name: n, ...(email ? { email } : {}) });
  },
});

/** The name seniors see on tasks ("Sam sent you a task"). */
export const rename = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const cg = await requireCaregiver(ctx);
    const n = clean(name, 60);
    if (!n) throw new ConvexError("Add your name.");
    await ctx.db.patch(cg._id, { name: n });
  },
});
