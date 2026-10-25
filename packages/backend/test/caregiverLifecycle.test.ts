import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { caregiver, newAccount, setup, type T } from "./helpers";

const DAY = 86_400_000;

async function linked(t: T, consent = false) {
  const token = await newAccount(t, "Alex");
  const cg = await caregiver(t);
  const seniorId = await t.run(async (ctx) => (await ctx.db.query("seniors").first())!._id);
  await t.run((ctx) => ctx.db.insert("careLinks", { caregiverId: cg.caregiverId, seniorId, relation: "child" }));
  if (consent) await t.run((ctx) => ctx.db.patch(seniorId, { consent: { notifyOnComplete: true, notifyOnStuck: true } }));
  return { token, seniorId, ...cg };
}

async function task(t: T, seniorId: Id<"seniors">, assignedBy: Id<"caregivers">, status: "pending" | "active" | "done" | "dismissed", createdAt = Date.now()) {
  return t.run((ctx) => ctx.db.insert("tasks", { seniorId, assignedBy, title: "Refill", spokenPrompt: "Refill it", status, createdAt }));
}

const get = (t: T, id: Id<"tasks">) => t.run((ctx) => ctx.db.get(id));
const notes = (t: T) => t.run((ctx) => ctx.db.query("notifications").collect());

describe("setStatus guard", () => {
  test("done stays done; no second notification", async () => {
    const t = setup();
    const { token, seniorId, caregiverId } = await linked(t, true);
    const id = await task(t, seniorId, caregiverId, "active");
    await t.mutation(api.tasks.setStatus, { token, taskId: id, status: "done" });
    expect(await notes(t)).toHaveLength(1);
    await t.mutation(api.tasks.setStatus, { token, taskId: id, status: "active" });
    await t.mutation(api.tasks.setStatus, { token, taskId: id, status: "pending" });
    await t.mutation(api.tasks.setStatus, { token, taskId: id, status: "done" });
    expect((await get(t, id))?.status).toBe("done");
    expect(await notes(t)).toHaveLength(1);
  });

  test("dismissed stays dismissed", async () => {
    const t = setup();
    const { token, seniorId, caregiverId } = await linked(t, true);
    const id = await task(t, seniorId, caregiverId, "dismissed");
    await t.mutation(api.tasks.setStatus, { token, taskId: id, status: "done" });
    expect((await get(t, id))?.status).toBe("dismissed");
    expect(await notes(t)).toHaveLength(0);
  });
});

describe("doneAt", () => {
  test("setStatus done sets doneAt; an old task finished now is in the done list", async () => {
    const t = setup();
    const { token, seniorId, caregiverId } = await linked(t);
    const id = await task(t, seniorId, caregiverId, "active", Date.now() - 20 * DAY);
    await t.mutation(api.tasks.setStatus, { token, taskId: id, status: "done" });
    const row = await get(t, id);
    expect(row?.doneAt).toBeGreaterThan(Date.now() - 60_000);
    const list = await t.query(api.tasks.listForDevice, { token });
    expect(list.done.map((d) => d.id)).toEqual([id]);
  });

  test("session done sets doneAt", async () => {
    const t = setup();
    const { token, seniorId, caregiverId } = await linked(t);
    const id = await task(t, seniorId, caregiverId, "active");
    const sessionId = await t.mutation(api.sessions.start, { token, request: "Refill", taskId: id });
    await t.mutation(api.sessions.logEvent, { token, sessionId, type: "done" });
    const row = await get(t, id);
    expect(row?.status).toBe("done");
    expect(row?.doneAt).toBeTypeOf("number");
  });
});

describe("caregiver view", () => {
  test("people.get shows a recent dismissed task as dismissed without consent", async () => {
    const t = setup();
    const { seniorId, caregiverId, as } = await linked(t);
    const recent = await task(t, seniorId, caregiverId, "dismissed");
    await task(t, seniorId, caregiverId, "dismissed", Date.now() - 20 * DAY);
    const page = await as.query(api.people.get, { seniorId });
    if (page.moved) throw new Error("moved");
    expect(page.tasks).toEqual([expect.objectContaining({ id: recent, status: "dismissed" })]);
  });

  test("people.list waiting counts active too without consent, pending only with consent", async () => {
    const t = setup();
    const { seniorId, caregiverId, as } = await linked(t);
    await task(t, seniorId, caregiverId, "pending");
    await task(t, seniorId, caregiverId, "active");
    expect((await as.query(api.people.list, {}))[0].waiting).toBe(2);
    await t.run((ctx) => ctx.db.patch(seniorId, { consent: { notifyOnComplete: true, notifyOnStuck: false } }));
    expect((await as.query(api.people.list, {}))[0].waiting).toBe(1);
  });

  test("leaveHelpers dismisses that helper's active tasks too", async () => {
    const t = setup();
    const { token, seniorId, caregiverId } = await linked(t);
    const a = await task(t, seniorId, caregiverId, "active");
    const p = await task(t, seniorId, caregiverId, "pending");
    await t.mutation(api.devices.leaveHelpers, { token, caregiverId });
    expect((await get(t, a))?.status).toBe("dismissed");
    expect((await get(t, p))?.status).toBe("dismissed");
  });
});

describe("readable errors", () => {
  beforeEach(() => void (process.env.JUSTASK_TASKCHECK_MOCK = "1"));
  afterEach(() => void delete process.env.JUSTASK_TASKCHECK_MOCK);

  test("assign with an expired check throws ConvexError with the text as data", async () => {
    const t = setup();
    const { seniorId, as } = await linked(t);
    const r = await as.action(api.taskCheck.review, { seniorId, request: "refill my lisinopril on CVS", answers: [] });
    if (r.status !== "clear") throw new Error("expected clear");
    await t.run((ctx) => ctx.db.patch(r.checkId, { expiresAt: Date.now() - 1 }));
    const err = await as.mutation(api.tasks.assign, { seniorId, checkId: r.checkId }).catch((e) => e);
    expect(err).toBeInstanceOf(ConvexError);
    expect((err as ConvexError<string>).data).toBe("That check is out of date. Check the task again before sending it.");
  });

  test("not paired is a ConvexError", async () => {
    const t = setup();
    const err = await t.query(api.tasks.pendingForDevice, { token: "nope" }).catch((e) => e);
    expect(err).toBeInstanceOf(ConvexError);
    expect((err as ConvexError<string>).data).toBe("not paired");
  });
});

test("redeemHelperCode default relation is empty", async () => {
  const t = setup();
  const seniorToken = await newAccount(t, "Margaret");
  const { code } = await t.mutation(api.careLinks.createHelperCode, { token: seniorToken });
  const { as } = await caregiver(t, "Sam");
  await as.mutation(api.careLinks.redeemHelperCode, { code });
  const [link] = await t.run((ctx) => ctx.db.query("careLinks").collect());
  expect(link.relation).toBe("");
});
