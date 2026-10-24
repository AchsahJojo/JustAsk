import { describe, expect, it, vi } from "vitest";
import { SessionController, type PageBridge, type Planner } from "../src/controller";
import { mergeScans } from "../src/merge";
import { buildTurn, SYSTEM_PROMPT } from "../src/prompt";
import { parseCommand } from "../src/commands";
import type { FrameScan, PlanRequest, StepResponse } from "@justask/shared";

function frame(frameId: number, texts: string[], isTop = frameId === 0): FrameScan {
  return {
    frameId,
    isTop,
    visibleFrames: 0,
    snapshot: {
      url: "https://x.test/",
      title: "Page",
      heading: "H",
      pageText: `text of frame ${frameId}`,
      omitted: { count: 0, regions: [] },
      surface: "web",
      elements: texts.map((t, i) => ({ n: i + 1, role: "button", text: t, label: null, nearby: null, color: null, big: false, disabled: false, inModal: false, inViewport: true, region: "main" as const })),
    },
  };
}

function typedFrame(hasValue: boolean): FrameScan {
  const f = frame(0, [""]);
  f.snapshot.elements[0] = {
    ...f.snapshot.elements[0],
    role: "text box",
    label: "Full name",
    field: { kind: "text", hasValue, valid: true },
  };
  return f;
}

const guide = (target: number, say = "Click it.", extra: Partial<StepResponse> = {}): StepResponse => ({ kind: "guide", say, target, expect: "click", option: null, text: null, risk: "none", ...extra });

const act = (target: number, say = "I'm clicking it.", extra: Partial<StepResponse> = {}): StepResponse => ({ kind: "act", say, target, expect: "click", option: null, text: null, risk: "none", ...extra });
const step = (kind: StepResponse["kind"], say: string): StepResponse => ({ kind, say, target: null, expect: null, option: null, text: null, risk: "none" });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

interface HarnessOpts {
  actOk?: boolean;
  changed?: boolean;
  showMeInstead?: boolean;
  responseSnapshotId?: string;
  timing?: Record<string, number>;
  /** Give the bridge an openBrowser that resolves this value (or throws). Omitted: no openBrowser. */
  openBrowser?: boolean | "throw";
}

function harness(steps: StepResponse[], scans: FrameScan[][] = [[frame(0, ["A", "B"])]], opts: HarnessOpts = {}) {
  const plans: PlanRequest[] = [];
  let i = 0;
  let s = 0;
  const highlights: unknown[] = [];
  /** Call order across bridge and speech, for the act flow. */
  const ops: string[] = [];
  const bridge: PageBridge = {
    scan: vi.fn(async () => scans[Math.min(s++, scans.length - 1)]),
    highlight: vi.fn(async (ref, spec) => (highlights.push({ ref, spec }), ops.push(`highlight:${spec.label}`), true)),
    clear: vi.fn(async () => {}),
    pulse: vi.fn(async () => {}),
    waitForChange: vi.fn(async () => opts.changed ?? true),
    act: vi.fn(async () => (ops.push("act"), { ok: opts.actOk ?? false })),
    watch: vi.fn(),
  };
  if (opts.openBrowser !== undefined) {
    const result = opts.openBrowser;
    bridge.openBrowser = vi.fn(async () => {
      ops.push("openBrowser");
      if (result === "throw") throw new Error("no browser");
      return result;
    });
  }
  const planner: Planner = {
    plan: vi.fn(async (req: PlanRequest) => {
      plans.push(req);
      const step = steps[Math.min(i++, steps.length - 1)];
      return { ok: true as const, snapshotId: opts.responseSnapshotId ?? req.snapshot.snapshotId, step, latencyMs: 5 };
    }),
  };
  const spoken: string[] = [];
  const speech = { speak: (t: string) => (spoken.push(t), ops.push(`say:${t}`)), stop: () => {} };
  const events: string[] = [];
  const c = new SessionController({
    bridge,
    planner,
    speech,
    events: { log: (t) => events.push(t) },
    prefs: () => ({ showMeInstead: opts.showMeInstead ?? false }),
    timing: { changeTimeoutMs: 10, quietChangeMs: 7, actBeatMs: 0, waitRecheckMs: 60_000, ...opts.timing },
  });
  return { c, bridge, planner, plans, spoken, highlights, events, ops };
}

