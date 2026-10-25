import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import {
  CODE_TTL_MS,
  clean,
  cleanDevice,
  findLiveCode,
  insertDevice,
  isCaregiverCode,
  kindOf,
  mergeSenior,
  newCode as freshCode,
  newPairingCode,
  requireCaregiver,
  requireDevice,
  requireLink,
  STEPS_PER_HOUR,
} from "./lib";
import { assertCodeAttemptAllowed, normalizeCode, recordCodeFailure } from "./rateLimits";
import { consentValidator, deviceInfo, deviceKind } from "./validators";

const HEARTBEAT_MIN_MS = 60 * 1000;
const MAX_SENIORS_PER_CAREGIVER = 20;

/** Caregiver: create a profile for someone they help, plus a 6-digit pairing code. */
export const createSeniorWithCode = mutation({
  args: { name: v.string(), displayName: v.string(), relation: v.string() },
  returns: v.object({ seniorId: v.id("seniors"), code: v.string(), expiresAt: v.number() }),
  handler: async (ctx, args) => {
    const cg = await requireCaregiver(ctx);
    const name = clean(args.name, 60);
    const displayName = clean(args.displayName, 40) || name.split(" ")[0];
    if (!name) throw new ConvexError("Add their name.");
    const links = await ctx.db.query("careLinks").withIndex("by_caregiver", (q) => q.eq("caregiverId", cg._id)).take(MAX_SENIORS_PER_CAREGIVER);
    if (links.length >= MAX_SENIORS_PER_CAREGIVER) throw new ConvexError(`You can help up to ${MAX_SENIORS_PER_CAREGIVER} people.`);
    const seniorId = await ctx.db.insert("seniors", {
      name,
      displayName,
      consent: { notifyOnComplete: false, notifyOnStuck: false },
      createdBy: "caregiver",
      createdAt: Date.now(),
    });
    await ctx.db.insert("careLinks", { caregiverId: cg._id, seniorId, relation: clean(args.relation, 40), linkedAt: Date.now() });
    const { code, expiresAt } = await newPairingCode(ctx, seniorId);
    return { seniorId, code, expiresAt };
  },
});

/** Caregiver: a fresh code for someone they already help (expired code, or another computer). */
export const newCode = mutation({
  args: { seniorId: v.id("seniors") },
  returns: v.object({ code: v.string(), expiresAt: v.number() }),
  handler: async (ctx, { seniorId }) => {
    await requireLink(ctx, seniorId);
    return newPairingCode(ctx, seniorId);
  },
});

