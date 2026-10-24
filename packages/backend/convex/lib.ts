import type { QueryCtx, MutationCtx } from "./_generated/server";

export const STEPS_PER_HOUR = 60;

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
