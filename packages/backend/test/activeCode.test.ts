import { expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import { caregiver, setup } from "./helpers";

test("the caregiver code is still shown after many device codes", async () => {
  const t = setup();
  const { as } = await caregiver(t);
  const created = await as.mutation(api.devices.createSeniorWithCode, {
    name: "Joan Hill",
    displayName: "Joan",
    relation: "Parent",
  });
  const redeemed = await t.mutation(api.devices.redeemCode, { code: created.code });
  expect(redeemed).not.toBeNull();
  const deviceId = (await t.run((ctx) => ctx.db.query("devices").first()))!._id;
  await t.run(async (ctx) => {
    for (let i = 0; i < 25; i++) {
      await ctx.db.insert("pairingCodes", {
        seniorId: created.seniorId,
        code: String(300000 + i),
        expiresAt: Date.now() + 60_000,
        purpose: "device",
        createdByDeviceId: deviceId,
      });
    }
  });
  const fresh = await as.mutation(api.devices.newCode, { seniorId: created.seniorId });
  expect(await as.query(api.devices.activeCode, { seniorId: created.seniorId })).toEqual({
    code: fresh.code,
    expiresAt: fresh.expiresAt,
  });
});
