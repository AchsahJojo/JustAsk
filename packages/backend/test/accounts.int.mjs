// Accounts integration check against a local Convex deployment (`npx convex dev` with JWT_PRIVATE_KEY,
// JWKS and SITE_URL set). Covers caregiver auth, standalone seniors and pairing edge cases.
// Run: node packages/backend/test/accounts.int.mjs
import { ConvexHttpClient } from "convex/browser";
import assert from "node:assert/strict";

const URL = process.env.CONVEX_URL ?? "http://127.0.0.1:3210";
const anon = new ConvexHttpClient(URL);
const run = Date.now().toString(36);
const ok = (m) => console.log("✓", m);
const device = { kind: "extension", platform: "test", label: "Chrome" };
const createSelf = (displayName) => anon.mutation("accounts:createSelf", { displayName, device });

async function caregiver(name) {
  const c = new ConvexHttpClient(URL);
  const email = `${name.toLowerCase()}-${run}@example.com`;
  const res = await c.action("auth:signIn", { provider: "password", params: { email, password: "correct horse", name, flow: "signUp" } });
  assert.ok(res.tokens?.token, "sign-up returns a token");
  c.setAuth(res.tokens.token);
  await c.mutation("caregivers:ensureProfile", { name });
  return { c, email };
}

// --- Caregiver auth ---
const sam = await caregiver("Sam");
assert.equal((await sam.c.query("caregivers:me", {})).name, "Sam");
const again = await sam.c.mutation("caregivers:ensureProfile", { name: "Other" });
assert.equal((await sam.c.query("caregivers:me", {})).name, "Sam", "ensureProfile is idempotent");
assert.ok(again);
ok("caregiver signs up, profile created once");

const signIn = await anon.action("auth:signIn", { provider: "password", params: { email: sam.email, password: "correct horse", flow: "signIn" } });
assert.ok(signIn.tokens?.token);
await assert.rejects(anon.action("auth:signIn", { provider: "password", params: { email: sam.email, password: "wrong pass!", flow: "signIn" } }));
await assert.rejects(anon.action("auth:signIn", { provider: "password", params: { email: sam.email, password: "attacker pw!", flow: "signUp" } }), /already exists/);
await assert.rejects(anon.action("auth:signIn", { provider: "password", params: { email: `x-${run}@example.com`, password: "short", flow: "signUp" } }), /8 characters/);
await assert.rejects(anon.action("auth:signIn", { provider: "password", params: { email: "not-an-email", password: "long enough", flow: "signUp" } }), /valid email/);
ok("sign-in works; wrong password, duplicate email, short password, bad email rejected");

await assert.rejects(anon.query("people:list", {}), /not signed in/);
await assert.rejects(anon.mutation("devices:createSeniorWithCode", { name: "X", displayName: "X", relation: "" }), /not signed in/);
ok("caregiver functions need a session");

// --- Standalone senior (no caregiver) ---
const { token: solo } = await createSelf("  Margaret  ");
assert.equal(solo.length, 64);
const meSolo = await anon.query("devices:me", { token: solo });
assert.equal(meSolo.displayName, "Margaret");
assert.deepEqual(meSolo.helpers, []);
assert.deepEqual(await anon.query("tasks:pendingForDevice", { token: solo }), []);
const soloSession = await anon.mutation("sessions:start", { token: solo, request: "check my email" });
await anon.mutation("sessions:logEvent", { token: solo, sessionId: soloSession, type: "done" });
ok("standalone senior works with no caregiver (tasks empty, sessions log)");

// --- Caregiver sets up a new senior on a fresh computer ---
const { seniorId: momId, code } = await sam.c.mutation("devices:createSeniorWithCode", { name: "Joan Hill", displayName: "Mom", relation: "Mother" });
assert.match(code, /^\d{6}$/);
assert.equal((await sam.c.query("devices:activeCode", { seniorId: momId })).code, code);
let list = await sam.c.query("people:list", {});
assert.equal(list.find((p) => p.id === momId).connected, false);
await assert.rejects(sam.c.mutation("devices:createSeniorWithCode", { name: "   ", displayName: "", relation: "" }), /Add their name/);
const bad = await anon.mutation("devices:redeemCode", { code: "000000" });
assert.equal(bad, null);
const fresh = await anon.mutation("devices:redeemCode", { code: ` ${code.slice(0, 3)} ${code.slice(3)} ` });
assert.ok(fresh?.token);
assert.equal(fresh.displayName, "Mom");
assert.equal(await anon.mutation("devices:redeemCode", { code }), null, "code works once");
list = await sam.c.query("people:list", {});
assert.equal(list.find((p) => p.id === momId).connected, true);
assert.equal(await sam.c.query("devices:activeCode", { seniorId: momId }), null);
ok("caregiver-made profile pairs once (spaces tolerated), shows connected");

