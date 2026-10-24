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

const guide = (target: number, say = "Click it.", extra: Partial<StepResponse> = {}): StepResponse => ({ kind: "guide", say, target, expect: "click", option: null, fill: null, risk: "none", ...extra });

function harness(steps: StepResponse[], scans: FrameScan[][] = [[frame(0, ["A", "B"])]]) {
  const plans: PlanRequest[] = [];
  let i = 0;
  let s = 0;
  const highlights: unknown[] = [];
  const bridge: PageBridge = {
    scan: vi.fn(async () => scans[Math.min(s++, scans.length - 1)]),
    highlight: vi.fn(async (ref, spec) => (highlights.push({ ref, spec }), true)),
    clear: vi.fn(async () => {}),
    pulse: vi.fn(async () => {}),
    waitForChange: vi.fn(async () => true),
    fill: vi.fn(async () => true),
  };
  const planner: Planner = {
    plan: vi.fn(async (req: PlanRequest) => {
      plans.push(req);
      const step = steps[Math.min(i++, steps.length - 1)];
      return { ok: true as const, snapshotId: req.snapshot.snapshotId, step, latencyMs: 5 };
    }),
  };
  const spoken: string[] = [];
  const speech = { speak: (t: string) => spoken.push(t), stop: () => {} };
  const events: string[] = [];
  const c = new SessionController({ bridge, planner, speech, events: { log: (t) => events.push(t) }, timing: { changeTimeoutMs: 10 } });
  return { c, bridge, planner, plans, spoken, highlights, events };
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
    const h = harness([guide(1, "Click A."), guide(2, "Click B."), { kind: "done", say: "All done, you did it!", target: null, expect: null, option: null, fill: null, risk: "none" }]);
    await h.c.start("help me");
    expect(h.c.state.phase).toBe("guiding");
    expect(h.c.state.line).toBe("Click A.");
    await h.c.onContent({ type: "ja:step-done", how: "click" }, 0);
    expect(h.c.state.line).toBe("Click B.");
    expect(h.plans[1].history[0]).toContain("Click A.");
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
    const h = harness([{ kind: "blocked", say: "This page might be a trick.", target: null, expect: null, option: null, fill: null, risk: "suspicious" }]);
    await h.c.start("x");
    expect(h.c.state.phase).toBe("blocked");
  });

  it("clarify then answer goes into history", async () => {
    const h = harness([{ kind: "clarify", say: "Pickup or mail?", target: null, expect: null, option: null, fill: null, risk: "none" }, guide(2)]);
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
});

describe("parseCommand", () => {
  it.each([
    ["say that again", "repeat"],
    ["stop", "stop"],
    ["I'm stuck", "stuck"],
    ["yes please", "yes"],
    ["help me refill", "text"],
  ])("%s -> %s", (s, k) => expect(parseCommand(s).kind).toBe(k));
});

describe("Type it for me", () => {
  const searchFrame = (): FrameScan => {
    const f = frame(0, ["Go"]);
    f.snapshot.elements.push({ n: 2, role: "textbox", text: "", label: "Search", nearby: null, color: null, big: false, disabled: false, inModal: false, inViewport: true, region: "header", field: { kind: "search", hasValue: false, valid: true } });
    return f;
  };
  it("offers fill only on a search typing step, and fills through the bridge", async () => {
    const h = harness([guide(2, "Type air fryer in the search box.", { expect: "type", fill: "air fryer" })], [[searchFrame()]]);
    await h.c.start("find a cheaper air fryer");
    expect(h.c.state.phase).toBe("guiding");
    expect(h.c.state.fill).toBe("air fryer");
    expect(await h.c.fillForMe()).toBe(true);
    expect(h.bridge.fill).toHaveBeenCalledWith({ frameId: 0, localId: 2 }, "air fryer");
    expect(h.events).toContain("assist_fill");
  });
  it("clears fill when the step is not a search box, and after the session moves on", async () => {
    const h = harness([guide(1, "Click Go.")]);
    await h.c.start("go");
    expect(h.c.state.fill).toBeNull();
    expect(await h.c.fillForMe()).toBe(false);
    expect(h.bridge.fill).not.toHaveBeenCalled();
  });
});
