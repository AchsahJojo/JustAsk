// Conversation stress test: the real SessionController and the real Claude planStep, on scripted fake pages
// and scripted user replies ("I don't have a code", "not yet", "thank you"). Prints each turn so loops show up.
// Needs ANTHROPIC_API_KEY in the shell (calls Claude). Run: npx tsx scripts/stress-conversations.ts [scenario]
import { SessionController, type PageBridge } from "../packages/core/src/controller";
import { makeClient, planStep } from "../packages/backend/lib/planStep";
import type { FrameScan, SnapshotElement } from "../packages/shared/src";

type El = Partial<SnapshotElement> & { role: string; text: string };
const el = (n: number, e: El): SnapshotElement => ({ n, label: null, nearby: null, color: null, big: false, disabled: false, inModal: false, inViewport: true, region: "main", ...e });
const page = (url: string, title: string, heading: string, pageText: string, els: El[]): FrameScan[] => [
  { frameId: 0, isTop: true, visibleFrames: 0, snapshot: { url, title, heading, pageText, surface: "web", omitted: { count: 0, regions: [] }, elements: els.map((e, i) => el(i + 1, e)) } },
];

const PAGES: Record<string, FrameScan[]> = {
  meet: page("https://meet.google.com/landing", "Google Meet", "Video calls and meetings for everyone", "Video calls and meetings for everyone. Connect, collaborate and celebrate from anywhere with Google Meet. New meeting. Enter a code or link. Join. Learn more about Google Meet", [
    { role: "button", text: "New meeting", color: "blue", big: true },
    { role: "text box", text: "", label: "Enter a code or link", field: { kind: "text", hasValue: false, valid: true } },
    { role: "button", text: "Join", disabled: true },
    { role: "link", text: "Learn more", region: "main" },
    { role: "button", text: "Google apps", region: "header" },
    { role: "link", text: "Sign in", region: "header", color: "blue" },
  ]),
  meetNew: page("https://meet.google.com/landing", "Google Meet", "Video calls and meetings for everyone", "New meeting menu open. Create a meeting for later. Start an instant meeting. Schedule in Google Calendar", [
    { role: "menu item", text: "Create a meeting for later", inModal: true },
    { role: "menu item", text: "Start an instant meeting", inModal: true },
    { role: "menu item", text: "Schedule in Google Calendar", inModal: true },
    { role: "text box", text: "", label: "Enter a code or link", field: { kind: "text", hasValue: false, valid: true } },
  ]),
  login: page("https://accounts.example-mail.com/signin", "Sign in - ExampleMail", "Sign in", "Sign in to continue to ExampleMail. Email. Password. Forgot password? Create account", [
    { role: "text box", text: "", label: "Email", field: { kind: "email", hasValue: true, valid: true } },
    { role: "text box", text: "", label: "Password", field: { kind: "password", hasValue: false, valid: true, sensitive: true } },
    { role: "button", text: "Next", color: "blue" },
    { role: "link", text: "Forgot password?" },
    { role: "link", text: "Create account" },
  ]),
  store: page("https://books.example.com/", "Example Books", "Books", "Bestsellers. New releases. Search books.", [
    { role: "search box", text: "", label: "Search books", field: { kind: "search", hasValue: false, valid: true } },
    { role: "link", text: "Bestsellers" },
    { role: "link", text: "New releases" },
    { role: "link", text: "Fiction", region: "nav" },
  ]),
  pharmacy: page("https://pharmacy.example.com/refill", "Refill - Example Pharmacy", "Refill a prescription", "Choose a prescription to refill. Lisinopril 10mg - Refill. Metformin 500mg - Refill. Pickup or delivery.", [
    { role: "button", text: "Refill", nearby: "Lisinopril 10mg", color: "blue" },
    { role: "button", text: "Refill", nearby: "Metformin 500mg", color: "blue" },
    { role: "radio", text: "Pick up in store", field: { kind: "radio", hasValue: false, valid: true, checked: false } },
    { role: "radio", text: "Delivery", field: { kind: "radio", hasValue: false, valid: true, checked: false } },
  ]),
  zoom: page("https://zoom.example.us/join", "Join Meeting - Zoom", "Join Meeting", "Join a meeting. Meeting ID or Personal Link Name. Join. Join a meeting from an H.323/SIP room system", [
    { role: "text box", text: "", label: "Meeting ID or Personal Link Name", field: { kind: "text", hasValue: false, valid: true } },
    { role: "button", text: "Join", disabled: true, color: "blue" },
    { role: "link", text: "Sign in", region: "header" },
    { role: "link", text: "Host a meeting", region: "header" },
  ]),
};

type Act = { input: string } | { stuck: true } | { click: string } | { confirm: boolean } | { done: true };
interface Scenario {
  name: string; request: string; start: string; script: Act[];
  /** Names a guide step must never point at unless the user said them (#12: no outside knowledge picks a medicine). */
  neverGuideTo?: string[];
}