describe("mergeScans", () => {
  it("numbers frames into one list and maps back to (frameId, localId)", () => {
    const { snapshot, map } = mergeScans([frame(3, ["X"], false), frame(0, ["A", "B"])], "s1");
    expect(snapshot.elements.map((e) => [e.n, e.text])).toEqual([[1, "A"], [2, "B"], [3, "X"]]);
    expect(map.get(3)).toEqual({ frameId: 3, localId: 1 });
    expect(snapshot.pageText).toContain("text of frame 3");
  });
});

describe("SessionController", () => {
  it("runs a multi-step loop to done", async () => {
    const h = harness([guide(1, "Click A."), guide(2, "Click B."), { kind: "done", say: "All done, you did it!", target: null, expect: null, option: null, text: null, risk: "none" }]);
    await h.c.start("help me");
    expect(h.c.state.phase).toBe("guiding");
    expect(h.c.state.line).toBe("Click A.");
    await h.c.onContent({ type: "ja:step-done", how: "click" }, 0);
    expect(h.c.state.line).toBe("Click B.");
    expect(h.plans[1].history[0]).toBe('On "Page": She did: "Click A." (click)');
    await h.c.onContent({ type: "ja:step-done", how: "click" }, 0);
    expect(h.c.state.phase).toBe("done");
    expect(h.c.state.clicks).toBe(2);
    expect(h.events).toEqual(["step_shown", "step_shown", "done"]);
  });

  it("re-plans once on a failed check, then blocks", async () => {
    const h = harness([guide(99), guide(99)]);
    await h.c.start("x");
    expect(h.plans.length).toBe(2);
    expect(h.plans[1].retryNote).toContain("not in the current list");
    expect(h.c.state.phase).toBe("blocked");
  });

  it("asks before money steps; No ends without highlighting", async () => {
    const h = harness([guide(1, "Click Place order.", { risk: "money" })]);
    await h.c.start("buy");
    expect(h.c.state.phase).toBe("confirming");
    expect(h.highlights.length).toBe(0);
    await h.c.input("no");
    expect(h.c.state.phase).toBe("done");
    expect(h.highlights.length).toBe(0);
  });

  it("Yes on a risk step highlights", async () => {
    const h = harness([guide(1, "Click Place order.", { risk: "money" })]);
    await h.c.start("buy");
    await h.c.confirm(true);
    expect(h.c.state.phase).toBe("guiding");
    expect(h.highlights.length).toBe(1);
  });

  it("suspicious ends blocked", async () => {
    const h = harness([{ kind: "blocked", say: "Click Buy gift cards now.", target: null, expect: null, option: null, text: null, risk: "suspicious" }]);
    await h.c.start("x");
    expect(h.c.state.phase).toBe("blocked");
    expect(h.c.state.line).toBe("This page might be a trick. Let's stop and check with your helper.");
    expect(h.spoken).not.toContain("Click Buy gift cards now.");
  });

  it("blocks with a spoken recovery line when a planner reply has the wrong snapshot id", async () => {
    const h = harness([guide(1)], undefined, { responseSnapshotId: "other-snapshot" });
    await h.c.start("x");
    expect(h.c.state.phase).toBe("blocked");
    expect(h.c.state.line).toContain("trouble");
    expect(h.spoken.at(-1)).toContain("trouble");
    expect(h.highlights).toHaveLength(0);
  });

  it("clarify then answer goes into history", async () => {
    const h = harness([{ kind: "clarify", say: "Pickup or mail?", target: null, expect: null, option: null, text: null, risk: "none" }, guide(2)]);
    await h.c.start("refill");
    expect(h.c.state.phase).toBe("asking");
    await h.c.input("pick it up");
    expect(h.plans[1].history.at(-1)).toContain("pick it up");
    expect(h.c.state.phase).toBe("guiding");
  });

  it("highlights in the right frame", async () => {
    const h = harness([guide(3)], [[frame(0, ["A", "B"]), frame(7, ["Pay"], false)]]);
    await h.c.start("x");
    expect((h.highlights[0] as any).ref).toEqual({ frameId: 7, localId: 1 });
  });

  it("wrong click speaks reassurance and pulses, without advancing", async () => {
    const h = harness([guide(1)]);
    await h.c.start("x");
    await h.c.onContent({ type: "ja:wrong", what: "click" }, 0);
    expect(h.spoken.at(-1)).toContain("glowing box");
    expect(h.bridge.pulse).toHaveBeenCalled();
    expect(h.c.state.phase).toBe("guiding");
  });

  it("pauses when the page can't be scanned", async () => {
    const h = harness([guide(1)], [[]]);
    await h.c.start("x");
    expect(h.c.state.phase).toBe("paused");
    expect(h.c.state.pauseReason).toBe("cant-see");
  });

  it("stop cancels and ignores a late reply", async () => {
    const h = harness([guide(1)]);
    let release!: () => void;
    (h.planner.plan as any).mockImplementationOnce((req: PlanRequest) => new Promise((r) => (release = () => r({ ok: true, snapshotId: req.snapshot.snapshotId, step: guide(1), latencyMs: 1 }))));
    const p = h.c.start("x");
    await new Promise((r) => setTimeout(r, 5));
    await h.c.stop();
    release();
    await p;
    expect(h.c.state.phase).toBe("idle");
    expect(h.highlights.length).toBe(0);
  });

  it("password steps say I can't see it", async () => {
    const scans = [[frame(0, ["Password"])]];
    scans[0][0].snapshot.elements[0].field = { kind: "password", hasValue: false, valid: true };
    const h = harness([guide(1, "Type your password in this box.", { expect: "type" })], scans);
    await h.c.start("sign in");
    expect(h.c.state.line).toMatch(/can't see it/);
  });
});

describe("prompt", () => {
  it("system prompt is long enough to cache (>512 tokens ~ 2000+ chars)", () => {
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(3000);
  });
  it("wraps page text in page_content and includes options", () => {
    const f = frame(0, ["Go"]);
    const { snapshot } = mergeScans([f], "s");
    const turn = buildTurn("help", [], { steps: ["Click Pharmacy"] }, snapshot);
    expect(turn).toContain("<page_content>");
    expect(turn).toContain("Caregiver's recipe");
    expect(turn).toContain('[1] button: "Go"');
  });
  it("is drive mode: act by default, search first, no menu bias, native paragraph", () => {
    expect(SYSTEM_PROMPT).toContain('"act" is the usual choice');
    expect(SYSTEM_PROMPT).toContain('role "search box"');
    expect(SYSTEM_PROMPT).toContain("don't open category menus to find a specific item");
    expect(SYSTEM_PROMPT).not.toContain("prefer guiding her to scroll or open a menu");
    expect(SYSTEM_PROMPT).toContain("Desktop apps:");
    expect(SYSTEM_PROMPT).toContain('"kind":"guide","say":"Type your password here. I can\'t see it."');
    expect(SYSTEM_PROMPT).toContain('"text":"water bottle"');
  });
  it("marks sensitive fields", () => {
    const f = frame(0, ["Password"]);
    f.snapshot.elements[0].field = { kind: "password", hasValue: false, valid: true, sensitive: true };
    const { snapshot } = mergeScans([f], "s");
    expect(buildTurn("x", [], null, snapshot)).toContain("{password, empty, sensitive}");
  });
  it("names the app and window on native surfaces, and mergeScans keeps them", () => {
    const f = frame(0, ["Display"]);
    f.snapshot.surface = "native";
    f.snapshot.url = "";
    f.snapshot.app = { name: "Settings", window: "System > Display" };
    const { snapshot } = mergeScans([f], "s");
    expect(snapshot.surface).toBe("native");
    const turn = buildTurn("bigger text", [], null, snapshot);
    expect(turn).toContain("App: Settings, window: System > Display");
    expect(turn).not.toContain("Page address");
    expect(buildTurn("x", [], null, mergeScans([frame(0, ["A"])], "t").snapshot)).toContain("Page address: https://x.test/");
  });
});

describe("drive mode", () => {
  const done = step("done", "All done, you did it!");

  it("highlights, says the line, waits a beat, acts, then verifies and plans the next step", async () => {
    const h = harness([act(1, "I'm clicking A."), done], undefined, { actOk: true, timing: { actBeatMs: 20 } });
    const t0 = Date.now();
    await h.c.start("help me");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15);
    expect(h.ops.slice(0, 4)).toEqual(["say:Let me look at the page.", "highlight:Doing this", "say:I'm clicking A.", "act"]);
    expect(h.bridge.act).toHaveBeenCalledWith({ frameId: 0, localId: 1 }, { localId: 1, expect: "click", text: null, option: null });
    expect(h.bridge.waitForChange).toHaveBeenCalledWith(10);
    expect(h.plans[1].history).toEqual(['On "Page": JustAsk did: "I\'m clicking A." (click)']);
    expect(h.c.state.phase).toBe("done");
    expect(h.c.state.actions).toBe(1);
    expect(h.c.state.line).toBe("All done. I did 1 step for you.");
    // No praise after JustAsk's own actions.
    expect(h.spoken.some((t) => /^(Good|Nice work|That's it)/.test(t))).toBe(false);
  });

  it("types her words straight in and waits only briefly after typing", async () => {
    const h = harness([act(1, "I'm typing water bottle in the search box.", { expect: "type", text: "water bottle" }), done], undefined, { actOk: true });
    await h.c.start("find a water bottle");
    expect(h.bridge.act).toHaveBeenCalledWith(expect.anything(), { localId: 1, expect: "type", text: "water bottle", option: null });
    expect(h.bridge.waitForChange).toHaveBeenCalledWith(7);
  });

  it("Stop during the beat cancels the action", async () => {
    const h = harness([act(1)], undefined, { actOk: true, timing: { actBeatMs: 50 } });
    const p = h.c.start("x");
    await tick(10);
    expect(h.c.state.phase).toBe("acting");
    await h.c.stop();
    await p;
    expect(h.bridge.act).not.toHaveBeenCalled();
    expect(h.c.state.phase).toBe("idle");
  });

  it("falls back to guiding her when the action fails", async () => {
    const h = harness([act(1, "I'm clicking A."), done], undefined, { actOk: false });
    await h.c.start("x");
    expect(h.c.state.phase).toBe("guiding");
    expect(h.c.state.line).toBe("Please click the one that says A. It has the glowing box.");
    expect((h.highlights[1] as any).spec.label).toBe("Click here");
    await h.c.onContent({ type: "ja:step-done", how: "click" }, 0);
    expect(h.plans[1].history[0]).toBe('On "Page": JustAsk couldn\'t do that, so she will');
    expect(h.plans[1].history[1]).toMatch(/^On "Page": She did:/);
    expect(h.c.state.clicks).toBe(1);
    expect(h.c.state.actions).toBe(0);
  });

  it("asks before typing words she didn't say; yes types them", async () => {
    const h = harness([act(1, "I'm typing your message.", { expect: "type", text: "Happy birthday Sam" }), done], undefined, { actOk: true });
    await h.c.start("write to Sam");
    expect(h.c.state.phase).toBe("confirming");
    expect(h.c.state.line).toBe("I'll type: Happy birthday Sam. Okay?");
    expect(h.bridge.act).not.toHaveBeenCalled();
    await h.c.input("yes");
    expect(h.bridge.act).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ text: "Happy birthday Sam" }));
  });

  it("no to the typed text guides her instead", async () => {
    const h = harness([act(1, "I'm typing your message.", { expect: "type", text: "Happy birthday Sam" })], undefined, { actOk: true });
    await h.c.start("write to Sam");
    await h.c.input("no");
    expect(h.bridge.act).not.toHaveBeenCalled();
    expect(h.c.state.phase).toBe("guiding");
    expect(h.c.state.line).toBe("Click the glowing box, then type your answer.");
  });

  it("does not advance a guided typing step until a scan reports hasValue", async () => {
    const h = harness([guide(1, "Type your name, then tell me when you're done.", { expect: "type" }), step("done", "All done.")], [[typedFrame(false)]]);
    await h.c.start("fill in the form");
    (h.bridge.scan as any).mockResolvedValue([typedFrame(false)]);
    await h.c.doneTyping();
    expect(h.c.state.phase).toBe("guiding");
    expect(h.c.state.line).toContain("can't see anything");
    expect(h.plans).toHaveLength(1);

    // A content-script typed event follows the same hasValue check.
    await h.c.onContent({ type: "ja:step-done", how: "typed" }, 0);
    expect(h.c.state.phase).toBe("guiding");
    expect(h.plans).toHaveLength(1);

    (h.bridge.scan as any).mockResolvedValue([typedFrame(true)]);
    await h.c.doneTyping();
    expect(h.c.state.phase).toBe("done");
    expect(h.c.state.guidedSteps).toBe(1);
    expect(h.c.state.clicks).toBe(0);
  });

  it("counts guided typing as a step, not a click, in the completion line", async () => {
    const h = harness(
      [guide(1, "Type your name, then tell me when you're done.", { expect: "type" }), act(1), done],
      [[typedFrame(false)]],
      { actOk: true },
    );
    await h.c.start("fill in the form");
    (h.bridge.scan as any).mockResolvedValue([typedFrame(true)]);
    await h.c.doneTyping();
    expect(h.c.state.phase).toBe("done");
    expect(h.c.state.guidedSteps).toBe(1);
    expect(h.c.state.clicks).toBe(0);
    expect(h.c.state.actions).toBe(1);
    expect(h.c.state.line).toBe("All done. I did 1 step for you, and you did 1 step.");
  });

  it("an answer counts as her words", async () => {
    const h = harness([step("clarify", "What should it say?"), act(1, "I'm typing it.", { expect: "type", text: "Happy birthday" }), done], undefined, { actOk: true });
    await h.c.start("write to Sam");
    await h.c.input("happy birthday");
    expect(h.bridge.act).toHaveBeenCalled();
  });

  it("never types personal data, and never says it", async () => {
    const h = harness([act(1, "I'm typing 602 555 0142 in the phone box.", { expect: "type", text: "602 555 0142" })], undefined, { actOk: true });
    await h.c.start("my number is 602 555 0142");
    expect(h.bridge.act).not.toHaveBeenCalled();
    expect(h.c.state.phase).toBe("guiding");
    expect(h.spoken.some((t) => t.includes("555"))).toBe(false);
  });

  it("asks first on a money act, then acts", async () => {
    const h = harness([act(1, "I'm clicking Place order.", { risk: "money" }), done], undefined, { actOk: true });
    await h.c.start("buy it");
    expect(h.c.state.phase).toBe("confirming");
    expect(h.bridge.act).not.toHaveBeenCalled();
    await h.c.input("yes");
    expect(h.bridge.act).toHaveBeenCalled();
  });

  it("Show me instead turns acts into guide steps and tells Claude", async () => {
    const h = harness([act(1, "I'm clicking A.")], undefined, { actOk: true, showMeInstead: true });
    await h.c.start("x");
    expect(h.bridge.act).not.toHaveBeenCalled();
    expect(h.c.state.phase).toBe("guiding");
    expect(h.plans[0].history[0]).toMatch(/Show me instead/);
  });

  it("switches to guide mode after 3 clicks that change nothing", async () => {
    const h = harness([act(1), act(1), act(1), act(1)], undefined, { actOk: true, changed: false });
    await h.c.start("x");
    expect(h.bridge.act).toHaveBeenCalledTimes(3);
    expect(h.c.state.phase).toBe("guiding");
    expect(h.plans[3].history.join("\n")).toMatch(/from now on she does the steps herself/);
    expect(h.events.filter((e) => e === "no_change").length).toBe(3);
  });

  it("typing that changes nothing doesn't count toward guide mode", async () => {
    const t = act(1, "I'm typing it.", { expect: "type", text: "x ray" });
    const h = harness([t, t, t, t, done], undefined, { actOk: true, changed: false });
    await h.c.start("x ray");
    expect(h.bridge.act).toHaveBeenCalledTimes(4);
    expect(h.c.state.line).toBe("All done. I did 4 steps for you.");
  });
});

