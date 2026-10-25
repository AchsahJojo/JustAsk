import { describe, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { caregiver, newAccount, setup, type T } from "./helpers";

async function activeTask(t: T) {
  const token = await newAccount(t);
  const { caregiverId } = await caregiver(t);
  const seniorId = await t.run(async (ctx) => (await ctx.db.query("seniors").first())!._id);
  // Only a linked helper hears about the user's tasks.
  await t.run((ctx) => ctx.db.insert("careLinks", { caregiverId, seniorId, relation: "son" }));
  const taskId = await t.run((ctx) =>
    ctx.db.insert("tasks", {
      seniorId,
      assignedBy: caregiverId,
      title: "Refill",
      spokenPrompt: "Refill the prescription",
      status: "active",
      createdAt: Date.now(),
    }),
  );
  const sessionId = await t.mutation(api.sessions.start, { token, request: "Refill the prescription", taskId });
  return { token, taskId, sessionId };
}

async function status(t: T, taskId: Id<"tasks">) {
  return t.run(async (ctx) => (await ctx.db.get(taskId))?.status);
}

describe("task status follows its session lifecycle", () => {
  test.each(["abandoned", "blocked"] as const)("%s returns an active task to pending", async (event) => {
    const t = setup();
    const { token, taskId, sessionId } = await activeTask(t);
    await t.mutation(api.sessions.logEvent, { token, sessionId, type: event });
    expect(await status(t, taskId)).toBe("pending");
    expect(await t.query(api.tasks.pendingForDevice, { token })).toHaveLength(1);
  });

  test("completion stays done after later non-completion events", async () => {
    const t = setup();
    const { token, taskId, sessionId } = await activeTask(t);
    await t.mutation(api.sessions.logEvent, { token, sessionId, type: "done" });
    await t.mutation(api.sessions.logEvent, { token, sessionId, type: "abandoned" });
    expect(await status(t, taskId)).toBe("done");
    expect(await t.query(api.tasks.pendingForDevice, { token })).toHaveLength(0);
  });

  test("explicit dismissal stays dismissed after session events", async () => {
    const t = setup();
    const { token, taskId, sessionId } = await activeTask(t);
    await t.mutation(api.tasks.setStatus, { token, taskId, status: "dismissed" });
    await t.mutation(api.sessions.logEvent, { token, sessionId, type: "done" });
    await t.mutation(api.sessions.logEvent, { token, sessionId, type: "blocked" });
    expect(await status(t, taskId)).toBe("dismissed");
    expect(await t.query(api.tasks.pendingForDevice, { token })).toHaveLength(0);
  });

  test("blocked task sends a consented stuck notification without page content", async () => {
    const t = setup();
    const { token, taskId, sessionId } = await activeTask(t);
    await t.mutation(api.prefs.set, {
      token,
      consent: { notifyOnComplete: false, notifyOnStuck: true },
    });

    await t.mutation(api.sessions.logEvent, { token, sessionId, type: "blocked" });

    expect(await status(t, taskId)).toBe("pending");
    const notifications = await t.run((ctx) => ctx.db.query("notifications").collect());
    expect(notifications).toHaveLength(1);
    expect(notifications[0].text).toBe('Margaret got stuck on "Refill".');
    expect(notifications[0].text).not.toContain("page content");
  });
});

describe("caregiver impact stats", () => {
  test("finished task: completion note, steps per task and Say that again counts", async () => {
    const t = setup();
    const token = await newAccount(t);
    const { caregiverId, as } = await caregiver(t);
    const seniorId = await t.run(async (ctx) => (await ctx.db.query("seniors").first())!._id);
    await t.run((ctx) => ctx.db.insert("careLinks", { caregiverId, seniorId, relation: "son" }));
    await t.mutation(api.prefs.set, { token, consent: { notifyOnComplete: true, notifyOnStuck: true } });
    const taskId = await t.run((ctx) =>
      ctx.db.insert("tasks", { seniorId, assignedBy: caregiverId, title: "Refill", spokenPrompt: "Refill", status: "active", createdAt: Date.now() }),
    );
    const sessionId = await t.mutation(api.sessions.start, { token, request: "Refill", taskId });
    for (const ms of [900, 1200, 1500, 2000]) await t.mutation(api.sessions.logEvent, { token, sessionId, type: "step_shown", latencyMs: ms });
    await t.mutation(api.sessions.logEvent, { token, sessionId, type: "repeat" });
    await t.mutation(api.sessions.logEvent, { token, sessionId, type: "done" });

    const note = (await t.run((ctx) => ctx.db.query("notifications").collect()))[0];
    expect(note.text).toBe('Margaret finished "Refill" and did every step themselves.');
    const page = await as.query(api.people.get, { seniorId });
    if (page.moved) throw new Error("moved");
    expect(page.stats).toEqual({ finished: 1, stuck: 0, medianStepMs: 1500, stepsPerTask: 4, repeats: 1 });
  });
});
