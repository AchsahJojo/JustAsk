import { z } from "zod";
import { PageSnapshot } from "./snapshot";
import { StepResponse } from "./step";

export const Recipe = z.object({
  startUrl: z.string().url().optional(),
  steps: z.array(z.string()),
});
export type Recipe = z.infer<typeof Recipe>;

/** Body of POST /plan (Convex HTTP action, or the local dev planner). */
export const PlanRequest = z.object({
  deviceToken: z.string().nullable(),
  sessionId: z.string().nullable(),
  request: z.string().min(1).max(500),
  history: z.array(z.string()).max(60),
  recipe: Recipe.nullable(),
  snapshot: PageSnapshot,
  /** Set on the single re-plan after a failed check, so the model knows what went wrong. */
  retryNote: z.string().nullable(),
});
export type PlanRequest = z.infer<typeof PlanRequest>;

export const PlanResponse = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), snapshotId: z.string(), step: StepResponse, latencyMs: z.number() }),
  z.object({ ok: z.literal(false), error: z.string(), retryable: z.boolean() }),
]);
export type PlanResponse = z.infer<typeof PlanResponse>;

export const EventType = z.enum(["step_shown", "repeat", "clarify", "stuck", "no_change", "done", "abandoned", "blocked", "assist_fill"]);
export type EventType = z.infer<typeof EventType>;