// --- Tasks: validation, delivery, cancel ---
await assert.rejects(sam.c.mutation("tasks:assign", { seniorId: momId, title: "  " }), /short name/);
await assert.rejects(sam.c.mutation("tasks:assign", { seniorId: momId, title: "X", recipe: { startUrl: "javascript:alert(1)", steps: [] } }), /web address/);
await assert.rejects(sam.c.mutation("tasks:assign", { seniorId: momId, title: "X", recipe: { startUrl: "https://u:p@evil.com", steps: [] } }), /web address/);
await assert.rejects(sam.c.mutation("tasks:assign", { seniorId: momId, title: "X", recipe: { steps: Array(13).fill("step") } }), /12 steps/);
const t1 = await sam.c.mutation("tasks:assign", { seniorId: momId, title: "Refill your prescription", recipe: { startUrl: "https://pharmacy.example/", steps: ["Click Refill", " ", "Pick up in store"] } });
const pending = await anon.query("tasks:pendingForDevice", { token: fresh.token });
assert.equal(pending.length, 1);
assert.equal(pending[0].from, "Sam");
assert.equal(pending[0].spokenPrompt, "Refill your prescription", "spoken prompt defaults to the title");
assert.deepEqual(pending[0].recipe.steps, ["Click Refill", "Pick up in store"], "blank steps dropped");
const t2 = await sam.c.mutation("tasks:assign", { seniorId: momId, title: "Join the Zoom call" });
await sam.c.mutation("tasks:cancel", { taskId: t2 });
assert.equal((await anon.query("tasks:pendingForDevice", { token: fresh.token })).length, 1);
ok("task validation (blank title, javascript:, credentials in URL, too many steps), delivery, cancel");

// --- Consent gates what the caregiver sees ---
let mom = await sam.c.query("people:get", { seniorId: momId });
assert.equal(mom.stats, null, "no stats without consent");
await anon.mutation("tasks:setStatus", { token: fresh.token, taskId: t1, status: "active" }); // she pressed Start
const s1 = await anon.mutation("sessions:start", { token: fresh.token, request: "refill", taskId: t1 });
await anon.mutation("sessions:logEvent", { token: fresh.token, sessionId: s1, type: "step_shown", latencyMs: 800 });
await anon.mutation("sessions:logEvent", { token: fresh.token, sessionId: s1, type: "done" });
mom = await sam.c.query("people:get", { seniorId: momId });
assert.equal(mom.tasks.find((t) => t.id === t1).status, "sent", "status hidden without consent");
assert.equal((await sam.c.query("activity:feed", {})).length, 0, "no note without consent");
await anon.mutation("devices:setConsent", { token: fresh.token, notifyOnComplete: true, notifyOnStuck: false });
mom = await sam.c.query("people:get", { seniorId: momId });
assert.equal(mom.tasks.find((t) => t.id === t1).status, "done");
assert.equal(mom.stats.finished, 1);
assert.equal(mom.stats.stuck, null, "stuck count hidden without stuck consent");
assert.equal(mom.stats.medianStepMs, 800);
await assert.rejects(sam.c.mutation("tasks:cancel", { taskId: t1 }), /already started/);
ok("consent off: status 'sent', no note, no stats; consent on: real status + stats");

// --- Isolation between caregivers ---
const ana = await caregiver("Ana");
await assert.rejects(ana.c.query("people:get", { seniorId: momId }), /not your senior/);
await assert.rejects(ana.c.mutation("tasks:assign", { seniorId: momId, title: "Hi" }), /not your senior/);
await assert.rejects(ana.c.mutation("devices:newCode", { seniorId: momId }), /not your senior/);
await assert.rejects(ana.c.mutation("tasks:cancel", { taskId: t1 }), /not found/);
assert.deepEqual(await ana.c.query("people:list", {}), []);
ok("another caregiver can't see, task, re-code or cancel");

