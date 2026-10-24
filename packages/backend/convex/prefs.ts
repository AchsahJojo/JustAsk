import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { prefsOf, requireDevice } from "./lib";
import { consentValidator, voiceKind } from "./validators";

const prefsShape = v.object({
  displayName: v.string(),
  voice: voiceKind,
  rate: v.number(),
  showMeInstead: v.boolean(),
  consent: consentValidator,
});

/**
 * Her synced preferences (voice, speech rate, Show me instead, consent), with defaults.
 * `showMeInstead` is kept for compatibility (the caregiver app reads and sets it); it no longer
 * changes behavior, because JustAsk always shows her each step and she does it herself.
 */
export const get = query({
  args: { token: v.string() },
  returns: prefsShape,
  handler: async (ctx, { token }) => {
    const device = await requireDevice(ctx, token);
    const senior = await ctx.db.get(device.seniorId);
    if (!senior) throw new Error("not paired");
    return prefsOf(senior);
  },
});

/** Update any subset of her preferences. `rate` must be 0.5–1.5. Returns the new preferences. */
export const set = mutation({
  args: {
    token: v.string(),
    voice: v.optional(voiceKind),
    rate: v.optional(v.number()),
    consent: v.optional(consentValidator),
    showMeInstead: v.optional(v.boolean()),
  },
  returns: prefsShape,
  handler: async (ctx, { token, voice, rate, consent, showMeInstead }) => {
    const device = await requireDevice(ctx, token);
    const senior = await ctx.db.get(device.seniorId);
    if (!senior) throw new Error("not paired");
    if (rate !== undefined && !(Number.isFinite(rate) && rate >= 0.5 && rate <= 1.5)) {
      throw new Error("rate must be between 0.5 and 1.5");
    }
    const cur = prefsOf(senior);
    const prefs = {
      voice: voice ?? cur.voice,
      rate: rate ?? cur.rate,
      showMeInstead: showMeInstead ?? cur.showMeInstead,
    };
    await ctx.db.patch(senior._id, { prefs, ...(consent ? { consent } : {}), ...(showMeInstead !== undefined ? { showMeSetBy: "self" as const } : {}) });
    return { ...prefs, displayName: senior.displayName, consent: consent ?? senior.consent };
  },
});
