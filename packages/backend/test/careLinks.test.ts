import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { authUser, caregiver, newAccount, setup } from "./helpers";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("helper code links a signed-in caregiver once", async () => {
  const t = setup();
  const seniorToken = await newAccount(t, "Margaret");
  const { code, expiresAt } = await t.mutation(api.careLinks.createHelperCode, { token: seniorToken });
  expect(code).toMatch(/^\d{6}$/);
  expect(expiresAt - Date.now()).toBe(15 * 60 * 1000);

  const { as, caregiverId } = await caregiver(t, "Sam");
  const res = await as.mutation(api.careLinks.redeemHelperCode, { code, relation: "child" });
  expect(res?.displayName).toBe("Margaret");
  const links = await t.run((ctx) => ctx.db.query("careLinks").collect());
  expect(links).toEqual([expect.objectContaining({ caregiverId, seniorId: res!.seniorId, relation: "child" })]);

  // Single use.
  expect(await as.mutation(api.careLinks.redeemHelperCode, { code })).toBeNull();

  // A second code for an already-linked caregiver doesn't duplicate the link.
  const again = await t.mutation(api.careLinks.createHelperCode, { token: seniorToken });
  expect(await as.mutation(api.careLinks.redeemHelperCode, { code: again.code })).not.toBeNull();
  expect(await t.run((ctx) => ctx.db.query("careLinks").collect())).toHaveLength(1);

  // The caregiver can now assign tasks (existing caregiver API).
  process.env.JUSTASK_TASKCHECK_MOCK = "1";
  const check = await as.action(api.taskCheck.review, { seniorId: res!.seniorId, request: "refill my lisinopril on CVS", answers: [] });
  if (check.status !== "clear") throw new Error("expected clear");
  const taskId = await as.mutation(api.tasks.assign, { seniorId: res!.seniorId, checkId: check.checkId });
  expect(taskId).toBeTruthy();
  expect(await t.query(api.tasks.pendingForDevice, { token: seniorToken })).toHaveLength(1);
});

test("requires caregiver auth", async () => {
  const t = setup();
  const seniorToken = await newAccount(t);
  const { code } = await t.mutation(api.careLinks.createHelperCode, { token: seniorToken });
  await expect(t.mutation(api.careLinks.redeemHelperCode, { code })).rejects.toThrow(/not signed in/);
  // Signed in but no caregivers row.
  await expect((await authUser(t, "nobody")).as.mutation(api.careLinks.redeemHelperCode, { code })).rejects.toThrow(
    /no caregiver profile/,
  );
  await expect(t.mutation(api.careLinks.createHelperCode, { token: "nope" })).rejects.toThrow(/not paired/);
});

test("device codes can't be redeemed as helper codes; expired codes fail", async () => {
  const t = setup();
  const seniorToken = await newAccount(t);
  const { as } = await caregiver(t);
  const link = await t.mutation(api.devices.createLinkCode, { token: seniorToken });
  expect(await as.mutation(api.careLinks.redeemHelperCode, { code: link.code })).toBeNull();
  const helper = await t.mutation(api.careLinks.createHelperCode, { token: seniorToken });
  vi.advanceTimersByTime(15 * 60 * 1000 + 1);
  expect(await as.mutation(api.careLinks.redeemHelperCode, { code: helper.code })).toBeNull();
});

test("wrong helper codes are rate limited per caregiver", async () => {
  const t = setup();
  const { as } = await caregiver(t, "Sam");
  for (let i = 0; i < 10; i++) {
    // Spread across prefixes so only the per-caregiver bucket runs out.
    expect(await as.mutation(api.careLinks.redeemHelperCode, { code: `${300 + i}000` })).toBeNull();
  }
  await expect(as.mutation(api.careLinks.redeemHelperCode, { code: "500000" })).rejects.toThrow(/Too many tries/);
  // Another caregiver isn't affected.
  const other = await caregiver(t, "Ami");
  expect(await other.as.mutation(api.careLinks.redeemHelperCode, { code: "500000" })).toBeNull();
});
