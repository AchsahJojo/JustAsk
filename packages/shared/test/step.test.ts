import { describe, expect, it } from "vitest";
import { checkStep, fixStep, sayWords, stepJsonSchema, StepResponse, type PageSnapshot } from "../src";

const snap: PageSnapshot = {
  snapshotId: "s1",
  url: "https://x.test/",
  title: "T",
  heading: "H",
  pageText: "",
  omitted: { count: 0, regions: [] },
  surface: "web",
  elements: [
    { n: 1, role: "button", text: "Go", label: null, nearby: null, color: "blue", big: true, disabled: false, inModal: false, inViewport: true, region: "main" },
    {
      n: 2,
      role: "dropdown",
      text: "",
      label: "State",
      nearby: null,
      color: null,
      big: false,
      disabled: false,
      inModal: false,
      inViewport: true,
      region: "main",
      field: { kind: "select", hasValue: false, valid: true, options: ["Choose…", "Arizona", "Texas"], optionCount: 3 },
    },
  ],
};

const base = { kind: "guide", say: "Click Go.", target: 1, expect: "click", option: null, text: null, risk: "none" } as const;

describe("StepResponse JSON Schema", () => {
  it("has every field required, nullable via anyOf, additionalProperties false", () => {
    const s = stepJsonSchema() as any;
    expect(s.type).toBe("object");
    expect(s.additionalProperties).toBe(false);
    expect([...s.required].sort()).toEqual(["expect", "kind", "option", "risk", "say", "target", "text"]);
    expect(JSON.stringify(s.properties.target)).toContain('"null"');
    expect(JSON.stringify(s)).not.toMatch(/minimum|maximum|minLength|maxLength/);
  });
  it("parses a valid response and rejects extra keys", () => {
    expect(StepResponse.parse(base)).toEqual(base);
    expect(() => StepResponse.parse({ ...base, extra: 1 })).toThrow();
  });
});

describe("checkStep", () => {
  it("accepts a good guide step", () => expect(checkStep(base, snap)).toEqual({ ok: true }));
  it("guide needs target and expect", () => {
    expect(checkStep({ ...base, target: null }, snap).ok).toBe(false);
    expect(checkStep({ ...base, expect: null }, snap).ok).toBe(false);
  });
  it("target must exist in snapshot", () => expect(checkStep({ ...base, target: 9 }, snap).ok).toBe(false));
  it("choose needs an exact option", () => {
    expect(checkStep({ ...base, target: 2, expect: "choose", option: "Arizona" }, snap).ok).toBe(true);
    expect(checkStep({ ...base, target: 2, expect: "choose", option: "arizona" }, snap).ok).toBe(false);
    expect(checkStep({ ...base, target: 2, expect: "choose", option: null }, snap).ok).toBe(false);
    expect(checkStep({ ...base, target: 1, expect: "choose", option: "Go" }, snap).ok).toBe(false);
  });
  it("does not accept a made-up option when a long list was truncated", () => {
    const truncated: PageSnapshot = {
      ...snap,
      elements: snap.elements.map((el) => el.n !== 2 ? el : {
        ...el,
        field: { ...el.field!, options: ["Choose…", "Arizona", "Texas"], optionCount: 55 },
      }),
    };
    expect(checkStep({ ...base, target: 2, expect: "choose", option: "Arizona" }, truncated).ok).toBe(true);
    expect(checkStep({ ...base, target: 2, expect: "choose", option: "Nevada" }, truncated)).toMatchObject({ ok: false, reason: expect.stringContaining("not one of") });
  });
  it("say is 20 words or fewer", () => {
    expect(checkStep({ ...base, say: Array(21).fill("word").join(" ") }, snap).ok).toBe(false);
    expect(checkStep({ ...base, say: Array(20).fill("word").join(" ") }, snap).ok).toBe(true);
  });
  it("done must not have a target", () => {
    expect(checkStep({ ...base, kind: "done", target: 1, expect: null }, snap).ok).toBe(false);
    expect(checkStep({ ...base, kind: "done", target: null, expect: null }, snap).ok).toBe(true);
  });
});

