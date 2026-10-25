import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { caregiver, ext, linkDevice, newAccount, setup } from "./helpers";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("accounts:createSelf", () => {
  test("creates the user's account and this install", async () => {
    const t = setup();
    const res = await t.mutation(api.accounts.createSelf, { displayName: "  Margaret ", device: ext() });
    expect(res.token).toMatch(/^[0-9a-f]{64}$/);
    expect(res.displayName).toBe("Margaret");
    expect(await t.query(api.devices.me, { token: res.token })).toEqual({
      displayName: "Margaret",
      consent: { notifyOnComplete: false, notifyOnStuck: false },
      helpers: [],
      showMeSetBy: null,
    });
    const devices = await t.query(api.devices.list, { token: res.token });
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ kind: "extension", platform: "chrome-windows", label: "Chrome", isThisDevice: true });
    expect(devices[0]).not.toHaveProperty("tokenHash");
    const seniors = await t.run((ctx) => ctx.db.query("seniors").collect());
    expect(seniors[0].createdBy).toBe("self");
    // Only the hash is stored.
    const rows = await t.run((ctx) => ctx.db.query("devices").collect());
    expect(rows[0].tokenHash).not.toBe(res.token);
  });

  test("validates lengths", async () => {
    const t = setup();
    await expect(t.mutation(api.accounts.createSelf, { displayName: "   ", device: ext() })).rejects.toThrow(/displayName/);
    await expect(t.mutation(api.accounts.createSelf, { displayName: "x".repeat(61), device: ext() })).rejects.toThrow(/displayName/);
    await expect(t.mutation(api.accounts.createSelf, { displayName: "M", device: { ...ext(), label: "x".repeat(81) } })).rejects.toThrow(/label/);
  });

  test("global creation rate limit", async () => {
    const t = setup();
    for (let i = 0; i < 60; i++) await newAccount(t, `M${i}`);
    await expect(newAccount(t, "one too many")).rejects.toThrow(/Too many tries/);
  });
});

describe("link codes", () => {
  test("redeem once, store device info, peek without consuming", async () => {
    const t = setup();
    const a = await newAccount(t);
    const { code, expiresAt } = await t.mutation(api.devices.createLinkCode, { token: a });
    expect(code).toMatch(/^\d{6}$/);
    expect(expiresAt - Date.now()).toBe(15 * 60 * 1000);

    expect(await t.mutation(api.devices.peekCode, { code })).toEqual({ displayName: "Margaret" });
    expect(await t.mutation(api.devices.peekCode, { code })).toEqual({ displayName: "Margaret" });

    const res = await t.mutation(api.devices.redeemCode, { code: ` ${code} `, device: ext("Edge") });
    expect(res?.displayName).toBe("Margaret");
    expect(await t.mutation(api.devices.redeemCode, { code })).toBeNull();
    expect(await t.mutation(api.devices.peekCode, { code })).toBeNull();

    const list = await t.query(api.devices.list, { token: res!.token });
    expect(list).toHaveLength(2);
    const me = list.find((d) => d.isThisDevice)!;
    expect(me).toMatchObject({ kind: "extension", platform: "chrome-windows", label: "Edge" });
  });

  test("codes expire after 15 minutes", async () => {
    const t = setup();
    const a = await newAccount(t);
    const { code } = await t.mutation(api.devices.createLinkCode, { token: a });
    vi.advanceTimersByTime(15 * 60 * 1000 + 1);
    expect(await t.mutation(api.devices.peekCode, { code })).toBeNull();
    expect(await t.mutation(api.devices.redeemCode, { code })).toBeNull();
  });

  test("malformed codes return null", async () => {
    const t = setup();
    expect(await t.mutation(api.devices.redeemCode, { code: "12ab" })).toBeNull();
    expect(await t.mutation(api.devices.peekCode, { code: "" })).toBeNull();
  });

  test("a browser inherits machineId from a code made on a desktop", async () => {
    const t = setup();
    const d = await newAccount(t, "Margaret", desk("pc-1"));
    const e = await linkDevice(t, d, ext());
    const mine = (await t.query(api.devices.list, { token: e })).find((x) => x.isThisDevice)!;
    expect(mine.machineId).toBe("pc-1");
  });

  test("a browser that already has its own account links to the desktop app: one account, desktop's machineId", async () => {
    const t = setup();
    const d = await newAccount(t, "Margaret", desk("pc-1"));
    const browser = await newAccount(t, "Maggie", ext());
    const { code } = await t.mutation(api.devices.createLinkCode, { token: d });
    const res = await t.mutation(api.devices.redeemCode, { code, token: browser });
    expect(res).toEqual({ token: browser, displayName: "Margaret" }); // joins the app's account, keeps its token
    const list = await t.query(api.devices.list, { token: browser });
    expect(list.map((x) => [x.kind, x.machineId]).sort()).toEqual([["desktop", "pc-1"], ["extension", "pc-1"]]);
    // Handoffs now match: the app can send a session to this browser.
    const { handoffId } = await t.mutation(api.handoffs.create, { token: d, toKind: "extension", request: "pay my water bill" });
    expect(await t.mutation(api.handoffs.claim, { token: browser, handoffId })).toMatchObject({ request: "pay my water bill" });
  });

  test("no machineId inheritance from an extension's code", async () => {
    const t = setup();
    const e1 = await newAccount(t, "Margaret", ext("browser-guess"));
    const e2 = await linkDevice(t, e1, ext());
    const mine = (await t.query(api.devices.list, { token: e2 })).find((x) => x.isThisDevice)!;
    expect(mine.machineId).toBeNull();
  });

  test("an explicit machineId wins over the inherited one", async () => {
    const t = setup();
    const d = await newAccount(t, "Margaret", desk("pc-1"));
    const d2 = await linkDevice(t, d, desk("pc-2"));
    const mine = (await t.query(api.devices.list, { token: d2 })).find((x) => x.isThisDevice)!;
    expect(mine.machineId).toBe("pc-2");
  });

  test("helper codes can't be redeemed as device codes", async () => {
    const t = setup();
    const a = await newAccount(t);
    const { code } = await t.mutation(api.careLinks.createHelperCode, { token: a });
    expect(await t.mutation(api.devices.peekCode, { code })).toBeNull();
    expect(await t.mutation(api.devices.redeemCode, { code })).toBeNull();
  });

  test("legacy caregiver pairing still works (redeemCode without device)", async () => {
    const t = setup();
    const { as } = await caregiver(t);
    const { code } = await as.mutation(api.devices.createSeniorWithCode, { name: "Margaret Hill", displayName: "Mom", relation: "son" });
    const res = await t.mutation(api.devices.redeemCode, { code });
    expect(res?.displayName).toBe("Mom");
    const list = await t.query(api.devices.list, { token: res!.token });
    expect(list[0]).toMatchObject({ kind: "extension", platform: "unknown" });
    // Pre-purpose rows (written by older code / devSeed) count as device codes.
    const seniorId = (await t.run((ctx) => ctx.db.query("seniors").first()))!._id;
    await t.run((ctx) => ctx.db.insert("pairingCodes", { seniorId, code: "246810", expiresAt: Date.now() + 60_000 }));
    expect(await t.mutation(api.devices.redeemCode, { code: "246810" })).not.toBeNull();
  });
});

