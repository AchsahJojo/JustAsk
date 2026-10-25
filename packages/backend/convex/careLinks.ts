import { ConvexError, v } from "convex/values";
import { mutation } from "./_generated/server";
import { CODE_TTL_MS, findLiveCode, newCode, requireCaregiver, requireDevice } from "./lib";
import { assertCodeAttemptAllowed, normalizeCode, rateLimiter, recordCodeFailure, TOO_MANY_TRIES } from "./rateLimits";

/**
 * Caregiver linking (ARCHITECTURE.md §8).
 * 1. The user's install calls `careLinks:createHelperCode({token})` and shows the code.
 * 2. The caregiver, signed in to the web app (Convex Auth, with a `caregivers` row for their
 *    tokenIdentifier), calls `careLinks:redeemHelperCode({code, relation?})`.
 */

/** The user's install: a 6-digit helper code (single use, 15 minutes). */
export const createHelperCode = mutation({
  args: { token: v.string() },
  returns: v.object({ code: v.string(), expiresAt: v.number() }),
  handler: async (ctx, { token }) => {
    const device = await requireDevice(ctx, token);
    const code = await newCode(ctx);
    const expiresAt = Date.now() + CODE_TTL_MS;
    await ctx.db.insert("pairingCodes", { seniorId: device.seniorId, code, expiresAt, purpose: "caregiver", createdByDeviceId: device._id });
    return { code, expiresAt };
  },
});

/**
 * Caregiver web app (signed in): redeem a helper code and create the careLinks row.
 * Returns `{seniorId, displayName}`, or `null` for a wrong or expired code (no throw, so the
 * failure counts against the rate limit). Throws "not signed in" / "no caregiver profile" /
 * "Too many tries...". Redeeming for a senior you are already linked to is a no-op.
 */
export const redeemHelperCode = mutation({
  args: { code: v.string(), relation: v.optional(v.string()) },
  returns: v.union(v.object({ seniorId: v.id("seniors"), displayName: v.string() }), v.null()),
  handler: async (ctx, args) => {
    const cg = await requireCaregiver(ctx);
    const code = normalizeCode(args.code);
    if (!code) return null;
    const relation = (args.relation ?? "helper").trim().slice(0, 40) || "helper";
    const mine = await rateLimiter.check(ctx, "helperFailCaregiver", { key: cg._id });
    if (!mine.ok) throw new ConvexError(TOO_MANY_TRIES);
    await assertCodeAttemptAllowed(ctx, code);
    const row = await findLiveCode(ctx, code, "caregiver");
    if (!row) {
      await rateLimiter.limit(ctx, "helperFailCaregiver", { key: cg._id });
      await recordCodeFailure(ctx, code);
      return null;
    }
    await ctx.db.delete(row._id);
    const existing = await ctx.db
      .query("careLinks")
      .withIndex("by_caregiver_and_senior", (q) => q.eq("caregiverId", cg._id).eq("seniorId", row.seniorId))
      .first();
    if (!existing) {
      await ctx.db.insert("careLinks", { caregiverId: cg._id, seniorId: row.seniorId, relation });
    }
    const senior = await ctx.db.get(row.seniorId);
    return { seniorId: row.seniorId, displayName: senior?.displayName ?? "" };
  },
});
