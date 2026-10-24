import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import {
  BAD_CODES_PER_HOUR,
  bumpHourly,
  clean,
  hourlyCount,
  issueDevice,
  mergeSenior,
  newPairingCode,
  requireCaregiver,
  requireDevice,
  requireLink,
  SIGNUPS_PER_HOUR,
  STEPS_PER_HOUR,
} from "./lib";

const MAX_SENIORS_PER_CAREGIVER = 20;

/**
 * Extension: a standalone account for someone using JustAsk on their own. No caregiver, no
 * password: the extension keeps the returned token. A caregiver can be connected later with a code.
 */
export const registerStandalone = mutation({
  args: { displayName: v.optional(v.string()) },
  handler: async (ctx, { displayName }) => {
    await bumpHourly(ctx, "signup", SIGNUPS_PER_HOUR);
    const dn = clean(displayName ?? "", 40);
    const seniorId = await ctx.db.insert("seniors", {
      name: dn,
      displayName: dn,
      consent: { notifyOnComplete: false, notifyOnStuck: false },
      origin: "self",
      createdAt: Date.now(),
    });
    return { token: await issueDevice(ctx, seniorId) };
  },
});

/** Caregiver: create a profile for someone they help, plus a 6-digit pairing code. */
export const createSeniorWithCode = mutation({
  args: { name: v.string(), displayName: v.string(), relation: v.string() },
  handler: async (ctx, args) => {
    const cg = await requireCaregiver(ctx);
    const name = clean(args.name, 60);
    const displayName = clean(args.displayName, 40) || name.split(" ")[0];
    if (!name) throw new Error("Add their name.");
    const links = await ctx.db.query("careLinks").withIndex("by_caregiver", (q) => q.eq("caregiverId", cg._id)).collect();
    if (links.length >= MAX_SENIORS_PER_CAREGIVER) throw new Error(`You can help up to ${MAX_SENIORS_PER_CAREGIVER} people.`);
    const seniorId = await ctx.db.insert("seniors", {
      name,
      displayName,
      consent: { notifyOnComplete: false, notifyOnStuck: false },
      origin: "caregiver",
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
  handler: async (ctx, { seniorId }) => {
    await requireLink(ctx, seniorId);
    return newPairingCode(ctx, seniorId);
  },
});

/** Caregiver: the live code for this senior, if one is still valid. */
export const activeCode = query({
  args: { seniorId: v.id("seniors") },
  handler: async (ctx, { seniorId }) => {
    await requireLink(ctx, seniorId);
    const row = await ctx.db
      .query("pairingCodes")
      .withIndex("by_senior", (q) => q.eq("seniorId", seniorId))
      .first();
    return row && row.expiresAt > Date.now() ? { code: row.code, expiresAt: row.expiresAt } : null;
  },
});

/**
 * Extension: redeem a caregiver's 6-digit code once.
 * - New install (no token): this computer joins the profile the caregiver made.
 * - Already using JustAsk on their own (token): the two profiles become one, so nothing she set up is lost.
 * Returns `{ ok: false }` instead of throwing so the failed-try counter is committed.
 */
export const redeemCode = mutation({
  args: { code: v.string(), token: v.optional(v.string()) },
  handler: async (ctx, { code, token }): Promise<{ ok: true; token: string; displayName: string } | { ok: false; error: string }> => {
    if ((await hourlyCount(ctx, "badCode")) >= BAD_CODES_PER_HOUR) return { ok: false, error: "Too many tries. Wait a little and try again." };
    const row = await ctx.db
      .query("pairingCodes")
      .withIndex("by_code", (q) => q.eq("code", code.replace(/\D/g, "")))
      .first();
    if (!row || row.expiresAt < Date.now()) {
      if (row) await ctx.db.delete(row._id);
      await bumpHourly(ctx, "badCode", Number.MAX_SAFE_INTEGER);
      return { ok: false, error: "That code didn't work. Ask for a new one." };
    }
    await ctx.db.delete(row._id);
    const target = row.seniorId;

    let current: Doc<"devices"> | null = null;
    if (token) current = await requireDevice(ctx, token).catch(() => null); // a stale token is a new install

    if (!token || !current) {
      const fresh = await issueDevice(ctx, target);
      const senior = await ctx.db.get(target);
      return { ok: true, token: fresh, displayName: senior?.displayName ?? "" };
    }

    const own = await ctx.db.get(current.seniorId);
    const theirs = await ctx.db.get(target);
    if (!own || !theirs) return { ok: false, error: "That code didn't work. Ask for a new one." };
    let kept = own._id;
    if (own._id !== theirs._id) {
      const targetHasDevices = !!(await ctx.db.query("devices").withIndex("by_senior", (q) => q.eq("seniorId", target)).first());
      if (targetHasDevices) {
        // The caregiver's profile is already in use on another computer: this one joins it.
        await mergeSenior(ctx, own._id, theirs._id);
        kept = theirs._id;
      } else {
        // Keep her own profile (name, consent choices, history) and bring the caregiver over.
        await mergeSenior(ctx, theirs._id, own._id);
        // Her display name wins (it's what JustAsk calls her). A self-made profile has no full name, so take the caregiver's.
        await ctx.db.patch(own._id, {
          name: own.origin === "self" ? theirs.name || own.name : own.name || theirs.name,
          displayName: own.displayName || theirs.displayName,
        });
      }
    }
    const senior = await ctx.db.get(kept);
    return { ok: true, token, displayName: senior?.displayName ?? "" };
  },
});

/** Extension: who am I, and which helpers can send me tasks. */
export const me = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const device = await requireDevice(ctx, token);
    const senior = await ctx.db.get(device.seniorId);
    if (!senior) return null;
    const links = await ctx.db.query("careLinks").withIndex("by_senior", (q) => q.eq("seniorId", senior._id)).collect();
    const helpers = await Promise.all(
      links.map(async (l) => {
        const cg = await ctx.db.get(l.caregiverId);
        return { id: l.caregiverId, name: cg?.name ?? "Your helper" };
      }),
    );
    return { displayName: senior.displayName, consent: senior.consent, helpers };
  },
});

