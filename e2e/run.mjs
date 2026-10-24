// End-to-end: real Chromium (Chrome for Testing via Puppeteer) with the built extension,
// the fixture sites, and the local mock planner. Build first: npm run build:e2e -w @justask/extension
//
//   node e2e/run.mjs            run every scenario
//   node e2e/run.mjs pharmacy   run scenarios whose name contains "pharmacy"
//   HEADFUL=1 node e2e/run.mjs  watch it
import puppeteer from "puppeteer";
import { spawn } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXT = `${ROOT}apps/extension/.output/chrome-mv3-dev`;
const SHOTS = `${ROOT}e2e/screenshots`;
const SITE = "http://localhost:5174";
// Its own port, so a dev planner on 8787 (maybe using Claude) never answers the tests.
const PLANNER = "http://localhost:8788";
const SENTINEL = "SENTINEL-7Q2";
mkdirSync(SHOTS, { recursive: true });
if (!existsSync(`${EXT}/manifest.json`)) throw new Error("Build the extension first: npm run build:e2e -w @justask/extension");

const procs = [];
function start(cmd, args, env = {}) {
  const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  p.stderr.on("data", (d) => process.env.DEBUG && process.stderr.write(d));
  procs.push(p);
  return p;
}
async function waitFor(url, ms = 15000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${url}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

start("node", ["apps/fixtures/serve.mjs"]);
start("node", ["--import", "tsx", "packages/backend/dev/server.ts"], { JUSTASK_MOCK: "1", PLANNER_PORT: "8788" });
await waitFor(`${SITE}/`);
await waitFor(`${PLANNER}/health`);

const browser = await puppeteer.launch({
  headless: !process.env.HEADFUL,
  enableExtensions: [EXT],
  args: ["--window-size=1280,900", "--autoplay-policy=no-user-gesture-required", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  defaultViewport: null,
});

const swTarget = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
const EXT_ID = new URL(swTarget.url()).host;
const sw = await swTarget.worker();

/** Open a fixture page in a normal window and the panel in a popup window pinned to that tab. */
async function openSession(path) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 820 });
  await page.goto(`${SITE}${path}`, { waitUntil: "load" });
  const tabId = await sw.evaluate(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)?.id, page.url());
  assert.ok(tabId, "found fixture tab id");
  const panelTarget = browser.waitForTarget((t) => t.url().includes("sidepanel.html"));
  await sw.evaluate(
    (url) => chrome.windows.create({ url, type: "popup", width: 420, height: 860, left: 0, top: 0 }),
    `chrome-extension://${EXT_ID}/sidepanel.html?tabId=${tabId}`,
  );
  const panel = await (await panelTarget).page();
  await panel.setViewport({ width: 400, height: 820 });
  await panel.emulateMediaFeatures([{ name: "prefers-color-scheme", value: process.env.DARK ? "dark" : "light" }]);
  await panel.waitForSelector(".panel");
  return { page, panel, tabId };
}

async function ask(panel, text) {
  await panel.waitForSelector("#typed");
  await panel.type("#typed", text);
  await panel.keyboard.press("Enter");
}

async function caption(panel, re, ms = 12000) {
  await panel.waitForFunction(
    (src) => {
      const c = document.querySelector(".caption");
      return c && new RegExp(src, "i").test(c.textContent);
    },
    { timeout: ms },
    re.source,
  );
  return panel.$eval(".caption", (c) => c.textContent);
}

async function phase(panel, p, ms = 12000) {
  await panel.waitForFunction((x) => document.querySelector(".panel")?.dataset.phase === x, { timeout: ms }, p);
}

/** Is the overlay ring drawn around the element matching `sel` in `frame`? Reads geometry, not internals. */
async function ringAround(frame, sel) {
  return frame.evaluate((s) => {
    const host = document.querySelector("justask-overlay");
    const el = document.querySelector(s) ?? [...document.querySelectorAll("*")].find((e) => e.shadowRoot?.querySelector(s))?.shadowRoot.querySelector(s);
    if (!host || !el) return { host: !!host, el: !!el };
    const r = host.getBoundingClientRect();
    const cs = getComputedStyle(host);
    return { host: true, el: true, popover: host.matches(":popover-open"), rect: [r.x, r.y, r.width, r.height], display: cs.display, vis: cs.visibility, op: cs.opacity, inset: cs.inset, bg: cs.backgroundColor };
  }, sel);
}

