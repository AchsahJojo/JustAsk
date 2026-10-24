import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { desk, ext, linkDevice, newAccount, setup } from "./helpers";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("hourly cleanup removes stale step counts, expired codes and expired handoffs", async () => {
  const t = setup();
  const desktop = await newAccount(t, "Margaret", desk("pc-1"));
  const browser = await linkDevice(t, desktop, ext());
  const deviceId = (await t.query(api.devices.list, { token: browser }))[0].deviceId;
  const seniorId = (await t.run((ctx) => ctx.db.query("seniors").first()))!._id;
  const hour = Math.floor(Date.now() / 3_600_000);

  await t.run(async (ctx) => {
    await ctx.db.insert("stepCounts", { deviceId, hour: hour - 5, count: 3 });
    await ctx.db.insert("stepCounts", { deviceId, hour, count: 1 });
    await ctx.db.insert("pairingCodes", { seniorId, code: "111111", expiresAt: Date.now() - 1 });
    await ctx.db.insert("pairingCodes", { seniorId, code: "222222", expiresAt: Date.now() + 60_000 });
    // An expired handoff whose scheduled delete was missed.
    await ctx.db.insert("handoffs", {
      seniorId,
      fromDeviceId: deviceId,
      toKind: "desktop",
      request: "old",
      note: "n",
      createdAt: 0,
      expiresAt: Date.now() - 1,
    });
  });
  const live = await t.mutation(api.handoffs.create, { token: browser, toKind: "desktop", request: "live" });

  await t.mutation(internal.cleanup.run, {});

  const left = await t.run(async (ctx) => ({
    steps: (await ctx.db.query("stepCounts").collect()).map((r) => r.hour),
    codes: (await ctx.db.query("pairingCodes").collect()).map((r) => r.code),
    handoffs: (await ctx.db.query("handoffs").collect()).map((r) => r._id),
  }));
  expect(left.steps).toEqual([hour]);
  expect(left.codes).toEqual(["222222"]);
  expect(left.handoffs).toEqual([live.handoffId]);
});
