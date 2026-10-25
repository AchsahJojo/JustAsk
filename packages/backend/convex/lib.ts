import { getAuthUserId } from "@convex-dev/auth/server";
import type { Infer } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { deviceInfo } from "./validators";

export const STEPS_PER_HOUR = 60;
export const CODE_TTL_MS = 15 * 60 * 1000;
/**
 * JustAsk speaks and listens through Cartesia only ("browser" is kept in the validator for old rows).
 * JustAsk guides by default: it shows each step and the user clicks (`showMeInstead: true`). Letting
 * JustAsk click and type is an opt-in, by the user or a linked caregiver.
 */
export const DEFAULT_PREFS = { voice: "cartesia" as const, rate: 1, showMeInstead: true };

export async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A fresh 256-bit device token (hex). Only its hash is stored. */
export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Validate a device token. Extension functions take the token, never a caregiver session.
 * Revoked devices are rejected with the same "not paired" message as unknown tokens.
 */
export async function requireDevice(ctx: QueryCtx | MutationCtx, token: string | null | undefined) {
  if (!token) throw new Error("not paired");
  const tokenHash = await sha256(token);
  const device = await ctx.db
    .query("devices")
    .withIndex("by_token", (q) => q.eq("tokenHash", tokenHash))
    .unique();
  if (!device || device.revokedAt !== undefined) throw new Error("not paired");
  return device;
}

/** The signed-in caregiver, or null (signed out, or signed in but no profile yet). */
export async function currentCaregiver(ctx: QueryCtx | MutationCtx) {
  const userId = await getAuthUserId(ctx);
  if (!userId) return null;
  return ctx.db
    .query("caregivers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
}

export async function requireCaregiver(ctx: QueryCtx | MutationCtx) {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("not signed in");
  const cg = await ctx.db
    .query("caregivers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  if (!cg) throw new Error("no caregiver profile");
  return cg;
}

export async function findLink(ctx: QueryCtx | MutationCtx, caregiverId: Id<"caregivers">, seniorId: Id<"seniors">) {
  return ctx.db
    .query("careLinks")
    .withIndex("by_caregiver_and_senior", (q) => q.eq("caregiverId", caregiverId).eq("seniorId", seniorId))
    .first();
}

/** The caregiver plus their link to this senior. Throws the same error whether the senior is missing or not theirs. */
export async function requireLink(ctx: QueryCtx | MutationCtx, seniorId: Id<"seniors">) {
  const cg = await requireCaregiver(ctx);
  const link = await findLink(ctx, cg._id, seniorId);
  if (!link) throw new Error("not your senior");
  return { cg, link };
}

function clip(s: string, max: number, what: string): string {
  const t = s.trim();
  if (t.length === 0 || t.length > max) throw new Error(`${what} must be 1-${max} characters`);
  return t;
}

/** Validated display name for a new account. */
export function cleanDisplayName(name: string): string {
  return clip(name, 60, "displayName");
}

/** Validated device fields from what an install reports about itself. */
export function cleanDevice(d: Infer<typeof deviceInfo>) {
  return {
    kind: d.kind,
    platform: clip(d.platform, 40, "platform"),
    label: clip(d.label, 80, "label"),
  };
}

/** Insert an install for this senior and return its plaintext token (shown to the caller once). */
export async function insertDevice(
  ctx: MutationCtx,
  seniorId: Id<"seniors">,
  fields: Partial<Pick<Doc<"devices">, "kind" | "platform" | "label">>,
): Promise<{ token: string; deviceId: Id<"devices"> }> {
  const token = newToken();
  const now = Date.now();
  const deviceId = await ctx.db.insert("devices", { seniorId, tokenHash: await sha256(token), pairedAt: now, lastSeenAt: now, ...fields });
  return { token, deviceId };
}

/** A 6-digit code that no live row is using (device and caregiver codes share one namespace). */
export async function newCode(ctx: MutationCtx): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const code = String(100000 + Math.floor(Math.random() * 900000));
    const clash = await ctx.db
      .query("pairingCodes")
      .withIndex("by_code", (q) => q.eq("code", code))
      .first();
    if (!clash) return code;
  }
  throw new Error("Couldn't make a code. Try again.");
}

/** The live (unexpired) code row with this purpose. A missing purpose counts as "device". */
export async function findLiveCode(ctx: QueryCtx | MutationCtx, code: string, purpose: "device" | "caregiver") {
  const rows = await ctx.db
    .query("pairingCodes")
    .withIndex("by_code", (q) => q.eq("code", code))
    .take(5);
  const now = Date.now();
  return rows.find((r) => r.expiresAt > now && (r.purpose ?? "device") === purpose) ?? null;
}

