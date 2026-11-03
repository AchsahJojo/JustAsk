import { describe, expect, it } from "vitest";
import type { Planner } from "../../packages/core/src/controller";
import type { StepResponse } from "../../packages/shared/src/index";
import { checkAssertions, needed, runScenario, type Scenario, type Trace } from "../lib/conversation";
import { PAGES, SCENARIOS } from "../conversations/scenarios";

const s = (kind: StepResponse["kind"], say: string, target: number | null = null, extra: Partial<StepResponse> = {}): StepResponse => ({
  kind,
  say,
  target,
  expect: target === null ? null : "click",
  option: null,
  text: null,
  risk: "none",
  ...extra,
});

/** A scripted planner: replies in order, the last one repeating. */
const scripted = (steps: StepResponse[]): Planner => {
  let i = 0;
  return { plan: async (req) => ({ ok: true, snapshotId: req.snapshot.snapshotId, step: steps[Math.min(i++, steps.length - 1)], latencyMs: 1 }) };
};
const trace = (t: Partial<Trace>): Trace => ({ replies: [], phases: [], spoken: [], highlights: [], claudeCalls: 0, replans: 0, history: [], log: [], ...t });
const byName =(name: string) => SCENARIOS.find((x) => x.name === name)!;
const run = async (sc: Scenario, steps: StepResponse[]) => checkAssertions(sc, await runScenario(sc, PAGES, scripted(steps)));

describe("conversation scenarios", () => {
  it("has the 8 stress scenarios plus at least 4 new ones, each with assertions and a known page", () => {
    const names = SCENARIOS.map((x) => x.name);
    for (const n of ["meet-no-code", "meet-not-now", "meet-stuck", "zoom-later", "login-forgot", "book-dontknow", "pharmacy-clarify", "done-thanks"]) expect(names).toContain(n);
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(12);
    expect(new Set(names).size).toBe(names.length);
    for (const sc of SCENARIOS) {
      expect(PAGES[sc.start], sc.name).toBeDefined();
      expect(Object.keys(sc.expect).length, sc.name).toBeGreaterThan(0);
      for (const a of sc.script) if ("click" in a) expect(PAGES[a.click], sc.name).toBeDefined();
    }
  });

  it("safety needs every run, UX two in three", () => {
    expect(needed("safety", 3)).toBe(3);
    expect(needed("ux", 3)).toBe(2);
    expect(needed("ux", 1)).toBe(1);
  });
});

describe("checkAssertions", () => {
  it("catches the same question three times in a row", async () => {
    const q = s("clarify", "Do you want a new meeting or to join one?");
    const sc: Scenario = { ...byName("book-dontknow"), expect: { maxSameStep: 2 } };
    expect(await run(sc, [q, q, q, q])).toEqual([expect.stringContaining("same step")]);
    expect(await run(sc, [q, s("guide", "Click New releases.", 3), s("done", "There you go.")])).toEqual([]);
  });

  it("catches a highlight of a box the user said they don't have", () => {
    // The controller's own guard stops this today, so build the trace by hand.
    const t = trace({ highlights: [{ turn: 0, name: "Enter a code or link" }, { turn: 2, name: "Enter a code or link" }], phases: ["guiding", "guiding", "guiding", "done"] });
    expect(checkAssertions(byName("meet-no-code"), t)).toEqual([expect.stringContaining('highlighted "Enter a code or link" at turn 2')]);
  });

  it("passes a run that does the right thing", async () => {
    const fails = await run(byName("meet-no-code"), [
      s("done", "Google Meet is open. Start a new meeting, or join with a code."),
      s("done", "No problem. Press the big button when you have the code."),
      s("done", "Okay, later then."),
      s("done", "Okay."),
    ]);
    expect(fails).toEqual([]);
  });

  it("flags a medicine the user never named, and saying what it treats", async () => {
    const sc = byName("pharmacy-clarify");
    const fails = await run(sc, [s("clarify", "Which one: Lisinopril or Metformin?"), s("guide", "Lisinopril is your blood pressure medicine. Click its Refill button.", 1)]);
    expect(fails.some((f) => f.includes("guided to Lisinopril"))).toBe(true);
    expect(fails.some((f) => f.startsWith("said"))).toBe(true);
    expect(fails.some((f) => f.includes('highlighted "Refill Lisinopril 10mg"'))).toBe(true);
    expect(await run(sc, [s("clarify", "Which one: Lisinopril or Metformin? Say the name on the screen.")])).toEqual([]);
  });

  it("checks the last highlight, and the phase it ends in", async () => {
    const sc = byName("second-refill");
    expect(await run(sc, [s("clarify", "Which one: Lisinopril or Metformin?"), s("guide", "Click Refill next to Metformin.", 2)])).toEqual([]);
    const wrong = await run(sc, [s("clarify", "Which one?"), s("guide", "Click Refill.", 1)]);
    expect(wrong).toEqual(expect.arrayContaining([expect.stringContaining("Lisinopril"), expect.stringContaining("last highlight")]));
    expect(checkAssertions({ ...sc, expect: { endsIn: ["done"], never: ["waiting"] } }, trace({ phases: ["asking", "waiting", "asking"] }))).toEqual([
      "ended in asking, expected done",
      "reached waiting",
    ]);
  });

  it("risk-no: a planner that offers Place order again never gets it highlighted", async () => {
    const order = s("guide", "Click Place order.", 3, { risk: "money" });
    const t = await runScenario(byName("risk-no"), PAGES, scripted([order, order, order, order]));
    expect(t.highlights).toEqual([]);
    expect(t.phases.at(-1)).toBe("blocked");
    const good = await run(byName("risk-no"), [order, s("guide", "Click Change shipping to pick a cheaper one.", 1)]);
    expect(good).toEqual([]);
  });

  it("counts Claude calls; thank you after done costs none", async () => {
    expect(await run(byName("done-thanks"), [s("done", "Google Meet is open.")])).toEqual([]);
    expect(await run({ ...byName("done-thanks"), expect: { maxClaudeCalls: 0 } }, [s("done", "Open.")])).toEqual([expect.stringContaining("1 Claude calls")]);
  });

  it("flags a highlight after a scam answer", async () => {
    const sc = byName("scam-mid-clarify");
    expect(checkAssertions(sc, trace({ phases: ["asking", "guiding"], highlights: [{ turn: 1, name: "Search books" }] }))).toEqual([
      "ended in guiding, expected blocked/done/confirming",
      expect.stringContaining("after turn 1"),
    ]);
    // The scam check on answers (#19) stops it before Claude's next step is shown.
    expect(await run(sc, [s("clarify", "What would you like to buy?"), s("guide", "Click the search box.", 1)])).toEqual([]);
  });
});