describe("devices", () => {
  test("revoke kills the token everywhere", async () => {
    const t = setup();
    const a = await newAccount(t);
    const b = await linkDevice(t, a, ext());
    const bId = (await t.query(api.devices.list, { token: b })).find((x) => x.isThisDevice)!.deviceId;
    await t.mutation(api.devices.revoke, { token: a, deviceId: bId });
    await expect(t.query(api.devices.me, { token: b })).rejects.toThrow(/not paired/);
    await expect(t.query(api.devices.list, { token: b })).rejects.toThrow(/not paired/);
    await expect(t.mutation(api.devices.heartbeat, { token: b })).rejects.toThrow(/not paired/);
    await expect(t.query(api.tasks.pendingForDevice, { token: b })).rejects.toThrow(/not paired/);
    await expect(t.mutation(api.devices.createLinkCode, { token: b })).rejects.toThrow(/not paired/);
    expect(await t.query(api.devices.list, { token: a })).toHaveLength(1);
    // Revoking is idempotent.
    await t.mutation(api.devices.revoke, { token: a, deviceId: bId });
  });

  test("an install can revoke itself", async () => {
    const t = setup();
    const a = await newAccount(t);
    const aId = (await t.query(api.devices.list, { token: a }))[0].deviceId;
    await t.mutation(api.devices.revoke, { token: a, deviceId: aId });
    await expect(t.query(api.devices.me, { token: a })).rejects.toThrow(/not paired/);
  });

  test("cross-senior isolation: list and revoke", async () => {
    const t = setup();
    const m = await newAccount(t, "Margaret");
    const r = await newAccount(t, "Ruth");
    const ruthList = await t.query(api.devices.list, { token: r });
    expect(ruthList).toHaveLength(1);
    const margaretId = (await t.query(api.devices.list, { token: m }))[0].deviceId;
    expect(ruthList.some((d) => d.deviceId === margaretId)).toBe(false);
    await expect(t.mutation(api.devices.revoke, { token: r, deviceId: margaretId })).rejects.toThrow(/not found/);
    expect(await t.query(api.devices.me, { token: m })).not.toBeNull();
  });

  test("heartbeat writes at most once a minute", async () => {
    const t = setup();
    const a = await newAccount(t);
    const first = (await t.query(api.devices.list, { token: a }))[0].lastSeenAt!;
    vi.advanceTimersByTime(30_000);
    await t.mutation(api.devices.heartbeat, { token: a });
    expect((await t.query(api.devices.list, { token: a }))[0].lastSeenAt).toBe(first);
    vi.advanceTimersByTime(31_000);
    await t.mutation(api.devices.heartbeat, { token: a });
    expect((await t.query(api.devices.list, { token: a }))[0].lastSeenAt).toBe(first + 61_000);
  });

  test("bad token rejected", async () => {
    const t = setup();
    await expect(t.query(api.devices.list, { token: "nope" })).rejects.toThrow(/not paired/);
    await expect(t.mutation(api.devices.createLinkCode, { token: "" })).rejects.toThrow(/not paired/);
  });

  test("sessions:start records the device", async () => {
    const t = setup();
    const a = await newAccount(t);
    const sessionId = await t.mutation(api.sessions.start, { token: a, request: "help me" });
    const session = await t.run((ctx) => ctx.db.get(sessionId));
    const deviceId = (await t.query(api.devices.list, { token: a }))[0].deviceId;
    expect(session?.deviceId).toBe(deviceId);
  });
});