/** A device code a caregiver made from the web app (not "Add another device" on one of the user's installs). */
export const isCaregiverCode = (r: Doc<"pairingCodes">) => (r.purpose ?? "device") === "device" && r.createdByDeviceId === undefined;

/** Replace any caregiver-made codes for this senior with one new, unused 6-digit code. */
export async function newPairingCode(ctx: MutationCtx, seniorId: Id<"seniors">) {
  for (const old of await ctx.db.query("pairingCodes").withIndex("by_senior", (q) => q.eq("seniorId", seniorId)).collect()) {
    if (isCaregiverCode(old)) await ctx.db.delete(old._id);
  }
  const code = await newCode(ctx);
  const expiresAt = Date.now() + CODE_TTL_MS;
  await ctx.db.insert("pairingCodes", { seniorId, code, expiresAt, purpose: "device" });
  return { code, expiresAt };
}

/** Synced preferences with defaults filled in. */
export function prefsOf(senior: Doc<"seniors">) {
  return {
    displayName: senior.displayName,
    voice: senior.prefs?.voice ?? DEFAULT_PREFS.voice,
    rate: senior.prefs?.rate ?? DEFAULT_PREFS.rate,
    // Only an explicit choice (showMeSetBy) turns guiding off; older accounts stored the old default.
    showMeInstead: senior.showMeSetBy ? (senior.prefs?.showMeInstead ?? DEFAULT_PREFS.showMeInstead) : DEFAULT_PREFS.showMeInstead,
    consent: senior.consent,
  };
}

/**
 * Move everything that belongs to `from` onto `into`, then delete `from`. Used when a senior who
 * already uses JustAsk on their own types a caregiver's code: one person, one profile.
 */
export async function mergeSenior(ctx: MutationCtx, from: Id<"seniors">, into: Id<"seniors">) {
  if (from === into) return;
  const fromLinks = await ctx.db.query("careLinks").withIndex("by_senior", (q) => q.eq("seniorId", from)).collect();
  for (const l of fromLinks) {
    for (const n of await ctx.db.query("notifications").withIndex("by_caregiver", (q) => q.eq("toCaregiverId", l.caregiverId)).collect()) {
      if (n.seniorId === from) await ctx.db.patch(n._id, { seniorId: into });
    }
  }
  for (const d of await ctx.db.query("devices").withIndex("by_senior", (q) => q.eq("seniorId", from)).collect()) await ctx.db.patch(d._id, { seniorId: into });
  const existing = await ctx.db.query("careLinks").withIndex("by_senior", (q) => q.eq("seniorId", into)).collect();
  for (const l of fromLinks) {
    if (existing.some((e) => e.caregiverId === l.caregiverId)) await ctx.db.delete(l._id);
    else await ctx.db.patch(l._id, { seniorId: into });
  }
  for (const status of ["pending", "active", "done", "dismissed"] as const) {
    for (const t of await ctx.db.query("tasks").withIndex("by_senior_status", (q) => q.eq("seniorId", from).eq("status", status)).collect()) {
      await ctx.db.patch(t._id, { seniorId: into });
    }
  }
  for (const s of await ctx.db.query("sessions").withIndex("by_senior", (q) => q.eq("seniorId", from)).collect()) await ctx.db.patch(s._id, { seniorId: into });
  for (const c of await ctx.db.query("pairingCodes").withIndex("by_senior", (q) => q.eq("seniorId", from)).collect()) await ctx.db.delete(c._id);
  for (const a of await ctx.db.query("seniorAliases").withIndex("by_to", (q) => q.eq("to", from)).collect()) await ctx.db.patch(a._id, { to: into });
  await ctx.db.insert("seniorAliases", { from, to: into });
  await ctx.db.delete(from);
}

export const clean = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max);

/** Follow merge aliases from a senior id that no longer exists. */
export async function resolveSenior(ctx: QueryCtx | MutationCtx, id: Id<"seniors">): Promise<Id<"seniors"> | null> {
  if (await ctx.db.get(id)) return id;
  const alias = await ctx.db
    .query("seniorAliases")
    .withIndex("by_from", (q) => q.eq("from", id))
    .first();
  return alias && (await ctx.db.get(alias.to)) ? alias.to : null;
}
