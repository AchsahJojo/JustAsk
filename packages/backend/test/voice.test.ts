import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { newAccount, setup } from "./helpers";

const KEY = "sk_car_test_secret";
let saved: string | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  saved = process.env.CARTESIA_API_KEY;
  process.env.CARTESIA_API_KEY = KEY;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (saved === undefined) delete process.env.CARTESIA_API_KEY;
  else process.env.CARTESIA_API_KEY = saved;
});

test("mints a short-lived token and never returns the key", async () => {
  const t = setup();
  const token = await newAccount(t, "Margaret");
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ token: "ctok_123" }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);

  const res = await t.action(api.voice.cartesiaToken, { token });
  expect(res).toEqual({ token: "ctok_123", expiresAt: Date.now() + 600_000 });
  expect(JSON.stringify(res)).not.toContain(KEY);

  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("https://api.cartesia.ai/access-token");
  const headers = init.headers as Record<string, string>;
  expect(headers.Authorization).toBe(`Bearer ${KEY}`);
  expect(headers["X-API-Key"]).toBe(KEY);
  expect(headers["Cartesia-Version"]).toBe("2026-08-14");
  expect(JSON.parse(init.body as string)).toEqual({ grants: { stt: true, tts: true }, expires_in: 600 });
});

test("needs a paired device and a configured key", async () => {
  const t = setup();
  vi.stubGlobal("fetch", vi.fn());
  await expect(t.action(api.voice.cartesiaToken, { token: "nope" })).rejects.toThrow(/not paired/);
  const token = await newAccount(t);
  delete process.env.CARTESIA_API_KEY;
  await expect(t.action(api.voice.cartesiaToken, { token })).rejects.toThrow(/server not configured/);
});

test("upstream errors don't leak details; per-device budget", async () => {
  const t = setup();
  const token = await newAccount(t);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("bad key sk_car_test_secret", { status: 401 })));
  await expect(t.action(api.voice.cartesiaToken, { token })).rejects.toThrow(/voice service unavailable/);

  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ token: "t" }), { status: 200 })));
  // Capacity 10, one already spent above.
  for (let i = 0; i < 9; i++) await t.action(api.voice.cartesiaToken, { token });
  await expect(t.action(api.voice.cartesiaToken, { token })).rejects.toThrow(/Too many tries/);
});
