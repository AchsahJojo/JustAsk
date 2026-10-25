// Caregiver web app end to end, against local Convex and the Vite dev server.
// Needs: `npx convex dev` in packages/backend (with JWT_PRIVATE_KEY, JWKS, SITE_URL and JUSTASK_TASKCHECK_MOCK=1 set) and
// `npm run dev -w @justask/caregiver` (port 5176). Run: node e2e/caregiver.mjs
// The senior's extension is played by a Convex client using the same device-token functions.
import puppeteer from "puppeteer";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(new URL("../packages/backend/package.json", import.meta.url));
const { ConvexHttpClient } = require("convex/browser");

const APP = process.env.CAREGIVER_URL ?? "http://localhost:5176/";
const CONVEX = process.env.CONVEX_URL ?? "http://127.0.0.1:3210";
const SHOTS = new URL("./screenshots/caregiver/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
const run = Date.now().toString(36);
const email = `sam-${run}@example.com`;
const senior = new ConvexHttpClient(CONVEX);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ headless: !process.env.HEADFUL, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const errors = [];
const page = await browser.newPage();
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
await page.setViewport({ width: 1280, height: 860 });
await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);

const shot = async (name, p = page) => {
  await sleep(400);
  await p.screenshot({ path: `${SHOTS}${name}.png`, fullPage: true });
  console.log(`  📸 ${name}`);
};
const text = (p = page) => p.evaluate(() => document.body.innerText);
// Interval polling: rAF polling can stall in a background headless tab.
const waitText = (t, timeout = 10000, p = page) => p.waitForFunction((s) => document.body.innerText.includes(s), { timeout, polling: 100 }, t);
const clickText = async (t, sel = "button, a", p = page) => {
  const ok = await p.evaluate(
    (t, sel) => {
      const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim() === t && !e.disabled);
      el?.click();
      return !!el;
    },
    t,
    sel,
  );
  assert.ok(ok, `no clickable "${t}"`);
};
const typeIn = async (label, value, p = page) => {
  const h = await p.evaluateHandle((label) => {
    for (const l of document.querySelectorAll("label")) if (l.querySelector("span")?.textContent.trim().startsWith(label)) return l.querySelector("input, textarea");
    return null;
  }, label);
  const el = h.asElement();
  assert.ok(el, `no field "${label}"`);
  await el.click();
  await el.evaluate((e) => e.select());
  await el.press("Backspace");
  await el.type(value);
};
const step = (m) => console.log(`✓ ${m}`);

