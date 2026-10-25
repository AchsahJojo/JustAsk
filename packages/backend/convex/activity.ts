import { mutation, query } from "./_generated/server";
import { requireCaregiver } from "./lib";

/** Caregiver: completion notes, stuck notes and disconnects, newest first. Written only with the user's consent. */
export const feed = query({
  args: {},
  handler: async (ctx) => {
    const cg = await requireCaregiver(ctx);
    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_caregiver", (q) => q.eq("toCaregiverId", cg._id))
      .order("desc")
      .take(50);
    return rows.map((n) => ({ id: n._id, text: n.text, at: n.at, read: n.read, seniorId: n.seniorId ?? null }));
  },
});

export const markAllRead = mutation({
  args: {},
  handler: async (ctx) => {
    const cg = await requireCaregiver(ctx);
    const unread = await ctx.db
      .query("notifications")
      .withIndex("by_caregiver", (q) => q.eq("toCaregiverId", cg._id))
      .filter((q) => q.eq(q.field("read"), false))
      .collect();
    for (const n of unread) await ctx.db.patch(n._id, { read: true });
  },
});
