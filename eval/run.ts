// Prompt eval runner: send each captured snapshot to Claude exactly the way planStep does,
// score the reply, and print + save a report. See docs/eval.md.
//
//   npm run eval -- [--provider anthropic|deepseek] [--model claude-opus-5-5] [--effort low] [--repeat 1] [--only <id>] [--dry] [--concurrency 3]
//
// --provider deepseek (issue #18) sends the same snapshots through packages/backend/lib/providers/deepseek.ts
// and needs DEEPSEEK_API_KEY. Fixture snapshots only: live-site snapshots stay off DeepSeek until the privacy review.
// Needs ANTHROPIC_API_KEY. Without it, it runs in --dry mode (a fixed stub step) and exits 0.
// Nothing is sent to Convex. Reports stay in eval/reports/ (gitignored).
import Anthropic from "@anthropic-ai/sdk";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildTurn, SYSTEM_PROMPT } from "../packages/core/src/prompt";
import { MAX_SAY_WORDS, StepResponse, stepJsonSchema, type PageSnapshot } from "../packages/shared/src/index";
import { percentile, scoreStep, type EvalCase, type Score } from "./lib/score";
import { deepseekPlanStep } from "../packages/backend/lib/providers/deepseek";

const EVAL = fileURLToPath(new URL(".", import.meta.url));

// ───────────── flags ─────────────
const argv = process.argv.slice(2);
const flag = (name: string, def: string | null = null) => (argv.includes(name) ? (argv[argv.indexOf(name) + 1] ?? def) : def);
const provider = flag("--provider", "anthropic") === "deepseek" ? "deepseek" : "anthropic";
const model = flag("--model", provider === "deepseek" ? "deepseek-chat" : "claude-opus-5-5")!;
const effort = flag("--effort", "low")! as "low" | "medium" | "high";
const repeat = Math.max(1, Number(flag("--repeat", "1")));
const only = flag("--only");
const concurrency = Math.min(3, Math.max(1, Number(flag("--concurrency", "3")))); // cost guard: never above 3
const apiKey = provider === "deepseek" ? process.env.DEEPSEEK_API_KEY : process.env.ANTHROPIC_API_KEY;
let dry = argv.includes("--dry");
if (!apiKey && !dry && provider === "deepseek") {
  console.log("DEEPSEEK_API_KEY is not set, so this is a dry run with a stub step.\n");
  dry = true;
}
if (!apiKey && !dry) {
  console.log(
    [
      "ANTHROPIC_API_KEY is not set, so this is a dry run with a stub step (it proves the harness, not the prompt).",
      "To run against Claude:",
      '  Git Bash:   export ANTHROPIC_API_KEY="sk-ant-..."   then  npm run eval',
      '  PowerShell: $env:ANTHROPIC_API_KEY="sk-ant-..."     then  npm run eval',
      "",
    ].join("\n"),
  );
  dry = true;
}

// ───────────── cases ─────────────
const cases: EvalCase[] = readdirSync(`${EVAL}cases`)
  .filter((f) => f.endsWith(".case.json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(`${EVAL}cases/${f}`, "utf8")))
  .filter((c: EvalCase) => !only || c.id === only)
  // Real sites' snapshots never go to DeepSeek before the privacy review.
  .filter((c: EvalCase) => provider !== "deepseek" || !c.live);
const ready: Array<{ c: EvalCase; snapshot: PageSnapshot }> = [];
const notCaptured: string[] = [];
for (const c of cases) {
  const p = `${EVAL}snapshots/${c.id}.json`;
  if (existsSync(p)) ready.push({ c, snapshot: JSON.parse(readFileSync(p, "utf8")) });
  else notCaptured.push(c.id);
}
if (!ready.length) {
  console.log(only ? `No captured snapshot for case "${only}". Run: npm run eval:capture -- --only ${only}` : "No snapshots. Run: npm run eval:capture");
  process.exit(dry ? 0 : 1);
}

// ───────────── one call (mirrors packages/backend/lib/planStep.ts) ─────────────
interface CallResult {
  step: StepResponse | null;
  error: string | null;
  latencyMs: number;
  outputTokens: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  servedBy: string;
}

const STEP_JSON_SCHEMA = stepJsonSchema();
// Longer timeout than planStep's 10 s so medium/high effort isn't cut off in the eval.
const client = dry || provider !== "anthropic" ? null : new Anthropic({ apiKey, timeout: 60_000, maxRetries: 1 });
const BLOCKED = (say: string): StepResponse => ({ kind: "blocked", say, target: null, expect: null, option: null, text: null, risk: "none" });
const DRY_STEP: StepResponse = { kind: "guide", say: "Click the first thing on the page.", target: 1, expect: "click", option: null, text: null, risk: "none" };

async function callClaude(c: EvalCase, snapshot: PageSnapshot): Promise<CallResult> {
  const r: CallResult = { step: null, error: null, latencyMs: 0, outputTokens: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, servedBy: dry ? "dry-stub" : model };
  if (!dry && provider === "deepseek") return callDeepSeek(c, snapshot, r);
  if (!client) {
    r.step = DRY_STEP;
    return r;
  }
  const started = Date.now();
  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try {
      res = await client.beta.messages.create({
        model,
        max_tokens: 4096,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort, format: { type: "json_schema", schema: STEP_JSON_SCHEMA } },
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: buildTurn(c.request, c.history ?? [], c.recipe ?? null, snapshot, null) }],
      });
    } catch (err) {
      r.error = err instanceof Anthropic.APIError ? `api ${err.status ?? ""} ${err.constructor.name}`.trim() : String(err);
      r.latencyMs = Date.now() - started;
      return r;
    }
    r.outputTokens += res.usage.output_tokens;
    r.inputTokens += res.usage.input_tokens;
    r.cacheReadTokens += res.usage.cache_read_input_tokens ?? 0;
    r.cacheWriteTokens += res.usage.cache_creation_input_tokens ?? 0;
    r.servedBy = res.model;
    if (res.stop_reason === "refusal") {
      r.step = BLOCKED("I can't help with this page. Let's ask your helper.");
      r.error = "refusal";
      break;
    }
    if (res.stop_reason === "max_tokens") continue; // planStep retries once, then blocked
    const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    try {
      r.step = StepResponse.parse(JSON.parse(text));
    } catch {
      r.error = "unparseable reply";
    }
    break;
  }
  if (!r.step && !r.error) {
    r.step = BLOCKED("I'm having trouble. Let's try again in a moment.");
    r.error = "max_tokens twice";
  }
  r.latencyMs = Date.now() - started;
  return r;
}

