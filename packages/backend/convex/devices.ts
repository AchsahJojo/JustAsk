import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { requireCaregiver, requireDevice, sha256, STEPS_PER_HOUR } from "./lib";

const CODE_TTL_MS = 15 * 60 * 1000;

/** Caregiver: create a senior profile and a 6-digit pairing code. */
export const createSeniorWithCode = mutation({
  args: { name: v.string(), displayName: v.string(), relation: v.string() },
  handler: async (ctx, args) => {
    const cg = await requireCaregiver(ctx);
    const seniorId = await ctx.db.insert("seniors", {
      name: args.name,
      displayName: args.displayName,
      consent: { notifyOnComplete: false, notifyOnStuck: false },
    });
    await ctx.db.insert("careLinks", { caregiverId: cg._id, seniorId, relation: args.relation });
    const code = String(100000 + Math.floor(Math.random() * 900000));
    await ctx.db.insert("pairingCodes", { seniorId, code, expiresAt: Date.now() + CODE_TTL_MS });
    return { seniorId, code };
  },
});

/** Extension: redeem the 6-digit code once. Returns a device token; only its hash is stored. */
export const redeemCode = mutation({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const row = await ctx.db
      .query("pairingCodes")
      .withIndex("by_code", (q) => q.eq("code", code.trim()))
      .unique();
    if (!row || row.expiresAt < Date.now()) throw new Error("That code didn't work. Ask for a new one.");
    await ctx.db.delete(row._id);
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    await ctx.db.insert("devices", { seniorId: row.seniorId, tokenHash: await sha256(token), pairedAt: Date.now() });
    const senior = await ctx.db.get(row.seniorId);
    return { token, displayName: senior?.displayName ?? "" };
  },
});

export const me = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const device = await requireDevice(ctx, token);
    const senior = await ctx.db.get(device.seniorId);
    return senior && { displayName: senior.displayName, consent: senior.consent };
  },
});

export const setConsent = mutation({
  args: { token: v.string(), notifyOnComplete: v.boolean(), notifyOnStuck: v.boolean() },
  handler: async (ctx, { token, ...consent }) => {
    const device = await requireDevice(ctx, token);
    await ctx.db.patch(device.seniorId, { consent });
  },
});

/** Called by the plan action before every Claude call. Throws past the hourly budget. */
export const consumeStep = internalMutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const device = await requireDevice(ctx, token);
    const hour = Math.floor(Date.now() / 3_600_000);
    const row = await ctx.db
      .query("stepCounts")
      .withIndex("by_device_hour", (q) => q.eq("deviceId", device._id).eq("hour", hour))
      .unique();
    if (row && row.count >= STEPS_PER_HOUR) throw new Error("rate limited");
    if (row) await ctx.db.patch(row._id, { count: row.count + 1 });
    else await ctx.db.insert("stepCounts", { deviceId: device._id, hour, count: 1 });
  },
});
