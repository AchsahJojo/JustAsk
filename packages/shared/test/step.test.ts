import { describe, expect, it } from "vitest";
import { checkStep, stepJsonSchema, StepResponse, type PageSnapshot } from "../src";

const snap: PageSnapshot = {
  snapshotId: "s1",
  url: "https://x.test/",
  title: "T",
  heading: "H",
  pageText: "",
  omitted: { count: 0, regions: [] },
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

const base = { kind: "guide", say: "Click Go.", target: 1, expect: "click", option: null, risk: "none" } as const;

describe("StepResponse JSON Schema", () => {
  it("has every field required, nullable via anyOf, additionalProperties false", () => {
    const s = stepJsonSchema() as any;
    expect(s.type).toBe("object");
    expect(s.additionalProperties).toBe(false);
    expect([...s.required].sort()).toEqual(["expect", "kind", "option", "risk", "say", "target"]);
    expect(JSON.stringify(s.properties.target)).toContain('"null"');
    expect(JSON.stringify(s)).not.toMatch(/minimum|maximum|minLength|maxLength/);
  });
  it("parses a valid response and rejects extra keys", () => {
    expect(StepResponse.parse(base)).toEqual(base);
    expect(() => StepResponse.parse({ ...base, extra: 1 })).toThrow();
  });
  it("has no text field and rejects one", () => {
    expect((stepJsonSchema() as any).properties.text).toBeUndefined();
    expect(() => StepResponse.parse({ ...base, text: null })).toThrow();
  });
  it("is guide-only: kind act is not in the enum and is rejected", () => {
    expect(JSON.stringify((stepJsonSchema() as any).properties.kind)).not.toContain('"act"');
    expect(() => StepResponse.parse({ ...base, kind: "act" })).toThrow();
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

describe("checkStep: guide on boxes", () => {
  const box = { n: 3, role: "text box", text: "Search", label: null, nearby: null, color: null, big: false, disabled: false, inModal: false, inViewport: true, region: "header" as const, field: { kind: "search" as const, hasValue: false, valid: true } };
  const pw = { ...box, n: 4, text: "", label: "Password", field: { kind: "password" as const, hasValue: false, valid: true, sensitive: true } };
  const s2: PageSnapshot = { ...snap, elements: [...snap.elements, box, pw] };

  it("accepts guiding her to type, submit, hover and pick a file", () => {
    expect(checkStep({ ...base, target: 3, expect: "type", say: "Type water bottle in the search box." }, s2).ok).toBe(true);
    expect(checkStep({ ...base, target: 3, expect: "submit" }, s2).ok).toBe(true);
    expect(checkStep({ ...base, expect: "hover" }, s2).ok).toBe(true);
    expect(checkStep({ ...base, expect: "file" }, s2).ok).toBe(true);
  });
  it("guides her to type into a sensitive field herself", () => {
    expect(checkStep({ ...base, target: 4, expect: "type", say: "Type your password here. I can't see it." }, s2).ok).toBe(true);
  });
  it("only guide and clarify may have a target", () => {
    expect(checkStep({ ...base, kind: "clarify", expect: null }, s2).ok).toBe(true);
    for (const kind of ["wait", "done", "blocked"] as const) expect(checkStep({ ...base, kind, expect: null }, s2).ok).toBe(false);
  });
});
