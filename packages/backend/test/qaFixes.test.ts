import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { caregiver, ext, newAccount, setup, type T } from "./helpers";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Margaret on one computer, set up by Sam (caregiver code), plus Sam's signed-in client. */
async function setUpByCaregiver(t: T) {
  const { as, caregiverId } = await caregiver(t, "Sam");
  const { seniorId, code } = await as.mutation(api.devices.createSeniorWithCode, { name: "Margaret Lee", displayName: "Margaret", relation: "child" });
  const first = await t.mutation(api.devices.redeemCode, { code, device: ext() });
  if (!first) throw new Error("first setup failed");
  return { as, caregiverId, seniorId, token: first.token, first };
}

describe("a new computer waits for the user's Allow", () => {
  test("first setup with a caregiver's code needs no approval", async () => {
    const t = setup();
    const { first } = await setUpByCaregiver(t);
    expect(first.pending).toBe(false);
  });

  test("a caregiver's code typed on a second computer waits, and its token works for nothing", async () => {
    const t = setup();
    const { as, seniorId, token } = await setUpByCaregiver(t);
    const { code } = await as.mutation(api.devices.newCode, { seniorId });
    const second = await t.mutation(api.devices.redeemCode, { code, device: { ...ext(), label: "Sam's laptop" } });
    expect(second).toMatchObject({ pending: true, displayName: "Margaret" });

    await expect(t.query(api.tasks.listForDevice, { token: second!.token })).rejects.toThrow(/waiting for approval/);
    await expect(t.mutation(api.prefs.set, { token: second!.token, consent: { notifyOnComplete: true, notifyOnStuck: true } })).rejects.toThrow();
    expect(await t.query(api.devices.joinStatus, { token: second!.token })).toEqual({ status: "waiting", displayName: "Margaret" });

    // Margaret sees it on her own computer, and it isn't one of her devices yet.
    const me = await t.query(api.devices.me, { token });
    expect(me?.pendingDevices).toEqual([expect.objectContaining({ label: "Sam's laptop" })]);
    expect(await t.query(api.devices.list, { token })).toHaveLength(1);
    expect((await as.query(api.people.get, { seniorId })) as { devices: number }).toMatchObject({ devices: 1 });

    await t.mutation(api.devices.approve, { token, deviceId: me!.pendingDevices[0].deviceId });
    expect(await t.query(api.devices.joinStatus, { token: second!.token })).toEqual({ status: "ready", displayName: "Margaret" });
    expect(await t.query(api.tasks.listForDevice, { token: second!.token })).toEqual({ open: [], done: [] });
    expect(await t.query(api.devices.list, { token })).toHaveLength(2);
  });

  test("No, remove it: the waiting computer is unlinked", async () => {
    const t = setup();
    const { as, seniorId, token } = await setUpByCaregiver(t);
    const { code } = await as.mutation(api.devices.newCode, { seniorId });
    const second = await t.mutation(api.devices.redeemCode, { code, device: ext() });
    const deviceId = (await t.query(api.devices.me, { token }))!.pendingDevices[0].deviceId;
    await t.mutation(api.devices.deny, { token, deviceId });
    expect(await t.query(api.devices.joinStatus, { token: second!.token })).toEqual({ status: "gone", displayName: "" });
    expect((await t.query(api.devices.me, { token }))!.pendingDevices).toEqual([]);
  });

  test("a browser with its own account keeps it until Allow, then the profiles merge", async () => {
    const t = setup();
    const { as, seniorId, token } = await setUpByCaregiver(t);
    const sams = await newAccount(t, "Sam's own");
    const { code } = await as.mutation(api.devices.newCode, { seniorId });
    expect(await t.mutation(api.devices.redeemCode, { code, token: sams })).toMatchObject({ token: sams, pending: true });
    // Nothing merged yet: two profiles.
    expect(await t.run((ctx) => ctx.db.query("seniors").collect())).toHaveLength(2);
    const deviceId = (await t.query(api.devices.me, { token }))!.pendingDevices[0].deviceId;
    await t.mutation(api.devices.approve, { token, deviceId });
    expect(await t.run((ctx) => ctx.db.query("seniors").collect())).toHaveLength(1);
    expect(await t.query(api.devices.me, { token: sams })).toMatchObject({ displayName: "Margaret" });
  });

  test("No to a browser with its own account leaves it on that account", async () => {
    const t = setup();
    const { as, seniorId, token } = await setUpByCaregiver(t);
    const sams = await newAccount(t, "Sam's own");
    const { code } = await as.mutation(api.devices.newCode, { seniorId });
    await t.mutation(api.devices.redeemCode, { code, token: sams });
    const deviceId = (await t.query(api.devices.me, { token }))!.pendingDevices[0].deviceId;
    await t.mutation(api.devices.deny, { token, deviceId });
    expect(await t.query(api.devices.me, { token: sams })).toMatchObject({ displayName: "Sam's own" });
  });

  test("a code the user made on their own computer needs no approval", async () => {
    const t = setup();
    const { token } = await setUpByCaregiver(t);
    const { code } = await t.mutation(api.devices.createLinkCode, { token });
    expect(await t.mutation(api.devices.redeemCode, { code, device: ext() })).toMatchObject({ pending: false });
  });

  test("an unanswered computer is turned away after a day", async () => {
    const t = setup();
    const { as, seniorId } = await setUpByCaregiver(t);
    const { code } = await as.mutation(api.devices.newCode, { seniorId });
    const second = await t.mutation(api.devices.redeemCode, { code, device: ext() });
    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);
    await t.mutation(internal.cleanup.run, {});
    expect(await t.query(api.devices.joinStatus, { token: second!.token })).toMatchObject({ status: "gone" });
  });
});

