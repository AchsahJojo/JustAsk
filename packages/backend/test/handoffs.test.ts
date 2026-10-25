import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { caregiver, desk, ext, linkDevice, newAccount, setup, type T } from "./helpers";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** The user's desktop app on pc-1 plus the browser on the same machine (machineId inherited). */
async function samePc(t: T) {
  const desktop = await newAccount(t, "Margaret", desk("pc-1"));
  const browser = await linkDevice(t, desktop, ext());
  return { desktop, browser };
}

const recipe = { startUrl: "https://zoom.us/j/1", steps: ["Open Zoom", "Join"] };

test("browser to desktop: create, pending, claim once", async () => {
  const t = setup();
  const { desktop, browser } = await samePc(t);
  const { handoffId } = await t.mutation(api.handoffs.create, { token: browser, toKind: "desktop", request: "join my zoom call", recipe });

  const pending = await t.query(api.handoffs.pendingForDevice, { token: desktop });
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({
      handoffId,
      request: "join my zoom call",
      taskId: null,
      recipe,
      note: "Continuing from your web browser.",
    });
  expect(pending[0].expiresAt - pending[0].createdAt).toBe(10 * 60 * 1000);
  // Wrong kind sees nothing.
  expect(await t.query(api.handoffs.pendingForDevice, { token: browser })).toEqual([]);
  expect(await t.mutation(api.handoffs.claim, { token: browser, handoffId })).toBeNull();

  expect(await t.mutation(api.handoffs.claim, { token: desktop, handoffId })).toEqual({ request: "join my zoom call", taskId: null, recipe });
  expect(await t.mutation(api.handoffs.claim, { token: desktop, handoffId })).toBeNull();
  expect(await t.query(api.handoffs.pendingForDevice, { token: desktop })).toEqual([]);
});

test("desktop to browser uses the desktop note", async () => {
  const t = setup();
  const { desktop, browser } = await samePc(t);
  const { handoffId } = await t.mutation(api.handoffs.create, { token: desktop, toKind: "extension", request: "pay my bill" });
  const [h] = await t.query(api.handoffs.pendingForDevice, { token: browser });
  expect(h.note).toBe("Continuing from the JustAsk app.");
  expect(await t.mutation(api.handoffs.claim, { token: browser, handoffId })).toEqual({ request: "pay my bill", taskId: null, recipe: null });
});

test("another machine's desktop can't see or claim it", async () => {
  const t = setup();
  const { desktop, browser } = await samePc(t);
  const otherPc = await linkDevice(t, desktop, desk("pc-2"));
  const { handoffId } = await t.mutation(api.handoffs.create, { token: browser, toKind: "desktop", request: "zoom" });
  expect(await t.query(api.handoffs.pendingForDevice, { token: otherPc })).toEqual([]);
  expect(await t.mutation(api.handoffs.claim, { token: otherPc, handoffId })).toBeNull();
  expect(await t.mutation(api.handoffs.claim, { token: desktop, handoffId })).not.toBeNull();
});

test("unknown machineId on either side fails closed", async () => {
  const t = setup();
  const browser = await newAccount(t, "Margaret", ext());
  const desktop = await linkDevice(t, browser, desk("pc-9"));
  const { handoffId } = await t.mutation(api.handoffs.create, { token: browser, toKind: "desktop", request: "zoom" });
  expect(await t.query(api.handoffs.pendingForDevice, { token: desktop })).toEqual([]);
  expect(await t.mutation(api.handoffs.claim, { token: desktop, handoffId })).toBeNull();
});

test("expires after 10 minutes and the scheduled job deletes it", async () => {
  const t = setup();
  const { desktop, browser } = await samePc(t);
  const { handoffId } = await t.mutation(api.handoffs.create, { token: browser, toKind: "desktop", request: "zoom" });
  vi.advanceTimersByTime(10 * 60 * 1000 + 1);
  expect(await t.query(api.handoffs.pendingForDevice, { token: desktop })).toEqual([]);
  expect(await t.mutation(api.handoffs.claim, { token: desktop, handoffId })).toBeNull();
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await t.run((ctx) => ctx.db.get(handoffId))).toBeNull();
});

test("cross-senior isolation: another account can't see or claim", async () => {
  const t = setup();
  const { browser } = await samePc(t);
  const ruthDesktop = await newAccount(t, "Ruth", desk("pc-1"));
  const { handoffId } = await t.mutation(api.handoffs.create, { token: browser, toKind: "desktop", request: "zoom" });
  expect(await t.query(api.handoffs.pendingForDevice, { token: ruthDesktop })).toEqual([]);
  expect(await t.mutation(api.handoffs.claim, { token: ruthDesktop, handoffId })).toBeNull();
});

test("request is clipped, taskId must be theirs, recipe is bounded", async () => {
  const t = setup();
  const { desktop, browser } = await samePc(t);
  await t.mutation(api.handoffs.create, { token: browser, toKind: "desktop", request: "x".repeat(500) });
  const [h] = await t.query(api.handoffs.pendingForDevice, { token: desktop });
  expect(h.request).toHaveLength(200);

  // A task for another senior.
  const { as, caregiverId } = await caregiver(t);
  const { seniorId } = await as.mutation(api.devices.createSeniorWithCode, { name: "R", displayName: "Ruth", relation: "son" });
  const taskId = await t.run((ctx) =>
    ctx.db.insert("tasks", { seniorId, assignedBy: caregiverId, title: "x", spokenPrompt: "x", status: "pending", createdAt: 0 }),
  );
  await expect(t.mutation(api.handoffs.create, { token: browser, toKind: "desktop", request: "r", taskId })).rejects.toThrow(/not found/);
  await expect(
    t.mutation(api.handoffs.create, { token: browser, toKind: "desktop", request: "r", recipe: { steps: Array(31).fill("s") } }),
  ).rejects.toThrow(/recipe/);
});

test("a revoked install can't create or claim", async () => {
  const t = setup();
  const { desktop, browser } = await samePc(t);
  const { handoffId } = await t.mutation(api.handoffs.create, { token: browser, toKind: "desktop", request: "zoom" });
  const deskId = (await t.query(api.devices.list, { token: browser })).find((d) => d.kind === "desktop")!.deviceId;
  await t.mutation(api.devices.revoke, { token: browser, deviceId: deskId });
  await expect(t.mutation(api.handoffs.claim, { token: desktop, handoffId })).rejects.toThrow(/not paired/);
  await expect(t.query(api.handoffs.pendingForDevice, { token: desktop })).rejects.toThrow(/not paired/);
});