// --- Standalone senior connects to a caregiver later: profiles merge, her own is kept ---
const { seniorId: aliceId, code: aliceCode } = await ana.c.mutation("devices:createSeniorWithCode", { name: "Alice Park", displayName: "Grandma", relation: "Grandmother" });
await ana.c.mutation("tasks:assign", { seniorId: aliceId, title: "Video call Ana" });
const merged = await anon.mutation("devices:redeemCode", { code: aliceCode, token: solo });
assert.ok(merged);
assert.equal(merged.token, solo, "keeps the same device token");
assert.equal(merged.displayName, "Margaret", "her own name wins");
const meMerged = await anon.query("devices:me", { token: solo });
assert.deepEqual(meMerged.helpers.map((h) => h.name), ["Ana"]);
assert.equal((await anon.query("tasks:pendingForDevice", { token: solo }))[0].title, "Video call Ana", "task sent before pairing arrives");
const anaList = await ana.c.query("people:list", {});
assert.equal(anaList.length, 1);
assert.equal(anaList[0].connected, true);
assert.equal(anaList[0].name, "Alice Park");
const aliceNewId = anaList[0].id;
assert.notEqual(aliceNewId, aliceId, "caregiver's empty placeholder merged into her profile");
assert.deepEqual(await ana.c.query("people:get", { seniorId: aliceId }), { moved: true, movedTo: aliceNewId }, "old page id redirects");
await assert.rejects(sam.c.query("people:get", { seniorId: aliceId }), /not your senior/, "redirect doesn't leak to other caregivers");
ok("standalone senior + caregiver code: one profile, same token, her name kept, task carried over");

// --- A second caregiver joins the same senior; a second computer joins an in-use profile ---
const { code: momCode2 } = await sam.c.mutation("devices:newCode", { seniorId: momId });
const laptop2 = await anon.mutation("devices:redeemCode", { code: momCode2 });
assert.ok(laptop2);
assert.notEqual(laptop2.token, fresh.token);
assert.equal((await sam.c.query("people:get", { seniorId: momId })).devices, 2);
const { code: c3 } = await sam.c.mutation("devices:newCode", { seniorId: momId });
const { code: c4 } = await sam.c.mutation("devices:newCode", { seniorId: momId });
assert.equal(await anon.mutation("devices:redeemCode", { code: c3 }), null, "a new code replaces the old one");
// A standalone install typing the code of an already-connected profile joins that profile.
const { token: solo2 } = await createSelf("Joe");
const joined = await anon.mutation("devices:redeemCode", { code: c4, token: solo2 });
assert.ok(joined);
assert.equal(joined.displayName, "Mom");
assert.equal((await sam.c.query("people:get", { seniorId: momId })).devices, 3);
ok("second computer, code replacement, standalone joining an in-use profile");

// --- Re-pair with a stale token is treated as a new install ---
const { code: c5 } = await sam.c.mutation("devices:newCode", { seniorId: momId });
const stale = await anon.mutation("devices:redeemCode", { code: c5, token: "f".repeat(64) });
assert.ok(stale);
assert.notEqual(stale.token, "f".repeat(64));
ok("stale token on redeem gets a fresh device");

// --- Senior disconnects: JustAsk keeps working, helper is told, their waiting tasks go away ---
await sam.c.mutation("tasks:assign", { seniorId: momId, title: "Pay the water bill" });
await anon.mutation("devices:leaveHelpers", { token: fresh.token });
assert.deepEqual((await anon.query("devices:me", { token: fresh.token })).helpers, []);
assert.deepEqual(await anon.query("tasks:pendingForDevice", { token: fresh.token }), []);
await anon.mutation("sessions:start", { token: fresh.token, request: "still works" });
assert.deepEqual(await sam.c.query("people:list", {}), []);
assert.match((await sam.c.query("activity:feed", {}))[0].text, /disconnected/);
await assert.rejects(sam.c.mutation("tasks:assign", { seniorId: momId, title: "Hi" }), /not your senior/);
ok("senior disconnects: still works alone, helper notified, can't send tasks");

// --- Caregiver removes someone ---
const { seniorId: ghost, code: ghostCode } = await sam.c.mutation("devices:createSeniorWithCode", { name: "Never Paired", displayName: "", relation: "" });
await sam.c.mutation("people:remove", { seniorId: ghost });
assert.equal(await anon.mutation("devices:redeemCode", { code: ghostCode }), null, "unused profile and its code deleted");
await ana.c.mutation("people:remove", { seniorId: aliceNewId });
assert.deepEqual((await anon.query("devices:me", { token: solo })).helpers, []);
assert.deepEqual(await anon.query("tasks:pendingForDevice", { token: solo }), []);
await anon.mutation("sessions:start", { token: solo, request: "still mine" });
ok("caregiver remove: unpaired profile deleted; paired senior keeps working alone");

// --- Notes go only to linked helpers; mark read ---
await ana.c.mutation("activity:markAllRead", {});
assert.equal((await ana.c.query("activity:feed", {})).every((n) => n.read), true);
ok("activity mark-all-read");