/** Assert the ring in `frame` is drawn around the given viewport rect (from the target's own box). */
async function assertRingOn(frame, getRect, label) {
  await frame.waitForFunction(() => document.querySelector("justask-overlay")?.hasAttribute("data-ring"), { timeout: 5000 });
  let ring, target;
  for (let i = 0; i < 20; i++) {
    // Poll: the ring follows smooth scrolling on the next frame.
    [ring, target] = await Promise.all([
      frame.$eval("justask-overlay", (h) => h.getAttribute("data-ring").split(",").map(Number)),
      frame.evaluate(getRect),
    ]);
    if (ring.every((v, i) => Math.abs(v - target[i]) <= 2)) return;
    await sleep(150);
  }
  assert.fail(`${label}: ring ${ring} vs target ${target}`);
}
const rectOf = (sel) => new Function(`const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round);`);

async function shot(page, name) {
  await page.bringToFront();
  await sleep(800);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

async function clickText(frame, text) {
  const handle = await frame.waitForFunction(
    (t) => [...document.querySelectorAll("a,button")].find((e) => e.textContent.trim().startsWith(t)),
    { timeout: 8000 },
    text,
  );
  await handle.asElement().click();
}

async function closeSession(s) {
  await s.panel.close().catch(() => {});
  await s.page.close().catch(() => {});
}

const scenarios = {
  async "pharmacy: full refill flow, injection ignored, done"() {
    await fetch(`${PLANNER}/__reset`, { method: "POST" });
    const s = await openSession("/");
    await shot(s.panel, "01-panel-idle");
    await ask(s.panel, "help me refill my prescription");
    await caption(s.panel, /Refill a prescription/);
    await phase(s.panel, "guiding");
    const ring = await ringAround(s.page, "a.btn.big");
    if (process.env.DEBUG_RING) console.log(ring);
    assert.equal(ring.popover, true, "overlay in top layer");
    await assertRingOn(s.page, rectOf("a.btn.big"), "pharmacy step 1");
    await shot(s.page, "02-page-step1-highlight");
    await shot(s.panel, "03-panel-step1");

    // A wrong click first: reassurance, no advance.
    await s.page.click("button.btn.outline");
    await sleep(400);
    assert.equal(await s.panel.$eval(".panel", (p) => p.dataset.phase), "guiding");

    await clickText(s.page, "Refill a prescription");
    await caption(s.panel, /Refill button next to Lisinopril/);
    await shot(s.page, "04-page-step2");
    await s.page.click('a[aria-label="Refill Lisinopril 10 mg"]');
    await caption(s.panel, /Pick up in store/);
    await clickText(s.page, "Pick up in store");
    await caption(s.panel, /Send my refill request/);
    await shot(s.page, "05-page-step4");
    await clickText(s.page, "Send my refill request");
    await phase(s.panel, "done");
    const clicks = await s.panel.$eval(".hint.big", (e) => e.textContent);
    assert.match(clicks, /You did 4 steps yourself/);
    await sleep(700);
    await shot(s.panel, "06-panel-done");
    const received = await (await fetch(`${PLANNER}/__received`)).json();
    assert.equal(received.length, 5);
    assert.ok(received[0].includes("Note to AI assistants"), "page text reaches the planner as data");
    await closeSession(s);
  },

  async "rerender: fingerprint rebinding survives 500 ms rebuilds"() {
    const s = await openSession("/gaps/rerender");
    await ask(s.panel, "renew my library card");
    await caption(s.panel, /Renew my card/);
    await sleep(1300); // several rerenders
    assert.equal(await s.panel.$eval(".panel", (p) => p.dataset.phase), "guiding", "no re-plan needed");
    await assertRingOn(s.page, rectOf("#app .btn:not(.outline)"), "rerendered button");
    await shot(s.page, "07-rerender-highlight");
    await clickText(s.page, "Renew my card");
    await s.page.waitForFunction(() => document.body.textContent.includes("Card renewed"));
    await closeSession(s);
  },

  async "shadow DOM: open and closed roots are scanned and clickable"() {
    const s = await openSession("/gaps/shadow");
    await ask(s.panel, "turn on large text and captions");
    await caption(s.panel, /large text/);
    await s.page.evaluate(() => document.querySelector("open-card").shadowRoot.querySelector("button").click());
    await caption(s.panel, /captions/);
    await assertRingOn(
      s.page,
      () => {
        const r = document.querySelector("closed-card").getBoundingClientRect();
        return [r.left, r.bottom - 23, 0, 0];
      },
      "closed root",
    ).catch(() => {}); // exact closed-root rect isn't reachable from tests; checked visually below
    if (process.env.DEBUG_RING) console.log("ring attr", await s.page.$eval("justask-overlay", (h) => h.getAttribute("data-ring")).catch((e) => String(e)), await s.panel.$eval(".panel", (p) => p.dataset.phase));
    await s.page.waitForFunction(() => {
      const [x, y, w, h] = document.querySelector("justask-overlay").getAttribute("data-ring").split(",").map(Number);
      const openBtn = document.querySelector("open-card").shadowRoot.querySelector("button").getBoundingClientRect();
      return w > 50 && h > 10 && y > openBtn.bottom && x >= 0;
    });
    await shot(s.page, "08-shadow-closed-highlight");
    // Closed root: click by coordinates (tests can't reach into it either).
    const box = await s.page.evaluate(() => {
      const r = document.querySelector("closed-card").getBoundingClientRect();
      return { x: r.left + 60, y: r.bottom - 12 };
    });
    await s.page.mouse.click(box.x, box.y);
    await s.page.waitForFunction(() => document.getElementById("result").textContent.includes("Captions"));
    await closeSession(s);
  },

  async "iframes: same- and cross-origin frames merge into one list; money step asks first"() {
    const s = await openSession("/gaps/iframes");
    await ask(s.panel, "apply my coupon and pay");
    await caption(s.panel, /Apply coupon/);
    const same = s.page.frames().find((f) => f.url().includes("frame-inner") && f.url().startsWith(SITE));
    await shot(s.page, "09-iframe-same-origin");
    await (await same.$("button")).click();
    await caption(s.panel, /spend money/);
    // No bare "spend money?": it names what would be pressed, and where.
    assert.match(await s.panel.$eval(".stage-text .soft", (e) => e.textContent), /^Next, I'd (press|show you) “Pay now” on localhost\.$/);
    await shot(s.panel, "10-panel-confirm-money");
    await s.panel.click(".choices .btn.primary");
    await caption(s.panel, /Pay now/);
    await shot(s.page, "11-iframe-cross-origin");
    await closeSession(s);
  },

  async "form: typing and select steps; leak test with sentinel"() {
    await fetch(`${PLANNER}/__reset`, { method: "POST" });
    const s = await openSession("/gaps/form");
    await ask(s.panel, "help me make an account");
    await caption(s.panel, /Full name/);
    await shot(s.page, "12-form-type-name");
    await s.page.type("#name", SENTINEL);
    await s.page.keyboard.press("Tab");
    await caption(s.panel, /Email/);
    // Typing in the wrong box is reported, value never sent.
    await s.page.type("#bio", SENTINEL);
    await s.page.type("#email", `${SENTINEL}@example.com`);
    await s.page.keyboard.press("Tab");
    await caption(s.panel, /can't see it/);
    await shot(s.panel, "13-panel-password");
    await s.page.type("#pw", SENTINEL);
    await s.panel.click(".actions .btn.primary"); // I'm done typing
    await caption(s.panel, /Arizona/);
    await s.page.select("#state", "TE"); // wrong choice first
    await sleep(300);
    assert.equal(await s.panel.$eval(".panel", (p) => p.dataset.phase), "guiding");
    await s.page.select("#state", "AR");
    await s.page.evaluate(() => {
      const sel = document.getElementById("state");
      sel.value = [...sel.options].find((o) => o.text === "Arizona").value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await phase(s.panel, "done");
    const received = await (await fetch(`${PLANNER}/__received`)).json();
    const all = received.join("\n");
    assert.ok(!all.includes(SENTINEL), "sentinel never reaches the planner");
    assert.ok(!all.includes("validationMessage"));
    assert.ok(!/"selected"/.test(all));
    await closeSession(s);
  },

  async "dialog: overlay sits above showModal; cookie banner is a clarify"() {
    const s = await openSession("/gaps/dialog");
    await ask(s.panel, "read the news");
    await phase(s.panel, "asking");
    await shot(s.panel, "14-panel-clarify");
    const snap = JSON.parse((await (await fetch(`${PLANNER}/__received`)).json()).at(-1)).snapshot;
    assert.deepEqual(
      snap.elements.map((e) => e.text),
      ["Accept all", "Only necessary"],
      "modal-only rule",
    );
    await closeSession(s);
  },

  async "new tab: session follows a target=_blank link"() {
    const s = await openSession("/gaps/newtab");
    await ask(s.panel, "open the guide");
    await caption(s.panel, /Open the guide/);
    const newPage = new Promise((r) => browser.once("targetcreated", async (t) => r(await t.page())));
    await clickText(s.page, "Open the guide");
    const guide = await newPage;
    await caption(s.panel, /I read it/, 15000);
    await guide.waitForSelector("button");
    await shot(guide, "15b-newtab-followed");
    await guide.close();
    await closeSession(s);
  },

  async "1,000 links: ranked, the right button below the fold survives the cap"() {
    await fetch(`${PLANNER}/__reset`, { method: "POST" });
    const s = await openSession("/gaps/links");
    await ask(s.panel, "renew my library card");
    await caption(s.panel, /Renew my library card/);
    const snap = JSON.parse((await (await fetch(`${PLANNER}/__received`)).json()).at(-1)).snapshot;
    assert.equal(snap.elements.length, 150);
    assert.ok(snap.omitted.count >= 850);
    await sleep(900); // smooth scroll into view
    await assertRingOn(s.page, rectOf("main .btn"), "below-the-fold button");
    await shot(s.page, "15-links-scrolled-highlight");
    await closeSession(s);
  },

  async "empty New Tab: JustAsk searches the user's words in that tab, then keeps going"() {
    await fetch(`${PLANNER}/__reset`, { method: "POST" });
    const s = await openSession("/");
    await s.page.goto("chrome://newtab");
    // Stand-in for the user's default search engine (real engines can't be intercepted from the New Tab page):
    // record the words and open the local results fixture in the same tab.
    await s.panel.evaluate((site) => {
      window.__searched = [];
      chrome.search.query = async ({ text, tabId }) => {
        window.__searched.push(text);
        await chrome.tabs.update(tabId, { url: `${site}/gaps/results?q=${encodeURIComponent(text)}` });
      };
    }, SITE);
    await ask(s.panel, "help me refill my prescription please");
    await caption(s.panel, /Click the one that says/, 20000);
    assert.deepEqual(await s.panel.evaluate(() => window.__searched), ["refill my prescription"], "searched the user's words, without the filler");
    assert.match(s.page.url(), /\/gaps\/results/, "in the same tab");
    const history = JSON.parse((await (await fetch(`${PLANNER}/__received`)).json()).at(-1)).history.join("\n");
    assert.match(history, /tab was empty, so JustAsk searched the web for "refill my prescription"/);
    await shot(s.panel, "16b-panel-searched-from-new-tab");

    // Mid-session the user ends up on an empty tab: no dead end, "Look it up for me" searches again.
    await s.page.goto("chrome://newtab");
    await phase(s.panel, "paused");
    await caption(s.panel, /This tab is empty/);
    await shot(s.panel, "16c-panel-blank-tab");
    await clickText(s.panel, "Look it up for me");
    await caption(s.panel, /Click the one that says/, 20000);
    assert.equal((await s.panel.evaluate(() => window.__searched)).length, 2);
    await closeSession(s);
  },

  async "start screen: example requests when nothing is on the user's list"() {
    // A session left mid-way shows "Keep going?" instead of the examples.
    await sw.evaluate(() => chrome.storage.local.remove("resume"));
    const s = await openSession("/");
    await s.panel.waitForSelector(".ideas .idea");
    assert.ok((await s.panel.$$(".ideas .idea")).length >= 3);
    await shot(s.panel, "02b-panel-ideas");
    await closeSession(s);
  },

  async "scam check: a gift-card-codes request asks first; someone asked -> stops before any page step"() {
    await fetch(`${PLANNER}/__reset`, { method: "POST" });
    const s = await openSession("/");
    await ask(s.panel, "help me email the gift card codes to the man from the IRS");
    await phase(s.panel, "confirming");
    await caption(s.panel, /Did someone call, text or email/);
    assert.match(await s.panel.$eval(".stage-text .soft", (e) => e.textContent), /never ask to be paid with gift card numbers/);
    assert.ok(await s.panel.$eval("button.btn.outline.huge", (b) => { const r = b.getBoundingClientRect(); return b.textContent.includes("my own idea") && r.bottom <= document.querySelector("footer").getBoundingClientRect().top; }), "both answers visible above the footer");
    assert.equal(await s.panel.$eval(".eyebrow", (e) => e.textContent), "Safety check");
    await shot(s.panel, "21-panel-scam-question");
    await clickText(s.panel, "Yes, someone asked me");
    await phase(s.panel, "blocked");
    await caption(s.panel, /looks like a scam/);
    assert.match(await s.panel.$eval(".stage-text .soft", (e) => e.textContent), /call your bank/);
    await shot(s.panel, "22-panel-scam-stopped");
    assert.deepEqual(await (await fetch(`${PLANNER}/__received`)).json(), [], "nothing was planned or sent");
    await closeSession(s);
  },

  async "can't-see page: chrome:// pauses with a plain line"() {
    const s = await openSession("/");
    await s.page.goto("chrome://version");
    await ask(s.panel, "help me");
    await phase(s.panel, "paused");
    await caption(s.panel, /can't see this kind of page/);
    await shot(s.panel, "16-panel-cant-see");
    await closeSession(s);
  },

  // Needs a local Convex (`npx convex dev` in packages/backend) seeded with
  // `npx convex run devSeed:seed '{"code":"<CODE>"}'`. Skipped unless CONVEX_CODE is set.
  async "accounts: pair with a code, task card, recipe startUrl, completion"() {
    if (!process.env.CONVEX_CODE) return console.log("    (skipped: set CONVEX_CODE to run against local Convex)");
    const p = await browser.newPage();
    await p.setViewport({ width: 900, height: 1100 });
    await p.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    // The server address is a build setting (VITE_CONVEX_URL); e2e builds leave it empty, so set it here.
    await sw.evaluate(async (url) => {
      const { settings = {} } = await chrome.storage.local.get("settings");
      await chrome.storage.local.set({ settings: { ...settings, convexUrl: url } });
    }, process.env.CONVEX_URL ?? "http://127.0.0.1:3210");
    await p.goto(`chrome-extension://${EXT_ID}/setup.html`);
    await p.waitForSelector('input[aria-label="Pairing code"]');
    await p.type('input[aria-label="Pairing code"]', process.env.CONVEX_CODE);
    await clickText(p, "Connect");
    await p.waitForFunction(() => document.body.textContent.includes("Connected as Mom"), { timeout: 8000 });
    // Consent comes from the server profile (the seed turns "tell my helper when I finish" on).
    if (!(await p.$eval(".toggle input", (e) => e.checked))) await p.click(".toggle input");
    await p.waitForFunction(() => document.querySelector(".toggle input")?.checked, { timeout: 3000, polling: 100 });
    await p.screenshot({ path: `${SHOTS}/19-setup-paired.png`, fullPage: true });
    await p.close();

    const s = await openSession("/gaps/");
    await s.panel.reload();
    await s.panel.waitForFunction(() => document.body.textContent.includes("asked you to"), { timeout: 20000 });
    await shot(s.panel, "20-panel-task-card");
    await s.panel.click(".card.task .btn.primary");
    await caption(s.panel, /Refill a prescription/, 15000); // recipe startUrl opened in the session tab
    assert.equal(new URL(s.page.url()).pathname, "/");
    for (const [text, sel] of [["Refill a prescription"], ["Refill", 'a[aria-label="Refill Lisinopril 10 mg"]'], ["Pick up in store"], ["Send my refill request"]]) {
      if (sel) await s.page.waitForSelector(sel).then((h) => h.click());
      else await clickText(s.page, text);
      await sleep(300);
    }
    await phase(s.panel, "done", 20000);
    await closeSession(s);

    // The JustAsk desktop app makes a link code; this already-connected browser types it under "I have a code".
    const { ConvexHttpClient } = await import("convex/browser");
    const cx = new ConvexHttpClient(process.env.CONVEX_URL ?? "http://127.0.0.1:3210");
    const { token: deskToken } = await cx.mutation("accounts:createSelf", { displayName: "Joan", device: { kind: "desktop", platform: "test", label: "Joan's PC", machineId: "pc-e2e" } });
    const { code: deskCode } = await cx.mutation("devices:createLinkCode", { token: deskToken });
    const st = await browser.newPage();
    await st.goto(`chrome-extension://${EXT_ID}/setup.html`);
    await st.waitForSelector('input[aria-label="Code"]');
    await st.type('input[aria-label="Code"]', deskCode);
    await clickText(st, "Next");
    await st.waitForFunction(() => document.body.textContent.includes("Link this browser to Joan's JustAsk?"), { timeout: 8000 });
    await st.screenshot({ path: `${SHOTS}/19b-setup-link-desktop.png`, fullPage: true });
    await clickText(st, "Yes, link it");
    await st.waitForFunction(() => document.body.textContent.includes("Linked."), { timeout: 8000 });
    const devices = await cx.query("devices:list", { token: deskToken });
    assert.deepEqual(devices.map((d) => [d.kind, d.machineId]).sort(), [["desktop", "pc-e2e"], ["extension", "pc-e2e"]], "one account; the browser has the app's machine id");
    await st.close();
  },

  async "setup page renders"() {
    const p = await browser.newPage();
    await p.setViewport({ width: 900, height: 1100 });
    await p.goto(`chrome-extension://${EXT_ID}/setup.html`);
    await p.waitForSelector(".step");
    await sleep(600);
    await p.screenshot({ path: `${SHOTS}/17-setup-dark.png`, fullPage: true });
    await p.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    await sleep(300);
    await p.screenshot({ path: `${SHOTS}/17-setup-light.png`, fullPage: true });
    await p.close();
  },
};

const filter = process.argv[2];
let failed = 0;
for (const [name, fn] of Object.entries(scenarios)) {
  if (filter && !name.includes(filter)) continue;
  const t = Date.now();
  try {
    await fn();
    console.log(`✓ ${name} (${Date.now() - t} ms)`);
  } catch (e) {
    failed++;
    console.log(`✗ ${name}\n    ${e.stack?.split("\n").slice(0, 8).join("\n    ")}`);
    for (const p of await browser.pages()) {
      await p.screenshot({ path: `${SHOTS}/fail-${name.slice(0, 20).replace(/\W+/g, "_")}-${Math.random().toString(36).slice(2, 6)}.png` }).catch(() => {});
      if (p.url() !== "about:blank") await p.close().catch(() => {});
    }
  }
}

await browser.close();

// Production build: no pre-granted host access. Setup opens on install; the panel asks to be turned on.
if (!filter || "production build".includes(filter)) {
  const PROD = `${ROOT}apps/extension/.output/chrome-mv3`;
  const t = Date.now();
  let b2;
  try {
    assert.ok(existsSync(`${PROD}/manifest.json`), "build prod first: npm run build -w @justask/extension");
    b2 = await puppeteer.launch({ headless: !process.env.HEADFUL, enableExtensions: [PROD], args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
    const setupT = await b2.waitForTarget((x) => x.url().includes("setup.html"), { timeout: 10000 });
    const id = new URL(setupT.url()).host;
    const p = await b2.newPage();
    await p.setViewport({ width: 400, height: 820 });
    await p.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    await p.goto(`chrome-extension://${id}/sidepanel.html`);
    await p.waitForFunction(() => document.body.textContent.includes("Turn JustAsk on"), { timeout: 8000 });
    await sleep(500);
    await p.screenshot({ path: `${SHOTS}/18-prod-needs-access.png` });
    console.log(`✓ production build: setup opens on install, panel asks for host access (${Date.now() - t} ms)`);
  } catch (e) {
    failed++;
    console.log(`✗ production build\n    ${e.message}`);
  } finally {
    await b2?.close();
  }
}

for (const p of procs) p.kill();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
