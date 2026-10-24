import { internalMutation } from "./_generated/server";

/** One-off: drop the old `tokenIdentifier` from caregiver rows made before Convex Auth. */
export const caregiversToAuth = internalMutation({
  args: {},
  handler: async (ctx) => {
    let n = 0;
    for (const cg of await ctx.db.query("caregivers").collect()) {
      if (cg.tokenIdentifier === undefined) continue;
      await ctx.db.patch(cg._id, { tokenIdentifier: undefined });
      n++;
    }
    return { updated: n };
  },
});