// --- Her task list persists: started tasks stay open, "I did it" moves them to done ---
{
  const kim = await caregiver("Kim");
  const { seniorId, code } = await kim.c.mutation("devices:createSeniorWithCode", { name: "Lee Park", displayName: "Dad", relation: "Father" });
  const { token: t } = await anon.mutation("devices:redeemCode", { code });
  await anon.mutation("devices:setConsent", { token: t, notifyOnComplete: true, notifyOnStuck: false });
  const a = await kim.c.mutation("tasks:assign", { seniorId, title: "Pay the gas bill" });
  const b = await kim.c.mutation("tasks:assign", { seniorId, title: "Book a haircut" });
  await anon.mutation("tasks:setStatus", { token: t, taskId: a, status: "active" }); // pressed Start, then closed the panel
  let list = await anon.query("tasks:listForDevice", { token: t });
  assert.deepEqual(list.open.map((x) => [x.title, x.status]), [["Pay the gas bill", "active"], ["Book a haircut", "pending"]]);
  assert.equal(list.open[0].from, "Kim");
  await anon.mutation("tasks:setStatus", { token: t, taskId: a, status: "done" });
  await anon.mutation("tasks:setStatus", { token: t, taskId: b, status: "dismissed" });
  list = await anon.query("tasks:listForDevice", { token: t });
  assert.deepEqual(list.open, []);
  assert.deepEqual(list.done.map((x) => x.title), ["Pay the gas bill"]);
  assert.match((await kim.c.query("activity:feed", {}))[0].text, /Dad finished "Pay the gas bill"/);
  await assert.rejects(anon.query("tasks:listForDevice", { token: "nope" }), /not paired/);
  ok("task list: started task stays open after closing; I did it → done + note; removed tasks leave");
}

// --- Show me instead: she or a linked caregiver can change it; the caregiver's choice carries over ---
{
  const jo = await caregiver("Jo");
  const { seniorId, code } = await jo.c.mutation("devices:createSeniorWithCode", { name: "Ruth Ng", displayName: "Gran", relation: "Grandmother" });
  await jo.c.mutation("people:setShowMe", { seniorId, on: true }); // set while setting up, before she connects
  const { token: solo3 } = await createSelf("Ruth");
  assert.equal((await anon.query("prefs:get", { token: solo3 })).showMeInstead, false, "drive mode by default");
  assert.ok(await anon.mutation("devices:redeemCode", { code, token: solo3 }));
  assert.equal((await anon.query("prefs:get", { token: solo3 })).showMeInstead, true, "caregiver's choice carries over on merge");
  assert.equal((await anon.query("devices:me", { token: solo3 })).showMeSetBy, "caregiver");
  await anon.mutation("prefs:set", { token: solo3, showMeInstead: false });
  const id = (await jo.c.query("people:list", {}))[0].id;
  const p = await jo.c.query("people:get", { seniorId: id });
  assert.deepEqual([p.showMeInstead, p.showMeSetBy], [false, "self"]);
  const other = await caregiver("Stranger");
  await assert.rejects(other.c.mutation("people:setShowMe", { seniorId: id, on: true }), /not your senior/);
  ok("show me instead: off by default, caregiver choice carries over, she can change it, strangers can't");
}

// --- She shares a helper code from her Settings; the caregiver types it in the web app ---
{
  const lu = await caregiver("Lu");
  const { token: her } = await createSelf("Bea");
  const { code } = await anon.mutation("careLinks:createHelperCode", { token: her });
  assert.equal(await lu.c.mutation("careLinks:redeemHelperCode", { code: "000000" }), null);
  const r = await lu.c.mutation("careLinks:redeemHelperCode", { code });
  assert.equal(r.displayName, "Bea");
  assert.deepEqual((await anon.query("devices:me", { token: her })).helpers.map((h) => h.name), ["Lu"]);
  const people = await lu.c.query("people:list", {});
  assert.deepEqual(people.map((x) => [x.name, x.connected]), [["Bea", true]]);
  assert.equal(await lu.c.mutation("careLinks:redeemHelperCode", { code }), null, "helper code works once");
  // A helper code is not a device code, and the other way round.
  const { code: dev } = await anon.mutation("devices:createLinkCode", { token: her });
  assert.equal(await lu.c.mutation("careLinks:redeemHelperCode", { code: dev }), null);
  ok("helper code from her Settings links the caregiver once; device codes don't work as helper codes");
}

console.log("\nall account checks passed");
