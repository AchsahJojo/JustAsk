// Eval capture: load each case's page in headless Chrome, inject the real page scanner,
// and save the resulting PageSnapshot to eval/snapshots/<id>.json. Re-run after scanner changes.
//
//   npm run eval:capture                 fixture cases only
//   npm run eval:capture -- --live       also public live sites (cases with "live": true)
//   npm run eval:capture -- --only <id>  one case
//
// Privacy: a fresh headless profile (no cookies, no logins), public pages and local fixtures only.
// The scanner never reads field values. Nothing is sent anywhere.
import puppeteer from "puppeteer";
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EVAL = `${ROOT}eval/`;
const PORT = 6174;
const PORT2 = 6175;
const FIXTURES = `http://localhost:${PORT}`;

const args = process.argv.slice(2);
const live = args.includes("--live");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cases = readdirSync(`${EVAL}cases`)
  .filter((f) => f.endsWith(".case.json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(`${EVAL}cases/${f}`, "utf8")));

// 1. Bundle the scanner for the browser.
const bundle = (
  await build({
    entryPoints: [`${EVAL}scan-entry.ts`],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome120",
    write: false,
    logLevel: "warning",
  })
).outputFiles[0].text;

// 2. Fixture server on our own ports (5174/5175 belong to e2e and other agents).
const server = spawn("node", ["apps/fixtures/serve.mjs"], {
  cwd: ROOT,
  env: { ...process.env, FIXTURES_PORT: String(PORT), FIXTURES_PORT2: String(PORT2) },
  stdio: ["ignore", "ignore", "inherit"],
});
let browser;
let failed = 0;
try {
  await waitFor(`${FIXTURES}/`);
  mkdirSync(`${EVAL}snapshots`, { recursive: true });
  browser = await puppeteer.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });

  for (const c of cases) {
    if (only && c.id !== only) continue;
    if (c.live && !live) {
      console.log(`skip ${c.id}: live site (use --live)`);
      continue;
    }
    const url = c.url.replaceAll("{FIXTURES}", FIXTURES);
    const page = await browser.newPage();
    try {
      await page.setViewport({ width: 1000, height: 820 });
      const res = await page.goto(url, { waitUntil: c.live ? "networkidle2" : "load", timeout: 30000 });
      const status = res?.status() ?? 0;
      if (status === 404 && c.pendingFixture) {
        console.log(`skip ${c.id}: fixture not built yet (404 ${url})`);
        continue;
      }
      if (status < 200 || status >= 300) throw new Error(`HTTP ${status} for ${url}`);
      if (c.prepare?.clickText) await clickText(page, c.prepare.clickText);
      await sleep(c.settleMs ?? 400);
      await page.addScriptTag({ content: bundle });
      const context = [c.request, ...(c.history ?? []), ...(c.recipe?.steps ?? [])];
      const snapshot = await page.evaluate((ctx, id) => window.__justaskScan(ctx, id), context, `eval-${c.id}`);
      writeFileSync(`${EVAL}snapshots/${c.id}.json`, JSON.stringify(snapshot, null, 2) + "\n");
      console.log(`ok   ${c.id}: ${snapshot.elements.length} elements, ${snapshot.omitted.count} omitted — "${snapshot.title}"`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${c.id}: ${e.message}`);
    } finally {
      await page.close().catch(() => {});
    }
  }
} finally {
  await browser?.close();
  server.kill();
}
console.log(failed ? `\n${failed} failed` : "\ncapture done");
process.exit(failed ? 1 : 0);

async function waitFor(url, ms = 15000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await sleep(150);
  }
  throw new Error(`fixture server did not start on ${url}`);
}

/** Click the first button or link whose text starts with `text` (to open a dialog before scanning). */
async function clickText(page, text) {
  const handle = await page.waitForFunction(
    (t) => [...document.querySelectorAll("a,button,[role=button]")].find((e) => e.textContent.trim().startsWith(t)),
    { timeout: 8000 },
    text,
  );
  await handle.asElement().click();
}
