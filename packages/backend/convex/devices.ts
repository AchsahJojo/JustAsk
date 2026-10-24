import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import {
  CODE_TTL_MS,
  cleanDevice,
  findLiveCode,
  insertDevice,
  kindOf,
  newCode,
  requireCaregiver,
  requireDevice,
  STEPS_PER_HOUR,
} from "./lib";
import { assertCodeAttemptAllowed, normalizeCode, recordCodeFailure } from "./rateLimits";
import { consentValidator, deviceInfo, deviceKind } from "./validators";

const HEARTBEAT_MIN_MS = 60 * 1000;

/** Caregiver: create a senior profile and a 6-digit pairing code. */
export const createSeniorWithCode = mutation({
  args: { name: v.string(), displayName: v.string(), relation: v.string() },
  returns: v.object({ seniorId: v.id("seniors"), code: v.string() }),
  handler: async (ctx, args) => {
    const cg = await requireCaregiver(ctx);
    const seniorId = await ctx.db.insert("seniors", {
      name: args.name,
      displayName: args.displayName,
      consent: { notifyOnComplete: false, notifyOnStuck: false },
      createdBy: "caregiver",
    });
    await ctx.db.insert("careLinks", { caregiverId: cg._id, seniorId, relation: args.relation });
    const code = await newCode(ctx);
    await ctx.db.insert("pairingCodes", { seniorId, code, expiresAt: Date.now() + CODE_TTL_MS, purpose: "device" });
    return { seniorId, code };
  },
});

/**
 * A linked install: "Add another device". A 6-digit code, single use, 15 minutes.
 * Records the creating device and its machineId (used for desktop-to-browser linking).
 */
export const createLinkCode = mutation({
  args: { token: v.string() },
  returns: v.object({ code: v.string(), expiresAt: v.number() }),
  handler: async (ctx, { token }) => {
    const device = await requireDevice(ctx, token);
    const code = await newCode(ctx);
    const expiresAt = Date.now() + CODE_TTL_MS;
    await ctx.db.insert("pairingCodes", {
      seniorId: device.seniorId,
      code,
      expiresAt,
      purpose: "device",
      createdByDeviceId: device._id,
      ...(device.machineId !== undefined ? { machineId: device.machineId } : {}),
    });
    return { code, expiresAt };
  },
});

/**
 * Before linking: "Link to Margaret's JustAsk?". Returns the account's display name for a live
 * device code, without consuming it. Wrong codes count against the same rate limit as redeem.
 * A mutation (not a query) so failed peeks can be recorded.
 */
export const peekCode = mutation({
  args: { code: v.string() },
  returns: v.union(v.object({ displayName: v.string() }), v.null()),
  handler: async (ctx, args) => {
    const code = normalizeCode(args.code);
    if (!code) return null;
    await assertCodeAttemptAllowed(ctx, code);
    const row = await findLiveCode(ctx, code, "device");
    if (!row) {
      await recordCodeFailure(ctx, code);
      return null;
    }
    const senior = await ctx.db.get(row.seniorId);
    return { displayName: senior?.displayName ?? "" };
  },
});

/**
 * A new install: redeem a device code once. Returns a device token (only its hash is stored),
 * or `null` for a wrong or expired code. Wrong codes return null instead of throwing so the
 * failure is recorded. Throws only while rate limited ("Too many tries...").
 * The new device inherits the code's machineId when the code was made on a desktop install
 * (the desktop opens the link page in browsers on the same machine).
 */
