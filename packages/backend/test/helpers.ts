/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";

/** Every Convex module, for convex-test (the functions dir is ../convex). */
export const modules = import.meta.glob("../convex/**/*.*s");

/** A fresh in-memory backend with the rate-limiter component registered. */
export function setup() {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  return t;
}

export type T = ReturnType<typeof setup>;

export const ext = (machineId?: string) =>
  ({ kind: "extension", platform: "chrome-windows", label: "Chrome", ...(machineId ? { machineId } : {}) }) as const;
export const desk = (machineId?: string) =>
  ({ kind: "desktop", platform: "windows", label: "Margaret's PC", ...(machineId ? { machineId } : {}) }) as const;

/** createSelf, returning the token. */
export async function newAccount(t: T, displayName = "Margaret", device: ReturnType<typeof ext> | ReturnType<typeof desk> = ext()) {
  const { token } = await t.mutation(api.accounts.createSelf, { displayName, device });
  return token;
}

/** Link a second install to the account behind `token`. */
export async function linkDevice(t: T, token: string, device?: ReturnType<typeof ext> | ReturnType<typeof desk>) {
  const { code } = await t.mutation(api.devices.createLinkCode, { token });
  const res = await t.mutation(api.devices.redeemCode, { code, ...(device ? { device } : {}) });
  if (!res) throw new Error("link failed");
  return res.token;
}

/** A Convex Auth user with no `caregivers` row yet, and a client signed in as them. */
export async function authUser(t: T, name = "Sam") {
  const userId = await t.run((ctx) => ctx.db.insert("users", { name }));
  // Convex Auth's subject is `<userId>|<sessionId>`; getAuthUserId reads the first part.
  return { userId, as: t.withIdentity({ subject: `${userId}|test-session`, name }) };
}

/** A caregiver signed in through Convex Auth, with their `caregivers` row. */
export async function caregiver(t: T, name = "Sam") {
  const { userId, as } = await authUser(t, name);
  const caregiverId = await t.run((ctx) => ctx.db.insert("caregivers", { userId, name }));
  return { caregiverId, as };
}
