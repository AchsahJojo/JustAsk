import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { newAccount, setup, type T } from "./helpers";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** A live device code with a chosen value (so tests control its 3-digit prefix). */
async function codeFor(t: T, code: string) {
  await newAccount(t);
  const seniorId = (await t.run((ctx) => ctx.db.query("seniors").first()))!._id;
  await t.run((ctx) => ctx.db.insert("pairingCodes", { seniorId, code, expiresAt: Date.now() + 15 * 60 * 1000, purpose: "device" }));
}

test("10 wrong codes in one prefix lock that prefix only, then it refills", async () => {
  const t = setup();
  await codeFor(t, "123999");
  await codeFor(t, "456999");
  for (let i = 0; i < 10; i++) {
    expect(await t.mutation(api.devices.redeemCode, { code: `12300${i}` })).toBeNull();
  }
  await expect(t.mutation(api.devices.redeemCode, { code: "123010" })).rejects.toThrow(/Too many tries/);
  // Locked out: even the right code in that prefix is refused (no oracle for brute force).
  await expect(t.mutation(api.devices.redeemCode, { code: "123999" })).rejects.toThrow(/Too many tries/);
  await expect(t.mutation(api.devices.peekCode, { code: "123999" })).rejects.toThrow(/Too many tries/);
  // Other prefixes are unaffected: no global lockout from one bucket.
  expect(await t.mutation(api.devices.redeemCode, { code: "456999" })).not.toBeNull();

  vi.advanceTimersByTime(60_000);
  expect(await t.mutation(api.devices.redeemCode, { code: "123999" })).not.toBeNull();
});

test("wrong peeks count too", async () => {
  const t = setup();
  for (let i = 0; i < 10; i++) expect(await t.mutation(api.devices.peekCode, { code: `77700${i}` })).toBeNull();
  await expect(t.mutation(api.devices.redeemCode, { code: "777777" })).rejects.toThrow(/Too many tries/);
});

test("the global cap stops guesses spread across prefixes", async () => {
  const t = setup();
  // 120 failures (the global capacity) spread over 12 prefixes, under each prefix's limit of 10.
  for (let p = 0; p < 12; p++) {
    for (let i = 0; i < 10; i++) {
      expect(await t.mutation(api.devices.redeemCode, { code: `${200 + p}00${i}` })).toBeNull();
    }
  }
  await expect(t.mutation(api.devices.redeemCode, { code: "999000" })).rejects.toThrow(/Too many tries/);
  vi.advanceTimersByTime(60_000);
  expect(await t.mutation(api.devices.redeemCode, { code: "999000" })).toBeNull();
});

test("successful redeems don't consume the limit", async () => {
  const t = setup();
  const a = await newAccount(t);
  for (let i = 0; i < 15; i++) {
    const { code } = await t.mutation(api.devices.createLinkCode, { token: a });
    expect(await t.mutation(api.devices.redeemCode, { code })).not.toBeNull();
  }
});
