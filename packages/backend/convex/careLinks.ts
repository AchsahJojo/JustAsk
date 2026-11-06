import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { CODE_TTL_MS, findLiveCode, newCode, requireCaregiver, requireDevice } from "./lib";
import { assertCodeAttemptAllowed, normalizeCode, rateLimiter, recordCodeFailure, TOO_MANY_TRIES } from "./rateLimits";

/**
 * Caregiver linking (ARCHITECTURE.md §8).
 * 1. The user's install calls `careLinks:createHelperCode({token})` and shows the code.
 * 2. The caregiver, signed in to the web app (Convex Auth, with a `caregivers` row for their
 *    tokenIdentifier), calls `careLinks:redeemHelperCode({code, relation?})`. The link waits.
 * 3. The user's install shows "Let Sam help you?" (`devices:me` → `pendingHelpers`) and calls `careLinks:respond`.
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

/** Someone can help up to this many people (counting links still waiting for a yes). */
const MAX_SENIORS_PER_CAREGIVER = 20;
/** A helper link the user hasn't answered is dropped after this long (cleanup cron). */
export const PENDING_LINK_MS = 24 * 60 * 60 * 1000;

/**
 * Caregiver web app (signed in): redeem a helper code. The link waits (`pendingSince`) until the user says
 * yes on their computer (`careLinks:respond`), so someone who talked them into reading the code out
 * can't become a helper without them seeing it. Returns `{seniorId, displayName, pending}`, or `null`
 * for a wrong or expired code (no throw, so the failure counts against the rate limit). Throws
 * "not signed in" / "no caregiver profile" / "Too many tries...". Redeeming for someone you are already
 * linked to changes nothing.
 */
export const redeemHelperCode = mutation({
  args: { code: v.string(), relation: v.optional(v.string()) },
  returns: v.union(v.object({ seniorId: v.id("seniors"), displayName: v.string(), pending: v.boolean() }), v.null()),
  handler: async (ctx, args) => {
    const cg = await requireCaregiver(ctx);
    const code = normalizeCode(args.code);
    if (!code) return null;
    const relation = (args.relation ?? "").trim().slice(0, 40);
    const mine = await rateLimiter.check(ctx, "helperFailCaregiver", { key: cg._id });
    if (!mine.ok) throw new ConvexError(TOO_MANY_TRIES);
    await assertCodeAttemptAllowed(ctx, code, { signedIn: true });
    const row = await findLiveCode(ctx, code, "caregiver");
    if (!row) {
      await rateLimiter.limit(ctx, "helperFailCaregiver", { key: cg._id });
      await recordCodeFailure(ctx, code, { signedIn: true });
      return null;
    }
    const existing = await ctx.db
      .query("careLinks")
      .withIndex("by_caregiver_and_senior", (q) => q.eq("caregiverId", cg._id).eq("seniorId", row.seniorId))
      .first();
    if (!existing) {
      const links = await ctx.db.query("careLinks").withIndex("by_caregiver", (q) => q.eq("caregiverId", cg._id)).take(MAX_SENIORS_PER_CAREGIVER);
      if (links.length >= MAX_SENIORS_PER_CAREGIVER) throw new ConvexError(`You can help up to ${MAX_SENIORS_PER_CAREGIVER} people.`);
    }
    await ctx.db.delete(row._id);
    let pending = true;
    if (!existing) await ctx.db.insert("careLinks", { caregiverId: cg._id, seniorId: row.seniorId, relation, pendingSince: Date.now() });
    else pending = existing.pendingSince !== undefined;
    const senior = await ctx.db.get(row.seniorId);
    return { seniorId: row.seniorId, displayName: senior?.displayName ?? "", pending };
  },
});

/** Caregiver: people whose helper code they typed, still waiting for a yes. The page flips when the user answers. */
export const pendingForMe = query({
  args: {},
  returns: v.array(v.object({ seniorId: v.id("seniors"), displayName: v.string() })),
  handler: async (ctx) => {
    const cg = await requireCaregiver(ctx);
    const links = await ctx.db.query("careLinks").withIndex("by_caregiver", (q) => q.eq("caregiverId", cg._id)).take(MAX_SENIORS_PER_CAREGIVER);
    const rows = await Promise.all(
      links
        .filter((l) => l.pendingSince !== undefined)
        .map(async (l) => ({ seniorId: l.seniorId, displayName: (await ctx.db.get(l.seniorId))?.displayName ?? "" })),
    );
    return rows;
  },
});

/** The user's install: yes or no to someone who typed their helper code. No deletes the waiting link. */
export const respond = mutation({
  args: { token: v.string(), caregiverId: v.id("caregivers"), allow: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { token, caregiverId, allow }) => {
    const device = await requireDevice(ctx, token);
    const link = await ctx.db
      .query("careLinks")
      .withIndex("by_caregiver_and_senior", (q) => q.eq("caregiverId", caregiverId).eq("seniorId", device.seniorId))
      .first();
    if (!link || link.pendingSince === undefined) return null;
    if (allow) await ctx.db.patch(link._id, { pendingSince: undefined, linkedAt: Date.now() });
    else await ctx.db.delete(link._id);
    return null;
  },
});
