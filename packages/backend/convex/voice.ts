import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalMutation } from "./_generated/server";
import { requireCaregiver, requireDevice } from "./lib";
import { rateLimiter, TOO_MANY_TRIES } from "./rateLimits";

/** Cartesia access tokens (https://docs.cartesia.ai/api-reference/auth/access-token). */
const CARTESIA_URL = "https://api.cartesia.ai/access-token";
const CARTESIA_VERSION = "2026-08-14";
const TOKEN_TTL_S = 600;

/** Checks the device token and spends one unit of its Cartesia token budget. */
export const authorize = internalMutation({
  args: { token: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { token }) => {
    const device = await requireDevice(ctx, token);
    const { ok } = await rateLimiter.limit(ctx, "cartesiaToken", { key: device._id });
    return ok;
  },
});

/**
 * A short-lived Cartesia access token for the extension (STT + TTS grants, 10 minutes).
 * The client connects with `?access_token=<token>`. The API key never leaves Convex.
 */
export const cartesiaToken = action({
  args: { token: v.string() },
  returns: v.object({ token: v.string(), expiresAt: v.number() }),
  handler: async (ctx, { token }): Promise<{ token: string; expiresAt: number }> => {
    const ok: boolean = await ctx.runMutation(internal.voice.authorize, { token });
    if (!ok) throw new ConvexError(TOO_MANY_TRIES);
    return mint({ stt: true, tts: true });
  },
});

/** Mints a Cartesia access token with these grants. The API key never leaves Convex. */
async function mint(grants: { stt: boolean; tts: boolean }): Promise<{ token: string; expiresAt: number }> {
  const key = process.env.CARTESIA_API_KEY;
  if (!key) throw new Error("server not configured");
  const res = await fetch(CARTESIA_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "X-API-Key": key,
      "Cartesia-Version": CARTESIA_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ grants, expires_in: TOKEN_TTL_S }),
  });
  if (!res.ok) {
    // Status only. Never log the key or the response body.
    console.log("cartesia token", JSON.stringify({ status: res.status }));
    throw new Error("voice service unavailable");
  }
  const body = (await res.json()) as unknown;
  const minted = typeof body === "object" && body !== null && typeof (body as { token?: unknown }).token === "string" ? (body as { token: string }).token : null;
  if (!minted) throw new Error("voice service unavailable");
  return { token: minted, expiresAt: Date.now() + TOKEN_TTL_S * 1000 };
}

/** Checks the caregiver's sign-in and spends one unit of their voice budget. */
export const authorizeCaregiver = internalMutation({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    const cg = await requireCaregiver(ctx);
    const { ok } = await rateLimiter.limit(ctx, "caregiverVoice", { key: cg._id });
    return ok;
  },
});

/** Caregiver app: a short-lived listening-only token, so a caregiver can speak a task instead of typing it. */
export const caregiverToken = action({
  args: {},
  returns: v.object({ token: v.string(), expiresAt: v.number() }),
  handler: async (ctx): Promise<{ token: string; expiresAt: number }> => {
    const ok: boolean = await ctx.runMutation(internal.voice.authorizeCaregiver, {});
    if (!ok) throw new ConvexError(TOO_MANY_TRIES);
    return mint({ stt: true, tts: false });
  },
});
