import { HOUR, MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import { ConvexError } from "convex/values";
import { components } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";

/**
 * App rate limits (@convex-dev/rate-limiter).
 *
 * Code redeem and peek count only *failures*. A mutation that throws rolls back its writes,
 * including rate-limit consumption, so wrong codes return `null` instead of throwing.
 *
 * - `codeFailPrefix`: per first-3-digits bucket. Brute force against one bucket stops quickly,
 *   and only people whose code starts with those digits are affected.
 * - `codeFailGlobal`: a looser cap across all buckets, so spreading guesses doesn't help.
 *   Max ~60 wrong guesses a minute in the whole system.
 */
export const rateLimiter = new RateLimiter(components.rateLimiter, {
  codeFailPrefix: { kind: "token bucket", rate: 5, period: MINUTE, capacity: 10 },
  codeFailGlobal: { kind: "token bucket", rate: 60, period: MINUTE, capacity: 120 },
  helperFailCaregiver: { kind: "token bucket", rate: 5, period: MINUTE, capacity: 10 },
  createSelf: { kind: "token bucket", rate: 30, period: MINUTE, capacity: 60 },
  cartesiaToken: { kind: "token bucket", rate: 30, period: HOUR, capacity: 10 },
  // Caregiver: one Claude call per question in the task check, and voice tokens for speaking a task.
  taskCheck: { kind: "token bucket", rate: 60, period: HOUR, capacity: 20 },
  caregiverVoice: { kind: "token bucket", rate: 20, period: HOUR, capacity: 5 },
});

export const TOO_MANY_TRIES = "Too many tries. Please wait a minute and try again.";

/** A well-formed 6-digit code, or null. */
export function normalizeCode(code: string): string | null {
  const c = code.trim();
  return /^\d{6}$/.test(c) ? c : null;
}

/** Throws (writing nothing) while the buckets for this code are empty. */
export async function assertCodeAttemptAllowed(ctx: MutationCtx, code: string) {
  const prefix = await rateLimiter.check(ctx, "codeFailPrefix", { key: code.slice(0, 3) });
  const global = await rateLimiter.check(ctx, "codeFailGlobal");
  if (!prefix.ok || !global.ok) throw new ConvexError(TOO_MANY_TRIES);
}

/** Records one wrong code. The caller must return normally afterwards so this write commits. */
export async function recordCodeFailure(ctx: MutationCtx, code: string) {
  await rateLimiter.limit(ctx, "codeFailPrefix", { key: code.slice(0, 3) });
  await rateLimiter.limit(ctx, "codeFailGlobal");
}