describe("waiting (P1)", () => {
  const wait = step("wait", "The post box is opening.");
  const A = [frame(0, ["A"])];
  const AB = [frame(0, ["A", "B"])];

  it("watches, and re-plans on page-changed only when the list changed", async () => {
    const h = harness([wait, act(2, "I'm clicking B."), step("done", "All done.")], [A, A, AB], { actOk: true });
    await h.c.start("post");
    expect(h.c.state.phase).toBe("waiting");
    expect(h.bridge.watch).toHaveBeenCalledWith(true);
    await h.c.onContent({ type: "ja:page-changed", reason: "mutation" }, 0);
    expect(h.plans.length).toBe(1);
    expect(h.c.state.phase).toBe("waiting");
    await h.c.onContent({ type: "ja:page-changed", reason: "mutation" }, 0);
    expect(h.plans.length).toBeGreaterThanOrEqual(2);
    expect(h.bridge.watch).toHaveBeenLastCalledWith(false);
    expect(h.bridge.act).toHaveBeenCalled();
  });

  it("stays quiet when the re-plan gives the same wait", async () => {
    const h = harness([wait, wait], [A, AB]);
    await h.c.start("post");
    await h.c.onContent({ type: "ja:page-changed", reason: "mutation" }, 0);
    expect(h.plans.length).toBe(2);
    expect(h.c.state.phase).toBe("waiting");
    expect(h.spoken.filter((t) => t === wait.say).length).toBe(1);
  });

  it("caps the re-plans, then asks Do you see it now? and stops polling", async () => {
    const scans = [1, 2, 3, 4, 5, 6].map((n) => [frame(0, Array.from({ length: n }, (_, i) => `E${i}`))]);
    const h = harness([wait], scans, { timing: { waitMaxReplans: 2 } });
    await h.c.start("post");
    for (let k = 0; k < 4; k++) await h.c.onContent({ type: "ja:page-changed", reason: "mutation" }, 0);
    expect(h.plans.length).toBe(3);
    expect(h.c.state.phase).toBe("waiting");
    expect(h.c.state.line).toBe("Do you see it now?");
    expect(h.bridge.watch).toHaveBeenLastCalledWith(false);
    // "I'm ready" still resumes.
    await h.c.resume("She said she is ready");
    expect(h.plans.length).toBe(4);
  });

  it("re-scans on a timer while waiting", async () => {
    const h = harness([wait, act(2)], [A, AB], { timing: { waitRecheckMs: 5 } });
    await h.c.start("post");
    expect(h.plans.length).toBe(1);
    await tick(60);
    expect(h.plans.length).toBe(2);
    expect(h.c.state.phase).not.toBe("waiting");
  });

  it("Stop clears the recheck timer", async () => {
    const h = harness([wait, act(2)], [A, AB], { timing: { waitRecheckMs: 5 } });
    await h.c.start("post");
    await h.c.stop();
    await tick(40);
    expect(h.plans.length).toBe(1);
    expect(h.bridge.watch).toHaveBeenLastCalledWith(false);
  });
});

