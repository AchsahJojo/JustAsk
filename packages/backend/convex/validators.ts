import { v } from "convex/values";

/** Shared validators for the schema and function args. */
export const deviceKind = v.literal("extension");
export const voiceKind = v.union(v.literal("browser"), v.literal("cartesia"));
export const recipeValidator = v.object({ startUrl: v.optional(v.string()), steps: v.array(v.string()) });
export const consentValidator = v.object({ notifyOnComplete: v.boolean(), notifyOnStuck: v.boolean() });

/** What an install says about itself when it joins: `{kind, platform, label}`. */
export const deviceInfo = v.object({
  kind: deviceKind,
  platform: v.string(),
  label: v.string(),
});