describe("checkStep: act (drive mode)", () => {
  const box = { n: 3, role: "text box", text: "Search", label: null, nearby: null, color: null, big: false, disabled: false, inModal: false, inViewport: true, region: "header" as const, field: { kind: "search" as const, hasValue: false, valid: true } };
  const pw = { ...box, n: 4, text: "", label: "Password", field: { kind: "password" as const, hasValue: false, valid: true, sensitive: true } };
  const s2: PageSnapshot = { ...snap, elements: [...snap.elements, box, pw] };
  const act = { ...base, kind: "act" } as const;

  it("accepts a click and a typed search", () => {
    expect(checkStep(act, s2).ok).toBe(true);
    expect(checkStep({ ...act, target: 3, expect: "type", text: "water bottle" }, s2).ok).toBe(true);
  });
  it("type needs text", () => expect(checkStep({ ...act, target: 3, expect: "type", text: null }, s2).ok).toBe(false));
  it("never types into a sensitive field", () => {
    expect(checkStep({ ...act, target: 4, expect: "type", text: "hunter2" }, s2).ok).toBe(false);
    expect(checkStep({ ...base, target: 4, expect: "type" }, s2).ok).toBe(true); // guiding the user is fine
  });
  it("can't hover or pick files", () => expect(checkStep({ ...act, expect: "file" }, s2).ok).toBe(false));
});

describe("fixStep: a say a little over the limit", () => {
  const words = (n: number, w = "word") => Array(n).fill(w).join(" ");

  it("trims a 22-word reply with a sentence break at 15 words, so it isn't re-planned", () => {
    const say = `Click the blue Go button ${words(10)}. ${words(6)} after.`;
    expect(sayWords(say)).toBe(22);
    expect(checkStep({ ...base, say }, snap)).toMatchObject({ ok: false, code: "say_long" });
    const fixed = fixStep({ ...base, say }, snap);
    expect(fixed.say).toBe(`Click the blue Go button ${words(10)}.`);
    expect(sayWords(fixed.say)).toBe(15);
    expect(checkStep(fixed, snap)).toEqual({ ok: true });
  });
  it("keeps the question of a clarify", () => {
    const say = "Do you want to start your own new call, or join someone else's? If joining, ask them to send you the link.";
    expect(sayWords(say)).toBeGreaterThan(20);
    const fixed = fixStep({ ...base, kind: "clarify", target: null, expect: null, say }, snap);
    expect(fixed.say).toBe("Do you want to start your own new call, or join someone else's?");
  });
  it("doesn't cut a clarify's question off", () => {
    const say = `Okay, ${words(12)} for you. Do you want to start a new call, or join one?`;
    const step = { ...base, kind: "clarify" as const, target: null, expect: null, say };
    expect(fixStep(step, snap)).toBe(step);
  });
  it("doesn't drop the target's name or the action verb", () => {
    const lostName = { ...base, say: `Click the button ${words(12)} below. It is the big blue Go one at the top.` };
    expect(sayWords(lostName.say)).toBeLessThanOrEqual(28);
    expect(fixStep(lostName, snap)).toBe(lostName);
    const lostVerb = { ...base, say: `This is the page ${words(12)} you want. Press Go to carry on with your refill.` };
    expect(fixStep(lostVerb, snap)).toBe(lostVerb);
  });
  it("leaves lines with no sentence break, and lines far over the limit, for a re-plan", () => {
    const flat = { ...base, say: `Click Go ${words(20)}` };
    expect(fixStep(flat, snap)).toBe(flat);
    const long = { ...base, say: `Click Go ${words(10)}. ${words(20)}.` };
    expect(sayWords(long.say)).toBeGreaterThan(28);
    expect(fixStep(long, snap)).toBe(long);
  });
  it("leaves lines within the limit alone", () => expect(fixStep(base, snap)).toBe(base));
});