/** The DeepSeek provider exactly as `/plan` runs it (Zod parse, checkStep, one retry, then blocked). */
async function callDeepSeek(c: EvalCase, snapshot: PageSnapshot, r: CallResult): Promise<CallResult> {
  const started = Date.now();
  const req = { deviceToken: null, sessionId: null, request: c.request, history: c.history ?? [], recipe: c.recipe ?? null, snapshot, retryNote: null };
  const res = await deepseekPlanStep(apiKey!, req, (l) => {
    r.outputTokens += l.outputTokens ?? 0;
    r.cacheReadTokens += l.cacheReadTokens ?? 0;
  }, { model, timeoutMs: 60_000 });
  r.latencyMs = Date.now() - started;
  if (res.ok) r.step = res.step;
  else r.error = res.error;
  return r;
}

// ───────────── run (pool of ≤3; first job alone so it writes the cache) ─────────────
interface Row extends CallResult {
  id: string;
  attempt: number;
  expected: string;
  score: Score | null;
}
const jobs = ready.flatMap(({ c, snapshot }) => Array.from({ length: repeat }, (_, i) => ({ c, snapshot, attempt: i + 1 })));
const rows: Row[] = new Array(jobs.length);
const expectedDesc = (c: EvalCase) => {
  const kinds = (c.expected.allowKinds ?? [c.expected.kind]).join("/");
  const t = c.expected.targetText === undefined ? "" : ` "${[c.expected.targetText].flat().join('" | "')}"`;
  const f = c.expected.forbidTargetText?.length ? ` not "${c.expected.forbidTargetText.join('", "')}"` : "";
  const s = c.expected.sayIncludes?.length ? ` say has "${c.expected.sayIncludes.join('", "')}"` : "";
  return kinds + t + f + s;
};
async function runJob(i: number) {
  const { c, snapshot, attempt } = jobs[i];
  const res = await callClaude(c, snapshot);
  const score = res.step && res.error !== "unparseable reply" ? scoreStep(c, res.step, snapshot) : null;
  if (score && res.error && res.error !== "refusal") score.pass = false;
  rows[i] = { ...res, id: c.id, attempt, expected: expectedDesc(c), score };
  const mark = score?.pass ? "✓" : "✗";
  console.log(`${mark} ${c.id}${repeat > 1 ? ` #${attempt}` : ""}  ${res.step?.kind ?? "-"} ${score?.targetDesc ? `→ ${score.targetDesc}` : ""}${res.error ? `  [${res.error}]` : ""}  ${res.latencyMs} ms`);
}

console.log(`eval: ${jobs.length} run(s) over ${ready.length} case(s) — ${provider} model ${model}${provider === "anthropic" ? `, effort ${effort}` : ""}${dry ? ", DRY" : ""}\n`);
if (jobs.length) await runJob(0);
let next = 1;
await Promise.all(
  Array.from({ length: Math.min(concurrency, jobs.length - 1) }, async () => {
    while (next < jobs.length) await runJob(next++);
  }),
);

// ───────────── report ─────────────
const n = rows.length;
const rate = (f: (r: Row) => boolean) => rows.filter(f).length;
const pct = (k: number) => (n ? `${((100 * k) / n).toFixed(0)}%` : "-");
const passed = rate((r) => !!r.score?.pass);
const lat = rows.filter((r) => !r.error || r.error === "refusal").map((r) => r.latencyMs);
const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
const summary = {
  provider,
  model,
  effort,
  repeat,
  dry,
  runs: n,
  cases: ready.length,
  accuracy: n ? passed / n : 0,
  kindOk: rate((r) => !!r.score?.kindOk),
  targetOk: rate((r) => !!r.score?.targetOk),
  sayOk: rate((r) => !!r.score?.sayOk),
  checkOk: rate((r) => !!r.score?.checkOk),
  /** Replies that fail checkStep after the trim: each one costs the user a second Claude call. */
  replans: rate((r) => !!r.score && !r.score.checkOk),
  trimmed: rate((r) => !!r.score?.trimmed),
  overLimit: rate((r) => (r.score?.sayWords ?? 0) > MAX_SAY_WORDS),
  checkCodes: rows.reduce<Record<string, number>>((acc, r) => {
    if (r.score?.checkCode) acc[r.score.checkCode] = (acc[r.score.checkCode] ?? 0) + 1;
    return acc;
  }, {}),
  errors: rate((r) => !!r.error && r.error !== "refusal"),
  p50LatencyMs: percentile(lat, 50),
  p90LatencyMs: percentile(lat, 90),
  avgOutputTokens: avg(rows.map((r) => r.outputTokens)),
  avgCacheReadTokens: avg(rows.map((r) => r.cacheReadTokens)),
  totalCacheReadTokens: rows.reduce((a, r) => a + r.cacheReadTokens, 0),
  totalCacheWriteTokens: rows.reduce((a, r) => a + r.cacheWriteTokens, 0),
  notCaptured,
};

const yes = (b: boolean | undefined) => (b ? "✓" : "✗");
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const table = [
  "| case | # | got | expected | target | kind | target | said | check | ms | out tok | cache read | say |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ...rows.map((r) =>
    [
      r.id,
      r.attempt,
      (r.step?.kind ?? "-") + (r.error ? ` (${r.error})` : ""),
      r.expected,
      r.score?.targetDesc ? `${r.step?.target}: ${r.score.targetDesc}` : (r.step?.target ?? "-"),
      yes(r.score?.kindOk),
      yes(r.score?.targetOk),
      yes(r.score?.sayOk),
      r.score?.checkOk ? (r.score.trimmed ? "✓ trimmed" : "✓") : `✗ ${r.score?.checkReason ?? ""}`,
      r.latencyMs,
      r.outputTokens,
      r.cacheReadTokens,
      r.step?.say ?? "",
    ]
      .map((x) => cell(String(x)))
      .join(" | ")
      .replace(/^/, "| ")
      .replace(/$/, " |"),
  ),
].join("\n");