try {
  // --- Sign up: validation, then success ---
  await page.goto(APP);
  await waitText("Create your helper account");
  await shot("01-signup");
  await clickText("Create account", "form button.btn");
  await waitText("Add your name");
  await typeIn("Your name", "Sam Rivera");
  await typeIn("Email", "nope");
  await clickText("Create account", "form button.btn");
  await waitText("valid email");
  await typeIn("Email", email);
  await typeIn("Password", "short");
  await clickText("Create account", "form button.btn");
  await waitText("at least 8 characters");
  await shot("02-signup-error");
  await typeIn("Password", "correct horse battery");
  await clickText("Create account", "form button.btn");
  await waitText("Who do you help?", 15000);
  assert.match(await text(), /Hi Sam\./);
  await shot("03-home-empty");
  step("sign up validates name, email, password; lands on empty home with first name");

  // --- Setup wizard ---
  await clickText("Set up JustAsk for someone");
  await waitText("Who are you setting JustAsk up for?");
  await clickText("Continue", "button");
  await waitText("Add their name");
  await typeIn("Their name", "Joan Hill");
  await clickText("Mother", "button.chip");
  const call = await page.evaluate(() => [...document.querySelectorAll("label")].find((l) => l.textContent.includes("What should JustAsk call them"))?.querySelector("input")?.value);
  assert.equal(call, "Mom", "relation suggests what JustAsk calls them");
  await shot("04-wizard");
  await clickText("Continue", "button");
  await waitText("type this code", 10000);
  await page.waitForSelector(".code-box:not(.skeleton)");
  const code = await page.$eval(".code-box", (e) => e.textContent.replace(/\D/g, ""));
  assert.match(code, /^\d{6}$/);
  assert.match(await text(), /Waiting for Mom to type the code/);
  assert.match(await text(), /expires in 1[45]:\d\d/);
  await shot("05-connect-waiting");
  step(`wizard creates profile and shows code ${code} with countdown`);

  // New code replaces the old one.
  await clickText("Make a different code", "button");
  await page.waitForFunction((old) => document.querySelector(".code-box")?.textContent.replace(/\D/g, "") !== old, {}, code);
  const code2 = await page.$eval(".code-box", (e) => e.textContent.replace(/\D/g, ""));
  const { token } = await senior.mutation("accounts:createSelf", { displayName: "Joanie", device: { kind: "extension", platform: "test", label: "Chrome" } });
  const stale = await senior.mutation("devices:redeemCode", { code, token });
  assert.equal(stale, null, "replaced code no longer works");
  step("making a different code invalidates the old one");

  // --- Senior already used JustAsk alone, types the code: page flips to connected live ---
  const res = await senior.mutation("devices:redeemCode", { code: code2, token });
  assert.ok(res);
  assert.equal(res.displayName, "Joanie", "the user's own name is kept");
  await waitText("You're connected to Joanie", 10000);
  await sleep(1500); // let the Clayzo "connected" state play
  await shot("06-connected");
  assert.match(await text(), /Send Joanie a task/);
  step("standalone senior redeems code; caregiver page goes live to connected, the user's display name kept");

  // --- Send a task: held until it's clear (JUSTASK_TASKCHECK_MOCK=1 stands in for Claude) ---
  await clickText("Next", "button");
  await waitText("Tell JustAsk what Joanie should do");
  await typeIn("What should Joanie do?", "refill prescription");
  await clickText("Next", "button");
  await waitText("JustAsk asks", 10000);
  assert.equal(await page.evaluate(() => [...document.querySelectorAll("button")].some((b) => b.textContent === "Send task")), false, "a vague task can't be sent");
  await shot("07a-compose-question");
  await typeIn("Your answer", "Lisinopril, pick up in store");
  await clickText("Answer", "button");
  await waitText("This task is clear", 10000);
  // Hand edits are checked again before sending; a bad start page is caught on the spot.
  await typeIn("Start page", "javascript:alert(1)");
  await waitText("Use a full web address");
  await typeIn("Start page", "https://pharmacy.example/");
  await clickText("+ Add a step", "button");
  await (await page.$$(".steps-edit input"))[0].type("Click Refill a prescription");
  await clickText("+ Add a step", "button");
  await (await page.$$(".steps-edit input"))[1].type("Pick up in store");
  await clickText("+ Add a step", "button");
  await waitText("checks it again");
  await shot("07-compose-recipe");
  await clickText("Check again", "button");
  await waitText("This task is clear", 10000);
  await clickText("Send task", "button");
  await waitText("Tasks you sent", 10000);
  const pending = await senior.query("tasks:pendingForDevice", { token });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].from, "Sam Rivera");
  assert.match(pending[0].spokenPrompt, /refill prescription/);
  assert.deepEqual(pending[0].recipe, { startUrl: "https://pharmacy.example/", steps: ["Click Refill a prescription", "Pick up in store"] }, "empty third step dropped");
  assert.match(await text(), /hasn't chosen to share results/);
  await shot("08-person-task-sent");
  step("task: blank title and javascript: URL blocked; recipe delivered to the extension; consent note shown");

  // --- The user opts in, finishes the task: status, stats and the activity note update live ---
  await senior.mutation("devices:setConsent", { token, notifyOnComplete: true, notifyOnStuck: true });
  await senior.mutation("tasks:setStatus", { token, taskId: pending[0].id, status: "active" }); // the user pressed Start
  const sid = await senior.mutation("sessions:start", { token, request: "refill", taskId: pending[0].id });
  await senior.mutation("sessions:logEvent", { token, sessionId: sid, type: "step_shown", latencyMs: 1200 });
  await senior.mutation("sessions:logEvent", { token, sessionId: sid, type: "stuck" });
  await senior.mutation("sessions:logEvent", { token, sessionId: sid, type: "done" });
  await page.waitForFunction(() => [...document.querySelectorAll(".pill")].some((p) => p.textContent === "Done"), { timeout: 10000, polling: 100 });
  assert.match(await text(), /Typical step\s*1\.2s/);
  await shot("09-person-done");
  step("consent on: task shows Done, stats appear");

  // How JustAsk helps: guide only. No "click and type" switch anywhere.
  assert.match(await text(), /they do the clicking themselves/);
  assert.equal(await page.evaluate(() => document.body.textContent.includes("Click and type for")), false, "no drive toggle");
  assert.equal((await senior.query("prefs:get", { token })).showMeInstead, true);
  await shot("09b-how-it-helps");
  step("JustAsk is guide only: the caregiver sees no drive switch");

  // Take back a second task.
  await clickText("New task", "button");
  await typeIn("What should Joanie do?", "Join the Zoom call");
  await clickText("Next", "button");
  await waitText("This task is clear", 10000);
  await clickText("Send task", "button");
  await waitText("Sent “Join the Zoom call”");
  await page.waitForFunction(() => [...document.querySelectorAll(".tasks button")].some((b) => b.textContent === "Take back"), { timeout: 8000, polling: 100 });
  page.once("dialog", (d) => d.accept());
  await clickText("Take back", "button");
  await page.waitForFunction(() => ![...document.querySelectorAll(".tasks .task-title")].some((e) => e.textContent === "Join the Zoom call"), { timeout: 8000, polling: 100 });
  assert.equal((await senior.query("tasks:pendingForDevice", { token })).length, 0);
  step("take back a pending task");

  // --- Home with activity ---
  await page.goto(APP + "#/");
  await waitText("People you help");
  await waitText("finished");
  assert.match(await text(), /Joanie finished "Refill a prescription" and did every step themselves/);
  await shot("10-home");
  await clickText("Mark all read", "button");
  await page.waitForFunction(() => !document.querySelector(".feed-list li.unread"), { timeout: 5000, polling: 100 });
  step("home lists person and activity note; mark all read");

  // --- Not found + mobile + dark ---
  await page.goto(APP + "#/p/notarealid");
  await waitText("We can't find that person");
  await shot("11-not-found");
  step("unknown person id shows a friendly not-found page");

  const mobile = await browser.newPage();
  mobile.on("pageerror", (e) => errors.push(String(e)));
  await mobile.setViewport({ width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 });
  await mobile.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  await mobile.goto(APP + "#/");
  await waitText("People you help", 15000, mobile);
  await shot("12-mobile-home", mobile);
  const personHref = await mobile.$eval(".person-card", (a) => a.getAttribute("href"));
  await mobile.goto(APP + personHref);
  await waitText("What Joanie shares", 10000, mobile);
  await shot("13-mobile-person", mobile);
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `no horizontal scroll on phone (overflow ${overflow}px)`);
  await mobile.goto(APP + "#/new");
  await waitText("Who are you setting", 10000, mobile);
  await shot("14-mobile-wizard", mobile);
  await mobile.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
  await mobile.goto(APP + "#/");
  await waitText("People you help", 10000, mobile);
  await shot("15-mobile-dark", mobile);
  await mobile.close();
  step("phone width: no horizontal scroll; dark mode renders");

  // --- Senior disconnects: caregiver loses the person, gets a note ---
  await senior.mutation("devices:leaveHelpers", { token });
  await page.goto(APP + "#/");
  await waitText("disconnected from you", 10000);
  await waitText("Who do you help?", 10000);
  step("senior disconnects: person leaves the list, note in activity");

  // --- Sign out and back in; wrong password ---
  await page.goto(APP + "#/account");
  await waitText("Your account");
  await shot("16-account");
  await clickText("Sign out", "button.btn");
  await waitText("Create your helper account", 10000);
  await clickText("Sign in", ".seg button");
  await typeIn("Email", email);
  await typeIn("Password", "wrong password");
  await clickText("Sign in", "form button.btn");
  await waitText("don't match", 10000);
  await shot("17-signin-error");
  await typeIn("Password", "correct horse battery");
  await clickText("Sign in", "form button.btn");
  await waitText("Hi Sam", 15000);
  step("sign out; wrong password message; sign back in");

  // Duplicate sign-up.
  await page.goto(APP + "#/account");
  await waitText("Your account");
  await clickText("Sign out", "button.btn");
  await waitText("Create your helper account", 10000);
  await typeIn("Your name", "Imposter");
  await typeIn("Email", email);
  await typeIn("Password", "another password");
  await clickText("Create account", "form button.btn");
  await waitText("already an account", 10000);
  step("duplicate sign-up says sign in instead");

  await page.setViewport({ width: 1280, height: 860 });
  await shot("18-desktop-signup-final");

  const real = errors.filter((e) => !/InvalidSecret|already exists|InvalidAccountId|Server Error|\[CONVEX/.test(e));
  assert.deepEqual(real, [], "no unexpected console errors");
  console.log("\nall caregiver e2e checks passed");
} catch (e) {
  await page.screenshot({ path: `${SHOTS}FAIL.png`, fullPage: true }).catch(() => {});
  console.error("console errors:", errors);
  throw e;
} finally {
  await browser.close();
}