export const redeemCode = mutation({
  args: { code: v.string(), device: v.optional(deviceInfo) },
  returns: v.union(v.object({ token: v.string(), displayName: v.string() }), v.null()),
  handler: async (ctx, args) => {
    const code = normalizeCode(args.code);
    if (!code) return null;
    const fields: { kind?: "extension" | "desktop"; platform?: string; label?: string; machineId?: string } = args.device ? cleanDevice(args.device) : {};
    await assertCodeAttemptAllowed(ctx, code);
    const row = await findLiveCode(ctx, code, "device");
    if (!row) {
      await recordCodeFailure(ctx, code);
      return null;
    }
    await ctx.db.delete(row._id);
    let machineId = fields.machineId;
    if (machineId === undefined && row.machineId !== undefined && row.createdByDeviceId) {
      const creator = await ctx.db.get(row.createdByDeviceId);
      if (creator && kindOf(creator) === "desktop") machineId = row.machineId;
    }
    const { token } = await insertDevice(ctx, row.seniorId, { ...fields, ...(machineId !== undefined ? { machineId } : {}) });
    const senior = await ctx.db.get(row.seniorId);
    return { token, displayName: senior?.displayName ?? "" };
  },
});

export const me = query({
  args: { token: v.string() },
  returns: v.union(v.object({ displayName: v.string(), consent: consentValidator }), v.null()),
  handler: async (ctx, { token }) => {
    const device = await requireDevice(ctx, token);
    const senior = await ctx.db.get(device.seniorId);
    return senior ? { displayName: senior.displayName, consent: senior.consent } : null;
  },
});

export const setConsent = mutation({
  args: { token: v.string(), notifyOnComplete: v.boolean(), notifyOnStuck: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { token, ...consent }) => {
    const device = await requireDevice(ctx, token);
    await ctx.db.patch(device.seniorId, { consent });
    return null;
  },
});

const deviceSummary = v.object({
  deviceId: v.id("devices"),
  kind: deviceKind,
  platform: v.string(),
  label: v.string(),
  machineId: v.union(v.string(), v.null()),
  pairedAt: v.number(),
  lastSeenAt: v.union(v.number(), v.null()),
  isThisDevice: v.boolean(),
});

/** Her installs (not revoked). Never returns token hashes. */
export const list = query({
  args: { token: v.string() },
  returns: v.array(deviceSummary),
  handler: async (ctx, { token }) => {
    const me = await requireDevice(ctx, token);
    const rows = await ctx.db
      .query("devices")
      .withIndex("by_senior", (q) => q.eq("seniorId", me.seniorId))
      .take(50);
    return rows
      .filter((d) => d.revokedAt === undefined)
      .map((d) => ({
        deviceId: d._id,
        kind: kindOf(d),
        platform: d.platform ?? "unknown",
        label: d.label ?? (kindOf(d) === "desktop" ? "JustAsk app" : "Web browser"),
        machineId: d.machineId ?? null,
        pairedAt: d.pairedAt,
        lastSeenAt: d.lastSeenAt ?? null,
        isThisDevice: d._id === me._id,
      }));
  },
});

/** Any install can revoke another install of the same account (or itself). */
export const revoke = mutation({
  args: { token: v.string(), deviceId: v.id("devices") },
  returns: v.null(),
  handler: async (ctx, { token, deviceId }) => {
    const me = await requireDevice(ctx, token);
    const target = await ctx.db.get(deviceId);
    if (!target || target.seniorId !== me.seniorId) throw new Error("not found");
    if (target.revokedAt === undefined) await ctx.db.patch(deviceId, { revokedAt: Date.now() });
    return null;
  },
});

/** Marks this install as seen. Writes at most once a minute, since live queries read the device row. */
export const heartbeat = mutation({
  args: { token: v.string() },
  returns: v.null(),
  handler: async (ctx, { token }) => {
    const device = await requireDevice(ctx, token);
    const now = Date.now();
    if (device.lastSeenAt === undefined || now - device.lastSeenAt >= HEARTBEAT_MIN_MS) {
      await ctx.db.patch(device._id, { lastSeenAt: now });
    }
    return null;
  },
});

/** Called by the plan action before every Claude call. Throws past the hourly budget. */
export const consumeStep = internalMutation({
  args: { token: v.string() },
  returns: v.null(),
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
    return null;
  },
});