describe("open_browser (desktop)", () => {
  const OPENING = "I'm opening your web browser.";
  const GUIDE = "Please open your web browser, like Chrome or Edge. I'll wait.";
  const open = step("open_browser", "Opening Chrome for you now.");
  const done = step("done", "All done.");
  function nativeFrame(app: string, texts: string[]): FrameScan {
    const f = frame(0, texts);
    f.snapshot.surface = "native";
    f.snapshot.url = "";
    f.snapshot.title = app;
    f.snapshot.app = { name: app, window: app };
    return f;
  }
  const notepad = [nativeFrame("Notepad", ["File", "Edit"])];
  const browser = [nativeFrame("Edge", ["Search box"])];

  it("opens the browser with the fixed line, then re-plans", async () => {
    const h = harness([open, done], [notepad, browser], { openBrowser: true });
    await h.c.start("find a recipe for banana bread");
    expect(h.bridge.openBrowser).toHaveBeenCalledTimes(1);
    expect(h.ops).toContain(`say:${OPENING}`);
    expect(h.ops.indexOf(`say:${OPENING}`)).toBeLessThan(h.ops.indexOf("openBrowser"));
    expect(h.spoken).not.toContain(open.say);
    expect(h.bridge.waitForChange).toHaveBeenCalledWith(10);
    expect(h.plans).toHaveLength(2);
    expect(h.plans[1].history).toEqual(['On "Notepad": JustAsk did: opened her web browser at its start page']);
    expect(h.events).toEqual(["step_shown", "done"]);
    expect(h.c.state.phase).toBe("done");
    expect(h.c.state.actions).toBe(1);
  });

  it.each([
    ["the bridge has no openBrowser", {}],
    ["openBrowser resolves false", { openBrowser: false }],
    ["openBrowser throws", { openBrowser: "throw" as const }],
    ["Show me instead is on", { openBrowser: true, showMeInstead: true }],
  ])("asks her to open it and waits when %s", async (_name, opts) => {
    const h = harness([open], [notepad], opts);
    await h.c.start("find a recipe for banana bread");
    expect(h.c.state.phase).toBe("waiting");
    expect(h.c.state.line).toBe(GUIDE);
    expect(h.spoken.at(-1)).toBe(GUIDE);
    expect(h.bridge.watch).toHaveBeenCalledWith(true);
    expect(h.c.state.actions).toBe(0);
    if ("showMeInstead" in opts) expect(h.bridge.openBrowser).not.toHaveBeenCalled();
  });

  it("a second open_browser in the same session asks her instead; a new session acts again", async () => {
    const h = harness([open, open], [notepad, notepad], { openBrowser: true });
    await h.c.start("find a recipe");
    expect(h.bridge.openBrowser).toHaveBeenCalledTimes(1);
    expect(h.c.state.phase).toBe("waiting");
    expect(h.c.state.line).toBe(GUIDE);
    await h.c.stop();
    await h.c.start("find a recipe");
    expect(h.bridge.openBrowser).toHaveBeenCalledTimes(2);
  });

  it("Stop during the beat cancels opening the browser", async () => {
    const h = harness([open], [notepad], { openBrowser: true, timing: { actBeatMs: 50 } });
    const p = h.c.start("x");
    await tick(10);
    expect(h.c.state.phase).toBe("acting");
    expect(h.c.state.line).toBe(OPENING);
    await h.c.stop();
    await p;
    expect(h.bridge.openBrowser).not.toHaveBeenCalled();
    expect(h.c.state.phase).toBe("idle");
  });

  it("the prompt teaches open_browser with no web address", () => {
    expect(SYSTEM_PROMPT).toContain('"open_browser": only when the turn shows "App" and "window"');
    expect(SYSTEM_PROMPT).toContain('{"kind":"open_browser","say":"I\'m opening your web browser.","target":null,"expect":null,"option":null,"text":null,"risk":"none"}');
  });
});

describe("parseCommand", () => {
  it.each([
    ["say that again", "repeat"],
    ["stop", "stop"],
    ["I'm stuck", "stuck"],
    ["yes please", "yes"],
    ["help me refill", "text"],
  ])("%s -> %s", (s, k) => expect(parseCommand(s).kind).toBe(k));

  it.each([
    "help me cancel my subscription",
    "I can't find the pharmacy page",
    "refill it again",
    "the bus stop on Main",
  ])("keeps ordinary text containing command words as text: %s", (s) => {
    expect(parseCommand(s)).toEqual({ kind: "text", text: s });
  });

  it("treats a clarify answer containing stop as an answer", async () => {
    const h = harness([step("clarify", "Which stop?"), guide(1)]);
    await h.c.start("find the bus");
    await h.c.input("the bus stop on Main");
    expect(h.c.state.phase).toBe("guiding");
    expect(h.plans[1].history.at(-1)).toContain("the bus stop on Main");
  });
});
