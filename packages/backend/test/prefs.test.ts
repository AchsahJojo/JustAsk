import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { caregiver, linkDevice, newAccount, setup } from "./helpers";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("defaults", async () => {
  const t = setup();
  const a = await newAccount(t);
  expect(await t.query(api.prefs.get, { token: a })).toEqual({
    displayName: "Margaret",
    voice: "cartesia",
    rate: 1,
    showMeInstead: true,
    consent: { notifyOnComplete: false, notifyOnStuck: false },
  });
});

test("caregiver-created seniors (no prefs field) get defaults too", async () => {
  const t = setup();
  const { as } = await caregiver(t);
  const { code } = await as.mutation(api.devices.createSeniorWithCode, { name: "M", displayName: "Pat", relation: "child" });
  const res = await t.mutation(api.devices.redeemCode, { code });
  expect(await t.query(api.prefs.get, { token: res!.token })).toMatchObject({ voice: "cartesia", rate: 1, showMeInstead: true });
});

test("set merges and syncs across installs", async () => {
  const t = setup();
  const a = await newAccount(t);
  const b = await linkDevice(t, a);
  const out = await t.mutation(api.prefs.set, { token: a, rate: 0.8, showMeInstead: false });
  expect(out).toMatchObject({ voice: "cartesia", rate: 0.8, showMeInstead: false });
  await t.mutation(api.prefs.set, { token: b, voice: "cartesia", consent: { notifyOnComplete: true, notifyOnStuck: true } });
  expect(await t.query(api.prefs.get, { token: a })).toEqual({
    displayName: "Margaret",
    voice: "cartesia",
    rate: 0.8,
    showMeInstead: false,
    consent: { notifyOnComplete: true, notifyOnStuck: true },
  });
  // Consent is the same field devices:me / devices:setConsent use.
  expect((await t.query(api.devices.me, { token: a }))?.consent).toEqual({ notifyOnComplete: true, notifyOnStuck: true });
});

test("rate must be 0.5 to 1.5", async () => {
  const t = setup();
  const a = await newAccount(t);
  for (const rate of [0.4, 1.6, NaN, Infinity, -1]) {
    await expect(t.mutation(api.prefs.set, { token: a, rate })).rejects.toThrow(/rate/);
  }
  await t.mutation(api.prefs.set, { token: a, rate: 0.5 });
  await t.mutation(api.prefs.set, { token: a, rate: 1.5 });
  expect((await t.query(api.prefs.get, { token: a })).rate).toBe(1.5);
});

test("bad voice rejected by the validator; bad token rejected", async () => {
  const t = setup();
  const a = await newAccount(t);
  await expect(t.mutation(api.prefs.set, { token: a, voice: "robot" as never })).rejects.toThrow();
  await expect(t.query(api.prefs.get, { token: "nope" })).rejects.toThrow(/not paired/);
});

test("JustAsk guides by default; only an explicit choice lets it click (older accounts stored the old default)", async () => {
  const t = setup();
  const a = await newAccount(t);
  const seniorId = await t.run(async (ctx) => (await ctx.db.query("seniors").first())!._id);
  // An account from before the change: showMeInstead false stored, nobody chose it.
  await t.run((ctx) => ctx.db.patch(seniorId, { prefs: { voice: "cartesia", rate: 1, showMeInstead: false } }));
  expect((await t.query(api.prefs.get, { token: a })).showMeInstead).toBe(true);
  await t.mutation(api.prefs.set, { token: a, showMeInstead: false }); // the user opts in to clicking
  expect((await t.query(api.prefs.get, { token: a })).showMeInstead).toBe(false);
});
