import { z } from "zod";

/** Limits for a task a caregiver sends. Checked in the caregiver app and again in Convex. */
export const TASK_LIMITS = { title: 80, spokenPrompt: 200, steps: 12, step: 200, startUrl: 2000 } as const;

/** A recipe's start page must be a plain web address. JustAsk opens it for the user, so no other schemes. */
export function isSafeStartUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === "https:" || u.protocol === "http:") && !!u.hostname && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** What a caregiver sees for a task. Without the senior's consent to share results, every sent task reads "sent". */
export type CaregiverTaskStatus = "sent" | "started" | "done" | "dismissed";

// ───────────── Task check: a task is held until it's clear enough for JustAsk to guide ─────────────

/** Limits for the clarifying conversation between the caregiver and JustAsk. */
export const TASK_CHECK_LIMITS = { request: 500, answer: 300, question: 300, answers: 10 } as const;

/** A task as the caregiver will send it, once the check says it's clear. */
export const TaskDraft = z
  .object({
    title: z.string(),
    spokenPrompt: z.string(),
    startUrl: z.string().nullable(),
    steps: z.array(z.string()),
  })
  .strict();
export type TaskDraft = z.infer<typeof TaskDraft>;

/** Claude's reply: either one question for the caregiver, or the finished draft. */
export const TaskCheckReply = z
  .object({
    clear: z.boolean(),
    question: z.string().nullable(),
    draft: TaskDraft.nullable(),
  })
  .strict();
export type TaskCheckReply = z.infer<typeof TaskCheckReply>;

/** JSON Schema for structured output (every field required, nullable via anyOf, no extra keys). */
export function taskCheckJsonSchema(): Record<string, unknown> {
  const raw = z.toJSONSchema(TaskCheckReply, { target: "draft-2020-12" }) as Record<string, unknown>;
  delete raw.$schema;
  return raw;
}

/** One question JustAsk asked and the caregiver's answer. */
export interface TaskCheckTurn {
  question: string;
  answer: string;
}

/** What the caregiver app gets back from `taskCheck:review`. */
export type TaskCheckResult =
  | { status: "question"; question: string }
  | { status: "clear"; checkId: string; draft: TaskDraft }
  | { status: "error"; message: string };