/** An active task for Margaret from Sam, with a session attached, and consent to share both kinds of note. */
async function activeTask(t: T) {
  const token = await newAccount(t);
  const { caregiverId, as } = await caregiver(t);
  const seniorId = await t.run(async (ctx) => (await ctx.db.query("seniors").first())!._id);
  await t.run((ctx) => ctx.db.insert("careLinks", { caregiverId, seniorId, relation: "child" }));
  await t.mutation(api.prefs.set, { token, consent: { notifyOnComplete: true, notifyOnStuck: true } });
  const taskId = await t.run((ctx) =>
    ctx.db.insert("tasks", { seniorId, assignedBy: caregiverId, title: "Join the call", spokenPrompt: "Join", status: "active", createdAt: Date.now(), touchedAt: Date.now() }),
  );
  const sessionId = await t.mutation(api.sessions.start, { token, request: "Join", taskId });
  return { token, taskId, sessionId, as, seniorId };
}
const notes = (t: T) => t.run(async (ctx) => (await ctx.db.query("notifications").collect()).map((n) => n.text));
const task = (t: T, id: Id<"tasks">) => t.run((ctx) => ctx.db.get(id));

describe("session events", () => {
  test("deferred (no code yet) sends the task back, with no finished note", async () => {
    const t = setup();
    const { token, taskId, sessionId } = await activeTask(t);
    await t.mutation(api.sessions.logEvent, { token, sessionId, type: "deferred" });
    expect(await task(t, taskId)).toMatchObject({ status: "pending", lastOutcome: "deferred" });
    expect(await notes(t)).toEqual([]);
    // A late done for the same run changes nothing.
    await t.mutation(api.sessions.logEvent, { token, sessionId, type: "done" });
    expect((await task(t, taskId))?.status).toBe("pending");
  });

  test("five I'm stuck presses tell the helper once", async () => {
    const t = setup();
    const { token, sessionId } = await activeTask(t);
    for (let i = 0; i < 5; i++) await t.mutation(api.sessions.logEvent, { token, sessionId, type: "stuck" });
    expect(await notes(t)).toEqual(['Margaret got stuck on "Join the call".']);
  });

  test("made-up event types are dropped", async () => {
    const t = setup();
    const { token, sessionId } = await activeTask(t);
    await t.mutation(api.sessions.logEvent, { token, sessionId, type: "x".repeat(50) });
    expect(await t.run((ctx) => ctx.db.query("events").collect())).toEqual([]);
  });

  test("a session can't attach someone else's task", async () => {
    const t = setup();
    const { taskId } = await activeTask(t);
    const other = await newAccount(t, "Stranger");
    await expect(t.mutation(api.sessions.start, { token: other, request: "x", taskId })).rejects.toThrow(/not found/);
  });
});

describe("tasks that went quiet", () => {
  test("a started task with no word for 2 hours goes back to the list", async () => {
    const t = setup();
    const { taskId } = await activeTask(t);
    vi.advanceTimersByTime(2 * 60 * 60 * 1000 + 1);
    await t.mutation(internal.cleanup.run, {});
    expect(await task(t, taskId)).toMatchObject({ status: "pending", lastOutcome: "abandoned" });
  });

  test("the caregiver can take back a started task after 30 quiet minutes, not before", async () => {
    const t = setup();
    const { taskId, as } = await activeTask(t);
    await expect(as.mutation(api.tasks.cancel, { taskId })).rejects.toThrow(/already started/);
    vi.advanceTimersByTime(31 * 60 * 1000);
    await as.mutation(api.tasks.cancel, { taskId });
    expect(await task(t, taskId)).toBeNull();
  });
});
