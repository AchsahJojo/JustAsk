import { ConvexError, v } from "convex/values";
import { mutation } from "./_generated/server";
import { cleanDevice, cleanDisplayName, DEFAULT_PREFS, insertDevice } from "./lib";
import { rateLimiter, TOO_MANY_TRIES } from "./rateLimits";
import { deviceInfo } from "./validators";

/**
 * First install: "Create my JustAsk". Creates the user's account (a `seniors` row, createdBy "self")
 * and this install's device. Returns the device token once; only its hash is stored.
 * Abuse guard: length checks plus a global creation rate limit.
 */
export const createSelf = mutation({
  args: { displayName: v.string(), device: deviceInfo },
  returns: v.object({ token: v.string(), displayName: v.string() }),
  handler: async (ctx, args) => {
    const displayName = cleanDisplayName(args.displayName);
    const fields = cleanDevice(args.device);
    const { ok } = await rateLimiter.limit(ctx, "createSelf");
    if (!ok) throw new ConvexError(TOO_MANY_TRIES);
    const seniorId = await ctx.db.insert("seniors", {
      name: displayName,
      displayName,
      consent: { notifyOnComplete: false, notifyOnStuck: false },
      prefs: { ...DEFAULT_PREFS },
      createdBy: "self",
    });
    const { token } = await insertDevice(ctx, seniorId, fields);
    return { token, displayName };
  },
});
