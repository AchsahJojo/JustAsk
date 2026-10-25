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

const guide = (target: number, say = "Click it.", extra: Partial<StepResponse> = {}): StepResponse => ({ kind: "guide", say, target, expect: "click", option: null, risk: "none", ...extra });

const step = (kind: StepResponse["kind"], say: string): StepResponse => ({ kind, say, target: null, expect: null, option: null, risk: "none" });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

interface HarnessOpts {
  changed?: boolean;
  responseSnapshotId?: string;
  timing?: Record<string, number>;
}

function harness(steps: StepResponse[], scans: FrameScan[][] = [[frame(0, ["A", "B"])]], opts: HarnessOpts = {}) {
  const plans: PlanRequest[] = [];
  let i = 0;
  let s = 0;
  const highlights: unknown[] = [];
  /** Call order across bridge and speech. */
  const ops: string[] = [];
  const bridge: PageBridge = {
    scan: vi.fn(async () => scans[Math.min(s++, scans.length - 1)]),
    highlight: vi.fn(async (ref, spec) => (highlights.push({ ref, spec }), ops.push(`highlight:${spec.label}`), true)),
    clear: vi.fn(async () => {}),
    pulse: vi.fn(async () => {}),
    waitForChange: vi.fn(async () => opts.changed ?? true),
    watch: vi.fn(),
  };
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
    timing: { changeTimeoutMs: 10, quietChangeMs: 7, waitRecheckMs: 60_000, ...opts.timing },
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

describe("mergeScans across frames", () => {
  it("over the cap, ranks all frames together so a child frame's button survives a busy parent", () => {
    const parent = frame(0, Array.from({ length: 200 }, (_, i) => `Link ${i}`));
    parent.snapshot.elements.forEach((e) => {
      e.region = "footer";
      e.inViewport = false;
    });
    const pay = frame(4, ["Pay now"], false);
    pay.snapshot.elements[0].big = true;
    const { snapshot, map } = mergeScans([parent, pay], "s", 150);
    expect(snapshot.elements).toHaveLength(150);
    const n = snapshot.elements.find((e) => e.text === "Pay now")!.n;
    expect(map.get(n)).toEqual({ frameId: 4, localId: 1 });
    expect(n).toBe(150); // still numbered in reading order: top frame first
    expect(snapshot.omitted.count).toBe(51);
  });
  it("under the cap, keeps everything in reading order", () => {
    const { snapshot } = mergeScans([frame(2, ["X"], false), frame(0, ["A", "B"])], "s");
    expect(snapshot.elements.map((e) => e.text)).toEqual(["A", "B", "X"]);
  });
});

describe("SessionController", () => {
  it("runs a multi-step loop to done", async () => {
    const h = harness([guide(1, "Click A."), guide(2, "Click B."), step("done", "All done, you did it!")]);
    await h.c.start("help me");
    expect(h.c.state.phase).toBe("guiding");
    expect(h.c.state.line).toBe("Click A.");
    await h.c.onContent({ type: "ja:step-done", how: "click" }, 0);
    expect(h.c.state.line).toBe("Click B.");
    expect(h.plans[1].history[0]).toBe('On "Page": The user did: "Click A." (click)');
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
    expect(h.c.state.line).toBe("Okay, we won't do that. Nothing was sent.");
    expect(h.events).toContain("abandoned");
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
    const h = harness([{ ...step("blocked", "Click Buy gift cards now."), risk: "suspicious" }]);
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
    const h = harness([step("clarify", "Pickup or mail?"), guide(2)]);
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
    expect(SYSTEM_PROMPT).not.toContain("prefer guiding the user to scroll or open a menu");
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

  it("types the user's words straight in and waits only briefly after typing", async () => {
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

  it("falls back to guiding the user when the action fails", async () => {
    const h = harness([act(1, "I'm clicking A."), done], undefined, { actOk: false });
    await h.c.start("x");
    expect(h.c.state.phase).toBe("guiding");
    expect(h.c.state.line).toBe("Please click the one that says A. It has the glowing box.");
    expect((h.highlights[1] as any).spec.label).toBe("Click here");
    await h.c.onContent({ type: "ja:step-done", how: "click" }, 0);
    expect(h.plans[1].history[0]).toBe('On "Page": JustAsk couldn\'t do that, so the user will');
    expect(h.plans[1].history[1]).toMatch(/^On "Page": The user did:/);
    expect(h.c.state.clicks).toBe(1);
    expect(h.c.state.actions).toBe(0);
  });

  it("asks before typing words the user didn't say; yes types them", async () => {
    const h = harness([act(1, "I'm typing your message.", { expect: "type", text: "Happy birthday Sam" }), done], undefined, { actOk: true });
    await h.c.start("write to Sam");
    expect(h.c.state.phase).toBe("confirming");
    expect(h.c.state.line).toBe("I'll type: Happy birthday Sam. Okay?");
    expect(h.bridge.act).not.toHaveBeenCalled();
    await h.c.input("yes");
    expect(h.bridge.act).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ text: "Happy birthday Sam" }));
  });

  it("no to the typed text guides the user instead", async () => {
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

  it("counts guided typing as a step, not a click, and says the planner's done line", async () => {
    const h = harness(
      [guide(1, "Type your name, then tell me when you're done.", { expect: "type" }), guide(1, "Click Save."), step("done", "All done, you did it!")],
      [[typedFrame(false)]],
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

  it("an answer counts as the user's words", async () => {
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
    await h.c.onContent({ type: "ja:step-done", how: "click" }, 0);
    expect(h.c.state.phase).toBe("done");
    expect(h.c.state.guidedSteps).toBe(2);
    expect(h.c.state.clicks).toBe(1);
    expect(h.c.state.line).toBe("All done, you did it!");
    expect("actions" in h.c.state).toBe(false);
  });
});

describe("guide only (no drive mode)", () => {
  it("the bridge has no act method", () => {
    const h = harness([guide(1)]);
    expect("act" in h.bridge).toBe(false);
  });

  it("a guide step only highlights and speaks; it never changes the page", async () => {
    const h = harness([guide(1, "Type water bottle in the search box.", { expect: "type" })]);
    const act = vi.fn();
    Object.assign(h.bridge, { act });
    await h.c.start("find a water bottle");
    expect(h.c.state.phase).toBe("guiding");
    expect(h.c.state.line).toBe("Type water bottle in the search box.");
    expect(h.ops).toEqual(["say:Let me look at the page.", "highlight:Type here", "say:Type water bottle in the search box."]);
    expect(act).not.toHaveBeenCalled();
    expect(h.bridge.waitForChange).not.toHaveBeenCalled();
  });

  it("an old-style act reply is rejected by checkStep, re-planned once, then blocked", async () => {
    const stale = { kind: "act", say: "I'm clicking A.", target: 1, expect: "click", option: null, risk: "none" } as unknown as StepResponse;
    const h = harness([stale, stale]);
    await h.c.start("x");
    expect(h.plans).toHaveLength(2);
    expect(h.c.state.phase).toBe("blocked");
    expect(h.highlights).toHaveLength(0);
    expect(h.spoken).not.toContain("I'm clicking A.");
  });

  it("a session saved mid-action by an older version re-plans as a guide step", async () => {
    const h = harness([guide(1, "Click A.")]);
    const old = { ...h.c.state, request: "help me", stepNo: 2, phase: "acting" } as unknown as typeof h.c.state;
    h.c.restore(old, [], null);
    await vi.waitFor(() => expect(h.c.state.phase).toBe("guiding"));
    expect(h.c.state.line).toBe("Click A.");
  });

  it("does not add a Show me instead note to the history", async () => {
    const h = harness([guide(1), step("done", "All done.")]);
    await h.c.start("x");
    await h.c.onContent({ type: "ja:step-done", how: "click" }, 0);
    expect(h.plans[0].history).toEqual([]);
  });

  it("asks first on a money step; yes highlights it for her", async () => {
    const h = harness([guide(1, "Click Place order.", { risk: "money" })]);
    await h.c.start("buy it");
    expect(h.c.state.phase).toBe("confirming");
    expect(h.c.state.line).toBe("This step will spend money. Do you want to go ahead?");
    await h.c.input("yes");
    expect(h.c.state.phase).toBe("guiding");
    expect(h.c.state.line).toBe("Click Place order.");
    expect(h.highlights).toHaveLength(1);
  });

  it("clicks that change nothing never switch modes; it keeps guiding", async () => {
    const h = harness([guide(1), guide(1), guide(1), guide(1)], undefined, { changed: false });
    await h.c.start("x");
    for (let k = 0; k < 3; k++) await h.c.onContent({ type: "ja:step-done", how: "click" }, 0);
    expect(h.c.state.phase).toBe("guiding");
    expect(h.plans[0].history[0]).toMatch(/Show me instead/);
  });

  it("switches to guide mode after 3 clicks that change nothing", async () => {
    const h = harness([act(1), act(1), act(1), act(1)], undefined, { actOk: true, changed: false });
    await h.c.start("x");
    expect(h.bridge.act).toHaveBeenCalledTimes(3);
    expect(h.c.state.phase).toBe("guiding");
    expect(h.plans[3].history.join("\n")).toMatch(/from now on the user does the steps themselves/);
    expect(h.events.filter((e) => e === "no_change").length).toBe(3);
    expect(h.plans[3].history.join("\n")).not.toMatch(/from now on/);
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
  it("is guide only: guide by default, she does it herself, search first, no menu bias", () => {
    expect(SYSTEM_PROMPT).toContain('"guide" is the usual choice');
    expect(SYSTEM_PROMPT).toContain("she does it herself");
    expect(SYSTEM_PROMPT).not.toContain('"act"');
    expect(SYSTEM_PROMPT).not.toContain('"text":');
    expect(SYSTEM_PROMPT).not.toMatch(/I'm (clicking|typing|picking|searching|opening)/);
    expect(SYSTEM_PROMPT).toContain('role "search box"');
    expect(SYSTEM_PROMPT).toContain("don't open category menus to find a specific item");
    expect(SYSTEM_PROMPT).not.toContain("prefer guiding her to scroll or open a menu");
    expect(SYSTEM_PROMPT).toContain('"kind":"guide","say":"Type your password here. I can\'t see it."');
    expect(SYSTEM_PROMPT).toContain('{"kind":"guide","say":"Type water bottle in the search box.","target":2,"expect":"type","option":null,"risk":"none"}');
    expect(SYSTEM_PROMPT).toContain('"say":"Press Enter to search.","target":2,"expect":"submit"');
    expect(SYSTEM_PROMPT).toContain("Pick Arizona in the State box.");
  });
  it("marks sensitive fields", () => {
    const f = frame(0, ["Password"]);
    f.snapshot.elements[0].field = { kind: "password", hasValue: false, valid: true, sensitive: true };
    const { snapshot } = mergeScans([f], "s");
    expect(buildTurn("x", [], null, snapshot)).toContain("{password, empty, sensitive}");
  });
  it("shows the page address", () => {
    expect(buildTurn("x", [], null, mergeScans([frame(0, ["A"])], "t").snapshot)).toContain("Page address: https://x.test/");
  });
});

describe("waiting (P1)", () => {
  const wait = step("wait", "The post box is opening.");
  const A = [frame(0, ["A"])];
  const AB = [frame(0, ["A", "B"])];

  it("watches, and re-plans on page-changed only when the list changed", async () => {
    const h = harness([wait, guide(2, "Click B."), step("done", "All done.")], [A, A, AB]);
    await h.c.start("post");
    expect(h.c.state.phase).toBe("waiting");
    expect(h.bridge.watch).toHaveBeenCalledWith(true);
    await h.c.onContent({ type: "ja:page-changed", reason: "mutation" }, 0);
    expect(h.plans.length).toBe(1);
    expect(h.c.state.phase).toBe("waiting");
    await h.c.onContent({ type: "ja:page-changed", reason: "mutation" }, 0);
    expect(h.plans.length).toBeGreaterThanOrEqual(2);
    expect(h.bridge.watch).toHaveBeenLastCalledWith(false);
    expect(h.c.state.phase).toBe("guiding");
    expect(h.c.state.line).toBe("Click B.");
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
    await h.c.resume("The user said they are ready");
    expect(h.plans.length).toBe(4);
  });

  it("re-scans on a timer while waiting", async () => {
    const h = harness([wait, guide(2)], [A, AB], { timing: { waitRecheckMs: 5 } });
    await h.c.start("post");
    expect(h.plans.length).toBe(1);
    await tick(60);
    expect(h.plans.length).toBe(2);
    expect(h.c.state.phase).toBe("guiding");
  });

  it("Stop clears the recheck timer", async () => {
    const h = harness([wait, guide(2)], [A, AB], { timing: { waitRecheckMs: 5 } });
    await h.c.start("post");
    await h.c.stop();
    await tick(40);
    expect(h.plans.length).toBe(1);
    expect(h.bridge.watch).toHaveBeenLastCalledWith(false);
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

describe("start on an empty tab", () => {
  it("runs prepare first, announces its line, and gives Claude its note", async () => {
    const h = harness([guide(1)]);
    const prepare = vi.fn(async (announce: (l: string) => void) => {
      announce("This tab is empty, so I'll look that up for you.");
      return 'The tab was empty, so JustAsk searched the web for "refill"';
    });
    await h.c.start("help me refill", { prepare });
    expect(prepare).toHaveBeenCalledOnce();
    expect(h.spoken[0]).toMatch(/look that up/);
    expect(h.plans[0].history).toContain('The tab was empty, so JustAsk searched the web for "refill"');
    expect(h.c.state.phase).toBe("guiding");
  });

  it("Stop during prepare wins: nothing is planned", async () => {
    const h = harness([guide(1)]);
    let release!: () => void;
    const p = h.c.start("x", { prepare: () => new Promise<string | null>((r) => (release = () => r(null))) });
    await new Promise((r) => setTimeout(r, 5));
    await h.c.stop();
    release();
    await p;
    expect(h.plans.length).toBe(0);
    expect(h.c.state.phase).toBe("idle");
  });

  it("a failed scan on an empty tab pauses with Look it up, not a dead end", async () => {
    const plans: unknown[] = [];
    const c = new SessionController({
      bridge: { scan: vi.fn(async () => []), highlight: vi.fn(), clear: vi.fn(async () => {}), pulse: vi.fn(), waitForChange: vi.fn(), act: vi.fn(), watch: vi.fn() } as unknown as PageBridge,
      planner: { plan: vi.fn(async (r) => (plans.push(r), { ok: true as const, snapshotId: "x", step: guide(1), latencyMs: 1 })) },
      speech: { speak: () => {}, stop: () => {} },
      blankTab: async () => true,
    });
    await c.start("weather");
    expect(c.state.phase).toBe("paused");
    expect(c.state.pauseReason).toBe("blank-tab");
    expect(c.state.line).toMatch(/Look it up/);
    expect(plans.length).toBe(0);
  });
});

describe("clear risk questions", () => {
  it("says exactly what would be pressed and on which site", async () => {
    const f = frame(0, ["Place order"]);
    f.snapshot.url = "https://www.pharmacy.example/checkout";
    const h = harness([guide(1, "Click Place order.", { risk: "money" })], [[f]]);
    await h.c.start("buy");
    expect(h.c.state.phase).toBe("confirming");
    expect(h.c.state.note).toBe("Next, I'd show you “Place order” on pharmacy.example.");
    expect(h.spoken.at(-1)).toMatch(/^Next, I'd show you “Place order” on pharmacy\.example\. This step will spend money/);
  });
});

describe("scam check on the user's request", () => {
  it("asks before doing anything; someone asked -> stops with what to do, nothing planned", async () => {
    const h = harness([guide(1)]);
    const prepare = vi.fn(async () => null);
    await h.c.start("email the gift card codes to the man from the IRS", { prepare });
    expect(h.c.state.phase).toBe("confirming");
    expect(h.c.state.scam).toBe("gift-card");
    expect(h.c.state.line).toBe("Did someone call, text or email asking you to do this?");
    expect(h.c.state.note).toMatch(/never ask to be paid with gift card numbers/);
    expect(h.spoken.at(-1)).toMatch(/gift card numbers\. Did someone call, text or email/);
    expect(prepare).not.toHaveBeenCalled();
    expect(h.plans.length).toBe(0);
    await h.c.confirm(true); // voice "yes" = someone asked
    expect(h.c.state.phase).toBe("blocked");
    expect(h.c.state.line).toMatch(/looks like a scam/);
    expect(h.c.state.note).toMatch(/call your bank/);
    expect(h.plans.length).toBe(0);
    expect(h.events).toEqual(["scam_check", "scam_stopped"]);
  });

  it("their own idea -> carries on carefully, and Claude is told", async () => {
    const h = harness([guide(1)]);
    const prepare = vi.fn(async () => null);
    await h.c.start("wire $3,000 to my grandson, he's in jail", { prepare });
    await h.c.scamAnswer(false);
    expect(prepare).toHaveBeenCalledOnce();
    expect(h.c.state.phase).toBe("guiding");
    expect(h.plans[0].history.join("\n")).toMatch(/their own idea/);
  });

  it("an ordinary request is not asked", async () => {
    const h = harness([guide(1)]);
    await h.c.start("buy a gift card for my grandson's birthday");
    expect(h.c.state.scam).toBeNull();
    expect(h.c.state.phase).toBe("guiding");
  });
});

describe("empty tab: ask before searching", () => {
  function blankHarness() {
    const h = harness([guide(1)]);
    const searchWeb = vi.fn(async () => 'The tab was empty, so JustAsk searched the web for "weather"');
    (h.c as any).deps.blankTab = async () => true;
    (h.c as any).deps.searchWeb = searchWeb;
    return { ...h, searchWeb };
  }

  it("asks first; yes searches the user's words, then guides from the results", async () => {
    const h = blankHarness();
    await h.c.start("what's the weather");
    expect(h.c.state.phase).toBe("confirming");
    expect(h.c.state.offer).toBe("search");
    expect(h.spoken.at(-1)).toMatch(/search the web/);
    expect(h.searchWeb).not.toHaveBeenCalled();
    expect(h.plans).toHaveLength(0);
    await h.c.confirm(true); // voice "yes"
    expect(h.searchWeb).toHaveBeenCalledWith("what's the weather", expect.any(Function));
    expect(h.plans[0].history).toContain('The tab was empty, so JustAsk searched the web for "weather"');
    expect(h.c.state.phase).toBe("guiding");
  });

  it("no: waits for the user to open the website, without searching or planning", async () => {
    const h = blankHarness();
    await h.c.start("what's the weather");
    await h.c.searchAnswer(false);
    expect(h.searchWeb).not.toHaveBeenCalled();
    expect(h.plans).toHaveLength(0);
    expect(h.c.state.phase).toBe("paused");
    expect(h.c.state.pauseReason).toBe("blank-tab");
    expect(h.c.state.line).toMatch(/Go to the website you want/);
  });

  it("a caregiver's start page skips the question", async () => {
    const h = blankHarness();
    await h.c.start("refill", { recipe: { startUrl: "https://pharmacy.example/", steps: [] } });
    expect(h.c.state.offer).toBeNull();
    expect(h.c.state.phase).toBe("guiding");
  });
});
