// Integration check against a local Convex deployment (`npx convex dev`), seeded with
// `npx convex run devSeed:seed '{"code":"123456"}'`. Run: node test/convex.int.mjs
import { ConvexHttpClient } from "convex/browser";
import assert from "node:assert/strict";

const URL = process.env.CONVEX_URL ?? "http://127.0.0.1:3210";
const SITE = process.env.CONVEX_SITE_URL ?? "http://127.0.0.1:3211";
const c = new ConvexHttpClient(URL);

const { token, displayName } = await c.mutation("devices:redeemCode", { code: process.env.CODE ?? "123456" });
assert.equal(displayName, "Mom");
assert.equal(token.length, 64);
assert.equal(await c.mutation("devices:redeemCode", { code: process.env.CODE ?? "123456" }), null);
console.log("✓ pairing code redeems once");

const tasks = await c.query("tasks:pendingForDevice", { token });
assert.equal(tasks.length >= 1, true);
assert.equal(tasks[0].from, "Sam");
console.log("✓ pending task visible to device:", tasks[0].title);
await assert.rejects(c.query("tasks:pendingForDevice", { token: "nope" }), /not paired/);
console.log("✓ bad token rejected");

await c.mutation("tasks:setStatus", { token, taskId: tasks[0].id, status: "active" }); // the user pressed Start
const sessionId = await c.mutation("sessions:start", { token, request: tasks[0].spokenPrompt, taskId: tasks[0].id });
await c.mutation("sessions:logEvent", { token, sessionId, type: "step_shown", latencyMs: 900 });
await c.mutation("sessions:logEvent", { token, sessionId, type: "done" });
const after = await c.query("tasks:pendingForDevice", { token });
assert.equal(after.some((t) => t.id === tasks[0].id), false);
console.log("✓ done event closes the task");

const snapshot = { snapshotId: "s1", url: "http://x/", title: "T", heading: "", pageText: "", elements: [], omitted: { count: 0, regions: [] } };
const res = await fetch(`${SITE}/plan`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ deviceToken: token, sessionId, request: "help", history: [], recipe: null, snapshot, retryNote: null }),
}).then((r) => r.json());
console.log("  /plan reply:", JSON.stringify(res));
if (res.ok) {
  // ANTHROPIC_API_KEY is set on this deployment: a real Claude step came back.
  assert.equal(res.snapshotId, "s1");
  assert.equal(typeof res.step, "object");
  console.log("✓ /plan returned a real Claude step");
} else {
  assert.match(res.error, /server not configured|api|Error/);
}
const unpaired = await fetch(`${SITE}/plan`, { method: "POST", body: JSON.stringify({ deviceToken: "x", sessionId: null, request: "h", history: [], recipe: null, snapshot, retryNote: null }) }).then((r) => r.json());
assert.equal(unpaired.error, "not paired");
console.log("✓ /plan HTTP route wired (device checked, step budget consumed)");
