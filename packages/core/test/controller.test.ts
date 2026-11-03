import { describe, expect, it, vi } from "vitest";
import { SessionController, type PageBridge, type Planner } from "../src/controller";
import { mergeScans } from "../src/merge";
import { buildTurn, SYSTEM_PROMPT } from "../src/prompt";
import { isDecline, parseCommand } from "../src/commands";
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
  /** Drive-mode tests opt in; false is the shipped guide-only build. */
  allowDrive?: boolean;
  responseSnapshotId?: string;
  timing?: Record<string, number>;
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
    allowDrive: opts.allowDrive ?? true,
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
    const h = harness([guide(1, "Click A."), guide(2, "Click B."), { kind: "done", say: "All done, you did it!", target: null, expect: null, option: null, text: null, risk: "none" }]);
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

  it("asks before money steps; No asks what next, without highlighting", async () => {
    const h = harness([guide(1, "Click Place order.", { risk: "money" })]);
    await h.c.start("buy");
    expect(h.c.state.phase).toBe("confirming");
    expect(h.highlights.length).toBe(0);
    await h.c.input("no");
    expect(h.c.state).toMatchObject({ phase: "confirming", offer: "declined", line: "Okay, I won't show that. Do you want to do something else here, or stop?" });
    expect(h.highlights.length).toBe(0);
    expect(h.events).not.toContain("abandoned");
  });

  it("Stop after a risk No keeps today's line and the abandoned event", async () => {
    const h = harness([guide(1, "Click Place order.", { risk: "money" })]);
    await h.c.start("buy");
    await h.c.confirm(false);
    await h.c.declineAnswer(false);
    expect(h.c.state).toMatchObject({ phase: "done", line: "Okay, we won't do that. Nothing was sent.", offer: null });
    expect(h.events.filter((e) => e === "abandoned")).toHaveLength(1);
    expect(h.plans).toHaveLength(1);
  });

  it("voice stop, the Stop button and no all end at the follow-up question", async () => {
    for (const end of [(c: SessionController) => c.input("stop"), (c: SessionController) => c.stop(), (c: SessionController) => c.input("no")]) {
      const h = harness([guide(1, "Click Place order.", { risk: "money" })]);
      await h.c.start("buy");
      await h.c.input("no");
      await end(h.c);
      expect(h.c.state).toMatchObject({ phase: "done", line: "Okay, we won't do that. Nothing was sent." });
      expect(h.events.filter((e) => e === "abandoned")).toHaveLength(1);
    }
  });

  it("Something else asks what instead, then re-plans with the decline in history", async () => {
    const h = harness([guide(1, "Click Place order.", { risk: "money" }), guide(2, "Click B.")], [[frame(0, ["Place order", "B"])]]);
    await h.c.start("buy");
    await h.c.confirm(false);
    await h.c.input("something else");
    expect(h.c.state).toMatchObject({ phase: "asking", line: "Okay. What would you like to do instead?", offer: null });
    await h.c.input("the cheaper shipping");
    expect(h.plans).toHaveLength(2);
    expect(h.plans[1].history.join("\n")).toContain('The user chose not to do that step: "Place order"');
    expect(h.plans[1].history.at(-1)).toContain("the cheaper shipping");
    expect(h.c.state.phase).toBe("guiding");
    expect((h.highlights[0] as any).ref).toEqual({ frameId: 0, localId: 2 });
  });

  it("words at the follow-up question are the something else", async () => {
    const h = harness([guide(1, "Click Place order.", { risk: "money" }), guide(2, "Click B.")], [[frame(0, ["Place order", "B"])]]);
    await h.c.start("buy");
    await h.c.confirm(false);
    await h.c.input("I want to check the total first");
    expect(h.plans).toHaveLength(2);
    expect(h.plans[1].history.at(-1)).toContain("check the total first");
  });

  it("a declined button is never shown again, even when Claude returns it twice", async () => {
    const order = guide(1, "Click Place order.", { risk: "money" });
    const h = harness([order, order, order], [[frame(0, ["Place order", "B"])]]);
    await h.c.start("buy");
    await h.c.confirm(false);
    await h.c.declineAnswer(true);
    await h.c.answer("a different address");
    expect(h.plans).toHaveLength(3);
    expect(h.plans[2].retryNote).toContain("chose not to do that step");
    expect(h.c.state.phase).toBe("blocked");
    expect(h.highlights).toHaveLength(0);
    expect(h.spoken.filter((s) => s.includes("This step will spend money"))).toHaveLength(1);
  });

  it("the next risk step after Something else still asks first", async () => {
    const h = harness([guide(1, "Click Place order.", { risk: "money" }), guide(2, "Click Pay now.", { risk: "money" })], [[frame(0, ["Place order", "Pay now"])]]);
    await h.c.start("buy");
    await h.c.confirm(false);
    await h.c.input("the cheaper one");
    expect(h.c.state).toMatchObject({ phase: "confirming", offer: null, risk: "money" });
    expect(h.highlights).toHaveLength(0);
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

  it("an answer carries the question it answers", async () => {
    const h = harness([guide(1, "Type the meeting code in the white box.", { expect: "type" }), step("done", "Okay.")]);
    await h.c.start("join my meeting");
    await h.c.input("I don't have one");
    expect(h.plans[1].history.slice(-2)).toEqual(['JustAsk said: "Type the meeting code in the white box."', 'The user answered: "I don\'t have one"']);
  });

  it("stops offering the same step after it comes back three times on an unchanged page", async () => {
    const ask = guide(1, "Type the meeting code.", { expect: "type" });
    const h = harness([ask, ask, ask, ask]);
    await h.c.start("join my meeting");
    await h.c.input("which box?");
    expect(h.c.state.phase).toBe("guiding");
    await h.c.input("hmm");
    expect(h.c.state.phase).toBe("blocked");
    expect(h.c.state.line).toMatch(/stop here for now/);
    expect(h.highlights).toHaveLength(2);
  });

  it("declining a code box never highlights that box again", async () => {
    const ask = guide(1, "Type the meeting code.", { expect: "type" });
    const h = harness([ask, ask], [[typedFrame(false)]]);
    await h.c.start("join my meeting");
    await h.c.input("my daughter hasn't sent it yet");
    expect(h.highlights).toHaveLength(1);
    expect(h.c.state.phase).toBe("blocked");
    expect(h.c.state.line).toMatch(/stop here for now/);
  });

  it("a declined box stays declined across a follow-up after done", async () => {
    const ask = guide(1, "Type the meeting code.", { expect: "type" });
    const h = harness([ask, step("done", "Come back when you have it."), ask], [[typedFrame(false)]]);
    await h.c.start("join my meeting");
    await h.c.input("I don't have a code");
    expect(h.c.state.phase).toBe("done");
    await h.c.input("what now");
    expect(h.highlights).toHaveLength(1);
    expect(h.c.state.phase).toBe("blocked");
  });

  it("a declined box comes back once the user says they have it", async () => {
    const ask = guide(1, "Type the meeting code.", { expect: "type" });
    const h = harness([ask, step("clarify", "Do you have it now?"), ask], [[typedFrame(false)]]);
    await h.c.start("join my meeting");
    await h.c.input("I don't have a code");
    expect(h.c.state.phase).toBe("asking");
    await h.c.input("yes it just came");
    expect(h.highlights).toHaveLength(2);
    expect(h.c.state.phase).toBe("guiding");
  });

  it("the same question asked twice ends the loop", async () => {
    const q = step("clarify", "Start a call or join one?");
    const h = harness([q, step("clarify", "Start a call, or join one?"), q]);
    await h.c.start("google meet");
    await h.c.input("I don't know");
    expect(h.c.state.phase).toBe("blocked");
    expect(h.events).toEqual(["clarify", "loop"]);
  });

  it("three different questions in a row don't trip the loop; a fourth does", async () => {
    const h = harness([step("clarify", "Which book?"), step("clarify", "Paperback or ebook?"), step("clarify", "Which store?"), step("clarify", "New or used?")]);
    await h.c.start("get the new book");
    await h.c.input("the new one by Ann Patchett");
    await h.c.input("paperback");
    expect(h.c.state.phase).toBe("asking");
    expect(h.c.state.line).toBe("Which store?");
    await h.c.input("the closest one");
    expect(h.c.state.phase).toBe("blocked");
  });

  it("the loop limits can be tuned through timing", async () => {
    const q = step("clarify", "Start a call or join one?");
    const h = harness([q, q, q], undefined, { timing: { sameQuestionLimit: 3 } });
    await h.c.start("google meet");
    await h.c.input("I don't know");
    expect(h.c.state.phase).toBe("asking");
    await h.c.input("hmm");
    expect(h.c.state.phase).toBe("blocked");
  });

  it("a loop after a decline says we can stop for now, and doesn't log stuck", async () => {
    const q = step("clarify", "Start a call or join one?");
    const h = harness([q, q]);
    await h.c.start("google meet");
    await h.c.input("not yet");
    expect(h.c.state.line).toMatch(/stop here for now/);
    expect(h.events).not.toContain("stuck");
  });

  it("a loop after the user says it isn't working asks for the helper and logs stuck", async () => {
    const g = guide(1, "Click Join.");
    const h = harness([g, g, g]);
    await h.c.start("join my call");
    await h.c.input("which one?");
    await h.c.input("I can't find the button");
    expect(h.c.state.phase).toBe("blocked");
    expect(h.c.state.line).toBe("This isn't working. Let's stop and ask your helper.");
    expect(h.events.slice(-2)).toEqual(["stuck", "loop"]);
  });

  it("a loop after an I'm stuck press asks for the helper without logging stuck twice", async () => {
    const g = guide(1, "Click Join.");
    const h = harness([g, g, g]);
    await h.c.start("join my call");
    await h.c.input("which one?");
    await h.c.stuck();
    expect(h.c.state.line).toMatch(/ask your helper/);
    expect(h.events.filter((e) => e === "stuck")).toHaveLength(1);
    expect(h.events.at(-1)).toBe("loop");
  });

  it("I'm stuck after done asks what's not working, without calling Claude", async () => {
    const h = harness([step("done", "Google Meet is open."), guide(1, "Click New meeting.")]);
    await h.c.start("open google meet");
    await h.c.stuck();
    expect(h.plans).toHaveLength(1);
    expect(h.c.state.phase).toBe("asking");
    expect(h.c.state.line).toBe("What's not working? Tell me what you see, or what you wanted to do.");
    await h.c.input("I want to start a call");
    expect(h.plans).toHaveLength(2);
    expect(h.plans[1].request).toBe("open google meet");
    expect(h.plans[1].history).toEqual([
      'JustAsk said: "Google Meet is open."',
      "The user pressed I'm stuck after that, so it isn't finished for them",
      'JustAsk said: "What\'s not working? Tell me what you see, or what you wanted to do."',
      'The user answered: "I want to start a call"',
    ]);
    expect(h.c.state.phase).toBe("guiding");
  });

  it("I'm stuck or Say that again typed after done is the command, not a new request", async () => {
    const h = harness([step("done", "Google Meet is open.")]);
    await h.c.start("open google meet");
    expect(h.c.doneCommand("check my email")).toBe(false);
    expect(h.c.doneCommand("say that again")).toBe(true);
    expect(h.spoken.at(-1)).toBe("Google Meet is open.");
    expect(h.c.doneCommand("I'm stuck")).toBe(true);
    await tick();
    expect(h.c.state.phase).toBe("asking");
    expect(h.c.state.request).toBe("open google meet");
    expect(h.plans).toHaveLength(1);
    expect(h.c.doneCommand("I'm stuck")).toBe(false);
  });

  it("a second I'm stuck on the same box says where it is instead of re-planning", async () => {
    const scans = [[frame(0, ["Join", "Help"])]];
    Object.assign(scans[0][0].snapshot.elements[0], { region: "header", nearby: "Your meetings", inViewport: false });
    const g = guide(1, "Click Join.");
    const h = harness([g, g, g], scans);
    await h.c.start("join my call");
    await h.c.stuck();
    expect(h.plans).toHaveLength(2);
    await h.c.stuck();
    expect(h.plans).toHaveLength(2);
    expect(h.bridge.pulse).toHaveBeenCalled();
    expect(h.spoken.at(-1)).toBe("I moved the page to it. Look at the top of the page, near “Your meetings”. It has the glowing box around it. Click Join.");
    expect(h.c.state.phase).toBe("guiding");
    expect(h.events.filter((e) => e === "stuck")).toHaveLength(2);
  });

  it("a step the user finished doesn't count toward the loop", async () => {
    const h = harness([guide(1), guide(1), guide(1), step("done", "Done.")]);
    await h.c.start("x");
    await h.c.onContent({ type: "ja:step-done", how: "click" }, 0);
    await h.c.onContent({ type: "ja:step-done", how: "click" }, 0);
    expect(h.c.state.phase).toBe("guiding");
    await h.c.onContent({ type: "ja:step-done", how: "click" }, 0);
    expect(h.c.state.phase).toBe("done");
  });

  it("words after a finished task keep what came before", async () => {
    const h = harness([step("done", "Meet is open."), step("done", "Okay.")]);
    await h.c.start("go to google meet");
    await h.c.start("I don't have a code");
    expect(h.plans[1].request).toBe("I don't have a code");
    expect(h.plans[1].history.join("\n")).toContain('the user asked "go to google meet" and JustAsk finished with: "Meet is open."');
  });

  it("a chain of follow-ups keeps the first request", async () => {
    const h = harness([step("done", "Meet is open."), step("done", "Okay, later."), step("done", "Okay.")]);
    await h.c.start("go to google meet");
    await h.c.start("I don't have a code");
    await h.c.start("not yet");
    expect(h.plans[2].history.join("\n")).toContain('the user asked "go to google meet" and JustAsk finished with: "Okay, later."');
  });

  it("a line a few words too long is trimmed, not re-planned", async () => {
    const long = "Click the A button at the top of the page, just under your name and photo. It is the first one there.";
    const h = harness([guide(1, long), guide(1, "Click A.")]);
    await h.c.start("x");
    expect(h.plans).toHaveLength(1);
    expect(h.c.state.phase).toBe("guiding");
    expect(h.c.state.line).toBe("Click the A button at the top of the page, just under your name and photo.");
  });

  it("Ask for something else clears the chain", async () => {
    const h = harness([step("done", "Meet is open."), step("done", "Okay.")]);
    await h.c.start("go to google meet");
    await h.c.stop();
    await h.c.start("check my email");
    expect(h.plans[1].history.join("\n")).not.toContain("Before this");
  });

  it("words long after a finished task start fresh", async () => {
    const h = harness([step("done", "Meet is open."), step("done", "Okay.")], undefined, { timing: { followUpMs: 1_000 } });
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    await h.c.start("go to google meet");
    now.mockReturnValue(1_002_000);
    await h.c.start("check my email");
    now.mockRestore();
    expect(h.plans[1].history.join("\n")).not.toContain("Before this");
  });

  it("a caregiver task after a finished task isn't framed as a follow-up", async () => {
    const h = harness([step("done", "Meet is open."), step("done", "Okay.")]);
    await h.c.start("go to google meet");
    await h.c.start("Refill your prescription", { taskId: "task-1" });
    expect(h.plans[1].history.join("\n")).not.toContain("Before this");
  });

  it("Ask for something else after a block doesn't log abandoned on top of blocked", async () => {
    const q = step("clarify", "Start a call or join one?");
    const h = harness([q, q, q, q]);
    await h.c.start("google meet");
    await h.c.input("I don't know");
    expect(h.c.state.phase).toBe("blocked");
    await h.c.stop();
    expect(h.events).toContain("loop");
    expect(h.events).not.toContain("abandoned");
  });

  it("thank you after a task is answered, not planned", async () => {
    const h = harness([step("done", "Meet is open.")]);
    await h.c.start("go to google meet");
    expect(h.c.farewell("thank you")).toBe(true);
    expect(h.plans).toHaveLength(1);
    expect(h.c.state.line).toMatch(/welcome/);
    expect(h.c.farewell("check my email")).toBe(false);
  });

  it("free text while guiding replans with the user's words instead of repeating", async () => {
    const h = harness([guide(1), guide(2)]);
    await h.c.start("refill");
    expect(h.c.state.phase).toBe("guiding");
    await h.c.input("I can't find it, it's on the left");
    expect(h.plans.length).toBe(2);
    expect(h.plans[1].history.at(-1)).toContain("it's on the left");
    expect(h.bridge.clear).toHaveBeenCalled();
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
  it("is guide only: guide by default, never act, search first, no menu bias, no desktop paragraph", () => {
    expect(SYSTEM_PROMPT).toContain('"guide" is the usual choice');
    expect(SYSTEM_PROMPT).toContain('Never use "act"');
    expect(SYSTEM_PROMPT.slice(SYSTEM_PROMPT.indexOf("Worked examples"))).not.toContain('"kind":"act"');
    expect(SYSTEM_PROMPT).toContain('role "search box"');
    expect(SYSTEM_PROMPT).toContain("don't open category menus to find a specific item");
    expect(SYSTEM_PROMPT).not.toContain("prefer guiding the user to scroll or open a menu");
    expect(SYSTEM_PROMPT).not.toContain("Desktop apps:");
    expect(SYSTEM_PROMPT).toContain('"kind":"guide","say":"Type your password here. I can\'t see it."');
    expect(SYSTEM_PROMPT).not.toContain('"text":"water bottle"');
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

describe("guide only (the shipped build)", () => {
  it("never acts without allowDrive, even with Show me instead off", async () => {
    const h = harness([act(1, "I'm clicking A."), step("done", "All done, you did it!")], undefined, { actOk: true, allowDrive: false, showMeInstead: false });
    await h.c.start("help me");
    expect(h.bridge.act).not.toHaveBeenCalled();
    expect(h.c.state.phase).toBe("guiding");
  });

  it.each([false, true])("puts no Show me instead note in history (showMeInstead %s)", async (showMeInstead) => {
    const h = harness([guide(1), step("done", "Done.")], undefined, { allowDrive: false, showMeInstead });
    await h.c.start("help me");
    await h.c.onContent({ type: "ja:step-done", how: "click" }, 0);
    for (const p of h.plans) expect(p.history.join("\n")).not.toMatch(/Show me instead/);
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
    expect(h.plans[3].history.join("\n")).toMatch(/from now on the user does the steps themselves/);
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
    await h.c.resume("The user said they are ready");
    expect(h.plans.length).toBe(4);
  });

  it("\"not yet\" / \"later\" while waiting ends kindly without asking Claude again", async () => {
    for (const words of ["not yet", "later", "no", "I'll do it later"]) {
      const h = harness([step("wait", "Wait for the code from your daughter.")]);
      await h.c.start("help me join a meeting");
      expect(h.c.state.phase).toBe("waiting");
      await h.c.input(words);
      expect(h.plans.length).toBe(1);
      expect(h.c.state.phase).toBe("done");
      expect(h.c.state.line).toBe("Okay. Press the big button when you're ready.");
      expect(h.events).toContain("abandoned");
      expect(h.events).not.toContain("done");
      expect(h.bridge.watch).toHaveBeenLastCalledWith(false);
    }
  });

  it("the Not now button ends the wait the same way", async () => {
    const h = harness([wait]);
    await h.c.start("post");
    await h.c.notNow();
    expect(h.plans.length).toBe(1);
    expect(h.c.state.phase).toBe("done");
  });

  it("an off-screen wait stops polling quietly, without Do you see it now?", async () => {
    const h = harness([step("wait", "Wait for the text with the code.")], [A], { timing: { waitWindowMs: 0 } });
    await h.c.start("join my zoom call");
    await h.c.onContent({ type: "ja:page-changed", reason: "mutation" }, 0);
    expect(h.c.state.phase).toBe("waiting");
    expect(h.c.state.line).toBe("Wait for the text with the code.");
    expect(h.spoken).not.toContain("Do you see it now?");
    expect(h.bridge.watch).toHaveBeenLastCalledWith(false);
  });

  it("a wait on a page that says loading still asks Do you see it now?", async () => {
    const loading = [frame(0, ["A"])];
    loading[0].snapshot.pageText = "Loading your messages…";
    const h = harness([wait], [loading], { timing: { waitWindowMs: 0 } });
    await h.c.start("post");
    await h.c.onContent({ type: "ja:page-changed", reason: "mutation" }, 0);
    expect(h.c.state.line).toBe("Do you see it now?");
  });

  it("stress meet-not-now and zoom-later never end in waiting, even if Claude keeps answering wait", async () => {
    const meet = harness([step("wait", "Wait for your daughter to send the code.")]);
    await meet.c.start("help me join a meeting on google meet");
    await meet.c.input("my daughter hasn't sent it yet");
    await meet.c.input("no");
    expect(meet.c.state.phase).toBe("done");
    // "I'll do it later" after that is not a new task.
    await meet.c.input("I'll do it later");
    expect(meet.c.state.phase).toBe("done");
    expect(meet.plans.length).toBe(2);

    const zoom = harness([step("wait", "Wait until you have the meeting ID.")]);
    await zoom.c.start("join my zoom call");
    await zoom.c.input("I don't know the meeting ID");
    await zoom.c.input("I don't know");
    // The third identical wait on an unchanged page ends in the loop guard, not another wait.
    expect(zoom.c.state.phase).toBe("blocked");
    expect(zoom.c.state.line).toMatch(/stop here for now/);
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

describe("parseCommand", () => {
  it.each([
    ["say that again", "repeat"],
    ["stop", "stop"],
    ["I'm stuck", "stuck"],
    ["yes please", "yes"],
    ["Yes.", "yes"],
    ["not yet", "no"],
    ["I'll do it later", "no"],
    ["Thank you!", "thanks"],
    ["that's all", "thanks"],
    ["Something else.", "something-else"],
    ["another way", "something-else"],
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

  it.each(["no", "not yet", "I don't have a code", "my daughter hasn't sent it yet", "I forgot my password", "I don't know the meeting ID", "I'll do it later", "never mind the ID"])(
    "counts %s as a decline",
    (s) => expect(isDecline(s)).toBe(true),
  );

  it.each(["yes it just came", "it's 123 456", "where is the box?", "I have it now"])("does not count %s as a decline", (s) => expect(isDecline(s)).toBe(false));

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
    await h.c.start("email the gift card codes to the agent from the IRS", { prepare });
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
    await h.c.start("wire $3,000 to my grandkid, they're in jail", { prepare });
    await h.c.scamAnswer(false);
    expect(prepare).toHaveBeenCalledOnce();
    expect(h.c.state.phase).toBe("guiding");
    expect(h.plans[0].history.join("\n")).toMatch(/their own idea/);
  });

  it("an ordinary request is not asked", async () => {
    const h = harness([guide(1)]);
    await h.c.start("buy a gift card for my grandkid's birthday");
    expect(h.c.state.scam).toBeNull();
    expect(h.c.state.phase).toBe("guiding");
  });
});

describe("scam check on later words", () => {
  const SCAMMY = "they said to pay with gift cards and read them the codes";

  it("a clarify answer gets the question before Claude sees it; someone asked -> stops", async () => {
    const h = harness([step("clarify", "How do you want to pay?"), guide(1)]);
    await h.c.start("pay my bill");
    await h.c.input(SCAMMY);
    expect(h.c.state.phase).toBe("confirming");
    expect(h.c.state.scam).toBe("gift-card");
    expect(h.plans).toHaveLength(1);
    await h.c.input("yes");
    expect(h.c.state.phase).toBe("blocked");
    expect(h.c.state.line).toBe("This looks like a scam. Please don't send anything.");
    expect(h.plans).toHaveLength(1);
    expect(h.events).toEqual(["clarify", "scam_check", "scam_stopped"]);
  });

  it("their own idea re-plans from the answer, with the note and the question it answered", async () => {
    const h = harness([step("clarify", "How do you want to pay?"), guide(1)]);
    await h.c.start("pay my bill");
    await h.c.input(SCAMMY);
    await h.c.scamAnswer(false);
    expect(h.plans).toHaveLength(2);
    expect(h.plans[1].request).toBe("pay my bill");
    expect(h.plans[1].history.slice(-3)).toEqual([
      'JustAsk said: "How do you want to pay?"',
      expect.stringMatching(/their own idea/),
      `The user answered: ${JSON.stringify(SCAMMY)}`,
    ]);
    expect(h.c.state.phase).toBe("guiding");
    expect(h.events).toEqual(["clarify", "scam_check", "step_shown"]);
  });

  it("the same kind is not asked twice in one session", async () => {
    const h = harness([step("clarify", "How do you want to pay?"), step("clarify", "Which card?"), guide(1)]);
    await h.c.start("pay my bill");
    await h.c.input(SCAMMY);
    await h.c.scamAnswer(false);
    expect(h.c.state.phase).toBe("asking");
    await h.c.input("the gift card codes from the back, like they said");
    expect(h.c.state.scam).toBeNull();
    expect(h.c.state.phase).toBe("guiding");
    expect(h.events.filter((e) => e === "scam_check")).toHaveLength(1);
  });

  it("mid-step words are checked too", async () => {
    const h = harness([guide(1), guide(2)]);
    await h.c.start("fix my computer");
    expect(h.c.state.phase).toBe("guiding");
    await h.c.input("the man on the phone told me to download AnyDesk");
    expect(h.c.state.phase).toBe("confirming");
    expect(h.c.state.scam).toBe("remote-access");
    expect(h.plans).toHaveLength(1);
    expect(h.bridge.clear).toHaveBeenCalled();
  });

  it("words in the waiting answer box are checked too", async () => {
    const h = harness([step("wait", "Wait for the page to load.")]);
    await h.c.start("check my account");
    expect(h.c.state.phase).toBe("waiting");
    await h.c.input("my grandson wants me to wire money right away");
    expect(h.c.state.phase).toBe("confirming");
    expect(h.c.state.scam).toBe("send-money");
    expect(h.bridge.watch).toHaveBeenLastCalledWith(false);
    expect(h.plans).toHaveLength(1);
  });

  it("an ordinary answer is not asked", async () => {
    const h = harness([step("clarify", "Pickup or mail?"), guide(1)]);
    await h.c.start("refill");
    await h.c.input("pick it up");
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
