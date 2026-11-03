// Multi-turn conversation eval: the real SessionController and the real Claude planStep, on scripted fake
// pages and scripted user replies. Each scenario runs N times (Claude isn't deterministic) and has
// assertions, not only a transcript. See docs/eval.md.
//
//   npm run eval:conversations -- [--repeat 3] [--only <name>] [--verbose] [--model claude-opus-5-5] [--effort low]
//
// Needs ANTHROPIC_API_KEY (about 150 Claude calls at --repeat 3). Not run in CI. Reports stay in eval/reports/.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeClient, planStep, type PlanOptions } from "../packages/backend/lib/planStep";
import { checkAssertions, needed, runScenario } from "./lib/conversation";
import { PAGES, SCENARIOS } from "./conversations/scenarios";

const EVAL = fileURLToPath(new URL(".", import.meta.url));
const argv = process.argv.slice(2);
const flag = (name: string, def: string | null = null) => (argv.includes(name) ? (argv[argv.indexOf(name) + 1] ?? def) : def);
const repeat = Math.max(1, Number(flag("--repeat", "3")));
const only = flag("--only");
const verbose = argv.includes("--verbose");
const model = flag("--model", "claude-opus-5-5")!;
const effort = flag("--effort", "low")! as NonNullable<PlanOptions["effort"]>;
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.log("ANTHROPIC_API_KEY is not set. This eval talks to Claude; set the key and run again (docs/eval.md).");
  process.exit(1);
}
const scenarios = SCENARIOS.filter((s) => !only || s.name === only);
if (!scenarios.length) {
  console.log(`No scenario "${only}". Scenarios: ${SCENARIOS.map((s) => s.name).join(", ")}`);
  process.exit(1);
}

const client = makeClient(apiKey, 30_000);
const planner = { plan: (req: Parameters<typeof planStep>[1]) => planStep(client, req, { model, effort }) };

interface Result {
  name: string;
  kind: string;
  passes: number;
  needed: number;
  calls: number;
  replans: number;
  fails: string[];
}
const results: Result[] = [];
const transcripts: string[] = [];
console.log(`conversations: ${scenarios.length} scenario(s) x ${repeat}, model ${model}, effort ${effort}\n`);

// One scenario at a time, runs in order: the first call writes the prompt cache for the rest.
for (const sc of scenarios) {
  const r: Result = { name: sc.name, kind: sc.kind, passes: 0, needed: needed(sc.kind, repeat), calls: 0, replans: 0, fails: [] };
  for (let i = 1; i <= repeat; i++) {
    let fails: string[];
    let log: string[] = [];
    try {
      const t = await runScenario(sc, PAGES, planner);
      fails = checkAssertions(sc, t);
      r.calls += t.claudeCalls;
      r.replans += t.replans;
      log = t.log;
    } catch (e) {
      fails = [`crashed: ${String(e)}`];
    }
    if (!fails.length) r.passes++;
    r.fails.push(...fails.map((f) => `#${i}: ${f}`));
    console.log(`${fails.length ? "✗" : "✓"} ${sc.name} #${i}${fails.length ? `  ${fails.join("; ")}` : ""}`);
    const block = [`### ${sc.name} #${i} (${fails.length ? "FAIL" : "pass"})`, ...log, ...fails.map((f) => `FAIL: ${f}`)].join("\n");
    transcripts.push(block);
    if (verbose) console.log(block + "\n");
  }
  results.push(r);
}

const ok = (r: Result) => r.passes >= r.needed;
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const table = [
  "| scenario | kind | passed | needed | result | Claude calls | re-plans | failures |",
  "|---|---|---|---|---|---|---|---|",
  ...results.map((r) => `| ${[r.name, r.kind, `${r.passes}/${repeat}`, `${r.needed}/${repeat}`, ok(r) ? "PASS" : "FAIL", r.calls, r.replans, r.fails.join("; ")].map((x) => cell(String(x))).join(" | ")} |`),
].join("\n");
const failed = results.filter((r) => !ok(r));
const calls = results.reduce((a, r) => a + r.calls, 0);
const replans = results.reduce((a, r) => a + r.replans, 0);
const head = [
  `# JustAsk conversation eval — ${new Date().toISOString()}`,
  "",
  `- model \`${model}\`, effort \`${effort}\`, ${scenarios.length} scenarios x ${repeat}`,
  `- **${results.length - failed.length}/${results.length} scenarios pass** (safety needs every run, UX two in three)${failed.length ? `; failing: ${failed.map((r) => r.name).join(", ")}` : ""}`,
  `- Claude calls ${calls}, re-plans ${replans} (${calls ? ((100 * replans) / calls).toFixed(1) : 0}%)`,
].join("\n");
console.log("\n" + table + "\n\n" + head.replace(/^# .*\n\n/, "").replace(/\*\*/g, ""));

mkdirSync(`${EVAL}reports`, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const base = `${EVAL}reports/${stamp}-conversations-${model}-${effort}`;
writeFileSync(`${base}.md`, `${head}\n\n${table}\n\n## Transcripts\n\n${transcripts.join("\n\n")}\n`);
console.log(`\nreport: ${base}.md`);
process.exit(failed.length ? 1 : 0);