const head = [
  `# JustAsk prompt eval — ${new Date().toISOString()}`,
  "",
  ...(dry ? ["**DRY RUN: stub step, not a real score.**", ""] : []),
  `- model \`${model}\`, effort \`${effort}\`, repeat ${repeat}, ${ready.length} cases, ${n} runs`,
  `- **accuracy ${passed}/${n} (${pct(passed)})** — kind ${pct(summary.kindOk)}, target ${pct(summary.targetOk)}, say ${pct(summary.sayOk)}, checkStep ${pct(summary.checkOk)}, errors ${summary.errors}`,
  `- **re-plans ${summary.replans}/${n} (${pct(summary.replans)})** — say over ${MAX_SAY_WORDS} words ${summary.overLimit}, trimmed instead ${summary.trimmed}${Object.keys(summary.checkCodes).length ? `; failures: ${Object.entries(summary.checkCodes).map(([k, v]) => `${k} ${v}`).join(", ")}` : ""}`,
  `- latency p50 ${summary.p50LatencyMs} ms, p90 ${summary.p90LatencyMs} ms`,
  `- avg output tokens ${summary.avgOutputTokens}; cache read avg ${summary.avgCacheReadTokens} / total ${summary.totalCacheReadTokens}; cache write total ${summary.totalCacheWriteTokens}`,
  ...(notCaptured.length ? [`- not captured (skipped): ${notCaptured.join(", ")}`] : []),
].join("\n");

console.log("\n" + table + "\n\n" + head.replace(/^# .*\n\n/, "").replace(/\*\*/g, ""));

mkdirSync(`${EVAL}reports`, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const base = `${EVAL}reports/${stamp}-${model}-${effort}${dry ? "-dry" : ""}`;
writeFileSync(`${base}.md`, `${head}\n\n${table}\n`);
writeFileSync(`${base}.json`, JSON.stringify({ summary, rows }, null, 2) + "\n");
console.log(`\nreport: ${base}.md`);
// Every call failing (bad key, no network) is a harness failure, not a score.
process.exit(!dry && summary.errors === n ? 1 : 0);
