import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { newAccount, setup } from "./helpers";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("hourly cleanup removes stale step counts and expired codes", async () => {
  const t = setup();
  const token = await newAccount(t, "Margaret");
  const deviceId = (await t.query(api.devices.list, { token }))[0].deviceId;
  const seniorId = (await t.run((ctx) => ctx.db.query("seniors").first()))!._id;
  const hour = Math.floor(Date.now() / 3_600_000);

  await t.run(async (ctx) => {
    await ctx.db.insert("stepCounts", { deviceId, hour: hour - 5, count: 3 });
    await ctx.db.insert("stepCounts", { deviceId, hour, count: 1 });
    await ctx.db.insert("pairingCodes", { seniorId, code: "111111", expiresAt: Date.now() - 1 });
    await ctx.db.insert("pairingCodes", { seniorId, code: "222222", expiresAt: Date.now() + 60_000 });
  });

  await t.mutation(internal.cleanup.run, {});

  const left = await t.run(async (ctx) => ({
    steps: (await ctx.db.query("stepCounts").collect()).map((r) => r.hour),
    codes: (await ctx.db.query("pairingCodes").collect()).map((r) => r.code),
  }));
  expect(left.steps).toEqual([hour]);
  expect(left.codes).toEqual(["222222"]);
});