/** Caregiver: the live code for this senior, if one is still valid. */
export const activeCode = query({
  args: { seniorId: v.id("seniors") },
  returns: v.union(v.object({ code: v.string(), expiresAt: v.number() }), v.null()),
  handler: async (ctx, { seniorId }) => {
    // Null rather than an error if the profile just merged away; the page follows `people:get`.
    if (!(await requireLink(ctx, seniorId).catch(() => null))) return null;
    const rows = await ctx.db
      .query("pairingCodes")
      .withIndex("by_senior", (q) => q.eq("seniorId", seniorId))
      .take(20);
    const row = rows.find((r) => isCaregiverCode(r) && r.expiresAt > Date.now());
    return row ? { code: row.code, expiresAt: row.expiresAt } : null;
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
    const code = await freshCode(ctx);
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
 * Redeem a device code once (from a caregiver, or "Add another device" on the user's other install).
 * - New install (no `token`): this install joins that account and gets a device token.
 * - An install that already has the user's own account (`token`): the two profiles become one, so nothing
 *   the user set up is lost, and the install keeps its token.
 * Returns `null` for a wrong or expired code instead of throwing, so the failure is recorded.
 * Throws only while rate limited ("Too many tries...").
 * The new device inherits the code's machineId when the code was made on a desktop install
 * (the desktop opens the link page in browsers on the same machine).
 */
export const redeemCode = mutation({
  args: { code: v.string(), device: v.optional(deviceInfo), token: v.optional(v.string()) },
  returns: v.union(v.object({ token: v.string(), displayName: v.string() }), v.null()),
  handler: async (ctx, args) => {
    const code = normalizeCode(args.code.replace(/\s/g, ""));
    if (!code) return null;
    const fields: { kind?: "extension" | "desktop"; platform?: string; label?: string; machineId?: string } = args.device ? cleanDevice(args.device) : {};
    await assertCodeAttemptAllowed(ctx, code);
    const row = await findLiveCode(ctx, code, "device");
    if (!row) {
      await recordCodeFailure(ctx, code);
      return null;
    }
    await ctx.db.delete(row._id);
    const target = row.seniorId;

    let current: Doc<"devices"> | null = null;
    if (args.token) current = await requireDevice(ctx, args.token).catch(() => null); // a stale token is a new install

    // A code made by the desktop app is typed in a browser on the same computer: that browser takes the
    // app's machineId, so handoffs between the two match.
    let machineId = fields.machineId;
    if (machineId === undefined && row.machineId !== undefined && row.createdByDeviceId) {
      const creator = await ctx.db.get(row.createdByDeviceId);
      if (creator && kindOf(creator) === "desktop") machineId = row.machineId;
    }

    if (!args.token || !current) {
      const { token } = await insertDevice(ctx, target, { ...fields, ...(machineId !== undefined ? { machineId } : {}) });
      const senior = await ctx.db.get(target);
      return { token, displayName: senior?.displayName ?? "" };
    }

    if (current.machineId === undefined && machineId !== undefined) await ctx.db.patch(current._id, { machineId });
    const own = await ctx.db.get(current.seniorId);
    const theirs = await ctx.db.get(target);
    if (!own || !theirs) return null;
    let kept = own._id;
    if (own._id !== theirs._id) {
      const targetHasDevices = (await ctx.db.query("devices").withIndex("by_senior", (q) => q.eq("seniorId", target)).take(50)).some((d) => d.revokedAt === undefined);
      if (targetHasDevices) {
        // That account is already in use on another computer: this one joins it.
        await mergeSenior(ctx, own._id, theirs._id);
        kept = theirs._id;
      } else {
        // Keep the user's own profile (name, settings, history) and bring the caregiver over.
        await mergeSenior(ctx, theirs._id, own._id);
        // The user's display name wins (it's what JustAsk calls the user). A self-made profile has no full name, so take the caregiver's.
        await ctx.db.patch(own._id, {
          name: own.createdBy === "self" ? theirs.name || own.name : own.name || theirs.name,
          displayName: own.displayName || theirs.displayName,
          // A Show me instead choice the caregiver made while setting up carries over unless the user already chose.
          ...(own.showMeSetBy === undefined && theirs.prefs ? { prefs: { ...(own.prefs ?? theirs.prefs), showMeInstead: theirs.prefs.showMeInstead }, showMeSetBy: theirs.showMeSetBy } : {}),
        });
      }
    }
    const senior = await ctx.db.get(kept);
    return { token: args.token, displayName: senior?.displayName ?? "" };
  },
});

/** The user's install: who am I, and which helpers can send me tasks. */
export const me = query({
  args: { token: v.string() },
  returns: v.union(
    v.object({
      displayName: v.string(),
      consent: consentValidator,
      helpers: v.array(v.object({ id: v.id("caregivers"), name: v.string() })),
      showMeSetBy: v.union(v.literal("self"), v.literal("caregiver"), v.null()),
    }),
    v.null(),
  ),
  handler: async (ctx, { token }) => {
    const device = await requireDevice(ctx, token);
    const senior = await ctx.db.get(device.seniorId);
    if (!senior) return null;
    const links = await ctx.db.query("careLinks").withIndex("by_senior", (q) => q.eq("seniorId", senior._id)).take(50);
    const helpers = await Promise.all(
      links.map(async (l) => {
        const cg = await ctx.db.get(l.caregiverId);
        return { id: l.caregiverId, name: cg?.name ?? "Your helper" };
      }),
    );
    return { displayName: senior.displayName, consent: senior.consent, helpers, showMeSetBy: senior.showMeSetBy ?? null };
  },
});

export const setDisplayName = mutation({
  args: { token: v.string(), displayName: v.string() },
  returns: v.null(),
  handler: async (ctx, { token, displayName }) => {
    const device = await requireDevice(ctx, token);
    const dn = clean(displayName, 40);
    const senior = await ctx.db.get(device.seniorId);
    if (!senior) throw new Error("not paired");
    await ctx.db.patch(senior._id, { displayName: dn, ...(senior.name ? {} : { name: dn }) });
    return null;
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

/**
 * The user's install: stop working with one helper (or all). JustAsk keeps working on its own; only the link
 * and that helper's waiting tasks go away. The helper gets a short note so they aren't left guessing.
 */
export const leaveHelpers = mutation({
  args: { token: v.string(), caregiverId: v.optional(v.id("caregivers")) },
  returns: v.null(),
  handler: async (ctx, { token, caregiverId }) => {
    const device = await requireDevice(ctx, token);
    const senior = await ctx.db.get(device.seniorId);
    const links = await ctx.db.query("careLinks").withIndex("by_senior", (q) => q.eq("seniorId", device.seniorId)).take(50);
    for (const l of links) {
      if (caregiverId && l.caregiverId !== caregiverId) continue;
      await ctx.db.delete(l._id);
      for (const status of ["pending", "active"] as const) {
        for (const t of await ctx.db.query("tasks").withIndex("by_senior_status", (q) => q.eq("seniorId", device.seniorId).eq("status", status)).take(100)) {
          if (t.assignedBy === l.caregiverId) await ctx.db.patch(t._id, { status: "dismissed" });
        }
      }
      await ctx.db.insert("notifications", {
        toCaregiverId: l.caregiverId,
        seniorId: device.seniorId,
        text: `${senior?.displayName || senior?.name || "Someone"} disconnected from you in JustAsk.`,
        at: Date.now(),
        read: false,
      });
    }
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

/** The user's installs (not revoked). Never returns token hashes. */
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
