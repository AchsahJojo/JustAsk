import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalMutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { TASK_CHECK_LIMITS, type TaskDraft } from "@justask/shared";
import { requireLink } from "./lib";
import { rateLimiter, TOO_MANY_TRIES } from "./rateLimits";
import { makeClient } from "../lib/planStep";
import { checkTask, mockCheck, type TaskCheckInput } from "../lib/taskCheck";

const CHECK_TTL_MS = 60 * 60 * 1000;

type ReviewResult =
  | { status: "question"; question: string }
  | { status: "clear"; checkId: Id<"taskChecks">; draft: TaskDraft }
  | { status: "error"; message: string };

const turn = v.object({ question: v.string(), answer: v.string() });
const draft = v.object({ title: v.string(), spokenPrompt: v.string(), startUrl: v.union(v.string(), v.null()), steps: v.array(v.string()) });

/** The caregiver is linked to this person; spends one unit of their task-check budget. Returns the person's first name. */
export const authorize = internalMutation({
  args: { seniorId: v.id("seniors") },
  returns: v.string(),
  handler: async (ctx, { seniorId }) => {
    const { cg } = await requireLink(ctx, seniorId);
    const { ok } = await rateLimiter.limit(ctx, "taskCheck", { key: cg._id });
    if (!ok) throw new ConvexError(TOO_MANY_TRIES);
    const s = await ctx.db.get(seniorId);
    return s?.displayName || s?.name?.split(" ")[0] || "them";
  },
});

/** Records a clear draft so tasks:assign can send it. */
export const record = internalMutation({
  args: { seniorId: v.id("seniors"), draft },
  returns: v.id("taskChecks"),
  handler: async (ctx, { seniorId, draft: d }) => {
    const { cg } = await requireLink(ctx, seniorId);
    const recipe = d.steps.length || d.startUrl ? { steps: d.steps, ...(d.startUrl ? { startUrl: d.startUrl } : {}) } : undefined;
    return ctx.db.insert("taskChecks", {
      caregiverId: cg._id,
      seniorId,
      title: d.title,
      spokenPrompt: d.spokenPrompt,
      ...(recipe ? { recipe } : {}),
      expiresAt: Date.now() + CHECK_TTL_MS,
    });
  },
});

/**
 * Caregiver: is this task clear enough for JustAsk to guide? Returns one question to answer, or
 * the finished draft plus a `checkId` that tasks:assign needs. Each answer (or a hand edit of the
 * draft) comes back here, until it's clear. Only the caregiver's words are sent to Claude.
 */
export const review = action({
  args: {
    seniorId: v.id("seniors"),
    request: v.string(),
    answers: v.array(turn),
    editedDraft: v.optional(draft),
  },
  returns: v.union(
    v.object({ status: v.literal("question"), question: v.string() }),
    v.object({ status: v.literal("clear"), checkId: v.id("taskChecks"), draft }),
    v.object({ status: v.literal("error"), message: v.string() }),
  ),
  handler: async (ctx, args): Promise<ReviewResult> => {
    const request = args.request.trim();
    if (!request) return { status: "question" as const, question: "What should JustAsk help them do?" };
    if (request.length > TASK_CHECK_LIMITS.request) return { status: "error" as const, message: `Keep it under ${TASK_CHECK_LIMITS.request} characters.` };
    if (args.answers.length > TASK_CHECK_LIMITS.answers) return { status: "error" as const, message: "That's a lot of back and forth. Start over and describe the task in one or two sentences." };
    const name: string = await ctx.runMutation(internal.taskCheck.authorize, { seniorId: args.seniorId });

    const input: TaskCheckInput = { name, request, answers: args.answers, editedDraft: (args.editedDraft as TaskDraft | undefined) ?? null };
    let reply;
    if (process.env.JUSTASK_TASKCHECK_MOCK === "1") reply = mockCheck(input);
    else {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) return { status: "error" as const, message: "JustAsk can't check tasks right now (the server isn't set up). Try again later." };
      const out = await checkTask(makeClient(key), input);
      // Numbers only in logs, never the caregiver's words.
      console.log("taskCheck", JSON.stringify({ ok: out.ok, clear: out.ok ? out.reply.clear : null, answers: args.answers.length }));
      if (!out.ok) return { status: "error" as const, message: "JustAsk couldn't check this task just now. Try again in a moment." };
      reply = out.reply;
    }
    if (!reply.clear || !reply.draft) return { status: "question" as const, question: reply.question ?? "What exactly should JustAsk help them do?" };
    const checkId: Id<"taskChecks"> = await ctx.runMutation(internal.taskCheck.record, { seniorId: args.seniorId, draft: reply.draft });
    return { status: "clear" as const, checkId, draft: reply.draft };
  },
});
