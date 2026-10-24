import { getAuthUserId } from "@convex-dev/auth/server";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

export const STEPS_PER_HOUR = 60;
export const CODE_TTL_MS = 15 * 60 * 1000;
/** Global caps for the two unauthenticated writes. Generous for real use, a ceiling for scripts. */
export const SIGNUPS_PER_HOUR = 500;
export const BAD_CODES_PER_HOUR = 300;

export async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Validate an extension device token. Extension functions take the token, never a caregiver session. */
export async function requireDevice(ctx: QueryCtx | MutationCtx, token: string | null | undefined) {
  if (!token) throw new Error("not paired");
  const tokenHash = await sha256(token);
  const device = await ctx.db
    .query("devices")
    .withIndex("by_token", (q) => q.eq("tokenHash", tokenHash))
    .unique();
  if (!device) throw new Error("not paired");
  return device;
}

/** A fresh device token. Only its hash is stored. */
export async function issueDevice(ctx: MutationCtx, seniorId: Id<"seniors">) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  await ctx.db.insert("devices", { seniorId, tokenHash: await sha256(token), pairedAt: Date.now() });
  return token;
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
  const links = await ctx.db
    .query("careLinks")
    .withIndex("by_senior", (q) => q.eq("seniorId", seniorId))
    .collect();
  return links.find((l) => l.caregiverId === caregiverId) ?? null;
}

/** The caregiver plus their link to this senior. Throws the same error whether the senior is missing or not theirs. */
export async function requireLink(ctx: QueryCtx | MutationCtx, seniorId: Id<"seniors">) {
  const cg = await requireCaregiver(ctx);
  const link = await findLink(ctx, cg._id, seniorId);
  if (!link) throw new Error("not your senior");
  return { cg, link };
}

/** Count one hit for `kind` this hour. Throws once the hour's cap is reached. */
export async function bumpHourly(ctx: MutationCtx, kind: string, limit: number) {
  const hour = Math.floor(Date.now() / 3_600_000);
  const row = await ctx.db
    .query("hourlyCounts")
    .withIndex("by_kind_hour", (q) => q.eq("kind", kind).eq("hour", hour))
    .unique();
  if (row && row.count >= limit) throw new Error("rate limited");
  if (row) await ctx.db.patch(row._id, { count: row.count + 1 });
  else await ctx.db.insert("hourlyCounts", { kind, hour, count: 1 });
}

export async function hourlyCount(ctx: QueryCtx | MutationCtx, kind: string) {
  const hour = Math.floor(Date.now() / 3_600_000);
  const row = await ctx.db
    .query("hourlyCounts")
    .withIndex("by_kind_hour", (q) => q.eq("kind", kind).eq("hour", hour))
    .unique();
  return row?.count ?? 0;
}

/** Replace any codes for this senior with one new, unused 6-digit code. */
export async function newPairingCode(ctx: MutationCtx, seniorId: Id<"seniors">) {
  for (const old of await ctx.db.query("pairingCodes").withIndex("by_senior", (q) => q.eq("seniorId", seniorId)).collect()) {
    await ctx.db.delete(old._id);
  }
  for (let i = 0; i < 10; i++) {
    const code = String(100000 + Math.floor(Math.random() * 900000));
    const clash = await ctx.db
      .query("pairingCodes")
      .withIndex("by_code", (q) => q.eq("code", code))
      .first();
    if (clash && clash.expiresAt > Date.now()) continue;
    if (clash) await ctx.db.delete(clash._id);
    const expiresAt = Date.now() + CODE_TTL_MS;
    await ctx.db.insert("pairingCodes", { seniorId, code, expiresAt });
    return { code, expiresAt };
  }
  throw new Error("Couldn't make a code. Try again.");
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
