import type { Infer } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { deviceInfo } from "./validators";

export const STEPS_PER_HOUR = 60;
export const CODE_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_PREFS = { voice: "browser" as const, rate: 1, showMeInstead: false };

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
 * Validate a device token. Extension and desktop functions take the token, never a caregiver session.
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

export async function requireCaregiver(ctx: QueryCtx | MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("not signed in");
  const cg = await ctx.db
    .query("caregivers")
    .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
    .unique();
  if (!cg) throw new Error("no caregiver profile");
  return cg;
}

/** Legacy device rows have no kind; they were all extensions. */
export function kindOf(device: Doc<"devices">): "extension" | "desktop" {
  return device.kind ?? "extension";
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
    ...(d.machineId !== undefined ? { machineId: clip(d.machineId, 128, "machineId") } : {}),
  };
}

/** Insert an install for this senior and return its plaintext token (shown to the caller once). */
export async function insertDevice(
  ctx: MutationCtx,
  seniorId: Id<"seniors">,
  fields: Partial<Pick<Doc<"devices">, "kind" | "platform" | "label" | "machineId">>,
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
  throw new Error("could not make a code, try again");
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

/** Synced preferences with defaults filled in. */
export function prefsOf(senior: Doc<"seniors">) {
  return {
    displayName: senior.displayName,
    voice: senior.prefs?.voice ?? DEFAULT_PREFS.voice,
    rate: senior.prefs?.rate ?? DEFAULT_PREFS.rate,
    showMeInstead: senior.prefs?.showMeInstead ?? DEFAULT_PREFS.showMeInstead,
    consent: senior.consent,
  };
}
