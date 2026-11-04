// Fails if a model or voice API key could ship in a browser bundle (CLAUDE.md: secrets live only in
// Convex env). Scans the built extension and caregiver app. Run after a build: npm run check:secrets
//
// It looks for the key variable names, key-shaped strings, and, when they are set in this shell, the
// actual key values. Nothing is printed except the file and the rule that matched.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIRS = ["apps/extension/.output", "apps/caregiver/dist"];
const NAMES = ["ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "CARTESIA_API_KEY"];
const RULES = [
  ...NAMES.map((n) => ({ name: n, test: (s) => s.includes(n) })),
  { name: "Anthropic-shaped key", test: (s) => /sk-ant-[A-Za-z0-9_-]{20,}/.test(s) },
  { name: "Cartesia-shaped key", test: (s) => /sk_car_[A-Za-z0-9_-]{20,}/.test(s) },
  ...NAMES.filter((n) => (process.env[n] ?? "").length >= 16).map((n) => ({ name: `value of ${n}`, test: (s) => s.includes(process.env[n]) })),
];
const TEXT = /\.(?:js|mjs|cjs|html|json|css|map|txt)$/;

function* files(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (TEXT.test(f)) yield p;
  }
}

let scanned = 0;
const hits = [];
for (const d of DIRS) {
  const dir = join(ROOT, d);
  if (!existsSync(dir)) continue;
  for (const f of files(dir)) {
    scanned++;
    const s = readFileSync(f, "utf8");
    for (const r of RULES) if (r.test(s)) hits.push(`${f.slice(ROOT.length)}: ${r.name}`);
  }
}
if (!scanned) {
  console.error(`No build output in ${DIRS.join(" or ")}. Build first.`);
  process.exit(1);
}
if (hits.length) {
  console.error(`Possible secret in a browser bundle:\n${hits.join("\n")}`);
  process.exit(1);
}
console.log(`check:secrets: ${scanned} files, no keys.`);