const SCENARIOS: Scenario[] = [
  { name: "meet-no-code", request: "go to google meet", start: "meet", script: [{ input: "I don't have a code" }, { input: "I don't have one" }, { input: "not yet" }] },
  { name: "meet-not-now", request: "help me join a meeting on google meet", start: "meet", script: [{ input: "my daughter hasn't sent it yet" }, { input: "no" }, { input: "I'll do it later" }] },
  { name: "meet-stuck", request: "open google meet", start: "meet", script: [{ stuck: true }, { stuck: true }, { stuck: true }] },
  { name: "zoom-later", request: "join my zoom call", start: "zoom", script: [{ input: "I don't know the meeting ID" }, { input: "I don't know" }, { input: "never mind the ID" }] },
  { name: "login-forgot", request: "sign in to my email", start: "login", script: [{ input: "I forgot my password" }, { input: "I don't remember it" }] },
  { name: "book-dontknow", request: "get the new book", start: "store", script: [{ input: "I don't know" }, { input: "whatever is popular" }, { input: "I don't know, you pick" }] },
  { name: "pharmacy-clarify", request: "refill my prescription", start: "pharmacy", script: [{ input: "the blood pressure one" }, { input: "I'm not sure" }, { input: "either is fine" }], neverGuideTo: ["Lisinopril", "Metformin"] },
  { name: "done-thanks", request: "go to google meet", start: "meet", script: [{ input: "thank you" }] },
];

const client = makeClient(process.env.ANTHROPIC_API_KEY!, 30_000);
const only = process.argv[2];
const totals = { calls: 0, replans: 0, trimmed: 0 };

async function run(sc: Scenario) {
  let cur = sc.start;
  const out: string[] = [`\n### ${sc.name} — request "${sc.request}" on ${sc.start}`];
  let calls = 0;
  const said = [sc.request, ...sc.script.flatMap((a) => ("input" in a ? [a.input] : []))].join(" ").toLowerCase();
  const flagged: string[] = [];
  const bridge: PageBridge = {
    scan: async () => PAGES[cur],
    highlight: async () => true, clear: async () => {}, pulse: async () => {},
    waitForChange: async () => true, act: async () => ({ ok: false }), watch: () => {},
  };
  const c = new SessionController({
    bridge,
    planner: {
      plan: async (req) => {
        calls++;
        // A retryNote means the last reply failed checkStep: this call is a re-plan the user waits for.
        if (req.retryNote) totals.replans++;
        const r = await planStep(client, req, (l) => (l.trimmed ? totals.trimmed++ : 0));
        if (r.ok) {
          out.push(`    [claude] ${JSON.stringify(r.step)}`);
          if (r.step.kind === "guide" || r.step.kind === "act") for (const n of sc.neverGuideTo ?? []) if (r.step.say.toLowerCase().includes(n.toLowerCase()) && !said.includes(n.toLowerCase())) flagged.push(n);
        } else out.push(`    [claude error] ${r.error}`);
        return r;
      },
    },
    speech: { speak: (t) => out.push(`  SAY: ${t}`), stop: () => {} },
    timing: { stepTimeoutMs: 30_000, slowNoteMs: 60_000, waitRecheckMs: 600_000 },
  });
  const snap = () => out.push(`  -> phase=${c.state.phase} expect=${c.state.expect} line="${c.state.line}"`);
  await c.start(sc.request); snap();
  for (const a of sc.script) {
    if ("input" in a) { out.push(`USER: "${a.input}"`); await c.input(a.input); }
    else if ("stuck" in a) { out.push(`USER: [I'm stuck]`); await c.stuck(); }
    else if ("confirm" in a) { out.push(`USER: [confirm ${a.confirm}]`); await c.confirm(a.confirm); }
    else if ("click" in a) { out.push(`USER: [clicks -> ${a.click}]`); cur = a.click; await c.onContent({ type: "ja:step-done", how: "click" } as never, 0); }
    snap();
  }
  totals.calls += calls;
  out.push(`  history: ${JSON.stringify(c.currentHistory)}`, `  claude calls: ${calls}`);
  if (sc.neverGuideTo) out.push(flagged.length ? `  FAIL: guided to ${flagged.join(", ")}, which the user never said` : "  OK: never guided to a name the user didn't say");
  console.log(out.join("\n"));
}

for (const sc of SCENARIOS) if (!only || sc.name === only) await run(sc).catch((e) => console.log(sc.name, "CRASH", e));
const pct = totals.calls ? ((100 * totals.replans) / totals.calls).toFixed(1) : "0";
console.log(`\nclaude calls ${totals.calls}, re-plans ${totals.replans} (${pct}%), trimmed instead ${totals.trimmed}`);
