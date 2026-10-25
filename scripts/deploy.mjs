// One command to ship JustAsk to the cloud. See docs/DEPLOY.md.
//
//   npm run deploy                 backend + extension zip + caregiver build
//   npm run deploy -- --vercel     ...and push the caregiver app (and fixtures) to Vercel
//   npm run deploy -- --skip-backend
//
// Reads JUSTASK_CONVEX_URL (https://<name>.convex.cloud) from the shell or from .env.deploy at the
// repo root. No secrets live here: API keys stay in Convex env (npx convex env set ...).
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const args = new Set(process.argv.slice(2));

function loadEnvFile() {
  const p = join(ROOT, ".env.deploy");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

function run(cmd, cwd = ROOT, env = {}) {
  console.log(`\n> ${cmd}${cwd === ROOT ? "" : `   (in ${cwd.replace(ROOT, "")})`}`);
  execSync(cmd, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
}

loadEnvFile();
const convexUrl = (process.env.JUSTASK_CONVEX_URL || "").replace(/\/$/, "");
if (!/^https:\/\/[a-z0-9-]+\.convex\.cloud$/.test(convexUrl)) {
  console.error("Set JUSTASK_CONVEX_URL=https://<name>.convex.cloud in .env.deploy or your shell. See docs/DEPLOY.md.");
  process.exit(1);
}
const siteUrl = convexUrl.replace(/\.convex\.cloud$/, ".convex.site");

// 1. Backend: functions, schema, crons and the /plan HTTP action.
if (!args.has("--skip-backend")) run("npx convex deploy --yes", join(ROOT, "packages/backend"));

// 2. Extension: planner goes through Convex's /plan, so the Anthropic key never leaves Convex.
const extEnv = { VITE_CONVEX_URL: convexUrl, VITE_PLANNER_URL: siteUrl };
run("npm run build -w @justask/extension", ROOT, extEnv);
run("npm run zip -w @justask/extension", ROOT, extEnv);
const outDir = join(ROOT, "apps/extension/.output");
const zip = readdirSync(outDir).find((f) => f.endsWith("-chrome.zip"));

// 3. Caregiver web app.
const cgEnv = { VITE_CONVEX_URL: convexUrl, ...(process.env.JUSTASK_EXTENSION_URL ? { VITE_EXTENSION_URL: process.env.JUSTASK_EXTENSION_URL } : {}) };
run("npm run build -w @justask/caregiver", ROOT, cgEnv);

/**
 * Publish an already-built static folder with Vercel's Build Output API, so Vercel never has to
 * build our monorepo. The first run links (or creates) a Vercel project for that folder.
 */
function vercelStatic(appDir, staticDir, routes, project) {
  // First run on this machine: link (or create) the named project under your Vercel account.
  if (!existsSync(join(appDir, ".vercel/project.json"))) run(`npx vercel link --yes --project ${project}`, appDir);
  const out = join(appDir, ".vercel/output");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(staticDir, join(out, "static"), { recursive: true });
  writeFileSync(join(out, "config.json"), JSON.stringify({ version: 3, routes }, null, 2));
  run("npx vercel deploy --prebuilt --prod --yes", appDir);
}

if (args.has("--vercel")) {
  // Caregiver app: hash routes, so every path serves index.html.
  vercelStatic(join(ROOT, "apps/caregiver"), join(ROOT, "apps/caregiver/dist"), [{ handle: "filesystem" }, { src: "/(.*)", dest: "/index.html" }], "justask-caregiver");
  // Fixture sites (test pages only): "/pharmacy/refill" serves pharmacy/refill.html, like serve.mjs.
  vercelStatic(join(ROOT, "apps/fixtures"), join(ROOT, "apps/fixtures/public"), [{ handle: "filesystem" }, { src: "/(.*[^/])$", dest: "/$1.html" }], "justask-fixtures");
}

console.log(`
Done.
  Backend:    ${convexUrl}  (HTTP actions: ${siteUrl})
  Extension:  apps/extension/.output/${zip ?? "<zip>"}   (unzip, then chrome://extensions > Load unpacked)
  Caregiver:  apps/caregiver/dist${args.has("--vercel") ? "  (pushed to Vercel)" : "   (add --vercel to publish)"}
`);