export const setDisplayName = mutation({
  args: { token: v.string(), displayName: v.string() },
  handler: async (ctx, { token, displayName }) => {
    const device = await requireDevice(ctx, token);
    const dn = clean(displayName, 40);
    const senior = await ctx.db.get(device.seniorId);
    if (!senior) throw new Error("not paired");
    await ctx.db.patch(senior._id, { displayName: dn, ...(senior.name ? {} : { name: dn }) });
  },
});

export const setConsent = mutation({
  args: { token: v.string(), notifyOnComplete: v.boolean(), notifyOnStuck: v.boolean() },
  handler: async (ctx, { token, ...consent }) => {
    const device = await requireDevice(ctx, token);
    await ctx.db.patch(device.seniorId, { consent });
  },
});

/**
 * Extension: stop working with one helper (or all). JustAsk keeps working on its own; only the link
 * and that helper's waiting tasks go away. The helper gets a short note so they aren't left guessing.
 */
export const leaveHelpers = mutation({
  args: { token: v.string(), caregiverId: v.optional(v.id("caregivers")) },
  handler: async (ctx, { token, caregiverId }) => {
    const device = await requireDevice(ctx, token);
    const senior = await ctx.db.get(device.seniorId);
    const links = await ctx.db.query("careLinks").withIndex("by_senior", (q) => q.eq("seniorId", device.seniorId)).collect();
    for (const l of links) {
      if (caregiverId && l.caregiverId !== caregiverId) continue;
      await ctx.db.delete(l._id);
      for (const t of await ctx.db.query("tasks").withIndex("by_senior_status", (q) => q.eq("seniorId", device.seniorId).eq("status", "pending")).collect()) {
        if (t.assignedBy === l.caregiverId) await ctx.db.patch(t._id, { status: "dismissed" });
      }
      await ctx.db.insert("notifications", {
        toCaregiverId: l.caregiverId,
        seniorId: device.seniorId,
        text: `${senior?.displayName || senior?.name || "Someone"} disconnected from you in JustAsk.`,
        at: Date.now(),
        read: false,
      });
    }
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
