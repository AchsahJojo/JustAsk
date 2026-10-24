import { describe, expect, it } from "vitest";
import { checkStep, stepJsonSchema, StepResponse, type PageSnapshot } from "../src";

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

const base = { kind: "guide", say: "Click Go.", target: 1, expect: "click", option: null, fill: null, risk: "none" } as const;

describe("StepResponse JSON Schema", () => {
  it("has every field required, nullable via anyOf, additionalProperties false", () => {
    const s = stepJsonSchema() as any;
    expect(s.type).toBe("object");
    expect(s.additionalProperties).toBe(false);
    expect([...s.required].sort()).toEqual(["expect", "fill", "kind", "option", "risk", "say", "target"]);
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
  it("say is 20 words or fewer", () => {
    expect(checkStep({ ...base, say: Array(21).fill("word").join(" ") }, snap).ok).toBe(false);
    expect(checkStep({ ...base, say: Array(20).fill("word").join(" ") }, snap).ok).toBe(true);
  });
  it("done must not have a target", () => {
    expect(checkStep({ ...base, kind: "done", target: 1, expect: null }, snap).ok).toBe(false);
    expect(checkStep({ ...base, kind: "done", target: null, expect: null }, snap).ok).toBe(true);
  });
});

describe("fill (Type it for me)", () => {
  const withSearch: PageSnapshot = {
    ...snap,
    elements: [
      ...snap.elements,
      { n: 3, role: "textbox", text: "", label: "Search", nearby: null, color: null, big: false, disabled: false, inModal: false, inViewport: true, region: "header", field: { kind: "search", hasValue: false, valid: true } },
      { n: 4, role: "textbox", text: "", label: "Email", nearby: null, color: null, big: false, disabled: false, inModal: false, inViewport: true, region: "main", field: { kind: "email", hasValue: false, valid: true } },
    ],
  };
  const typing = { ...base, expect: "type" as const };
  it("is allowed only when typing into a search box", () => {
    expect(checkStep({ ...typing, target: 3, fill: "air fryer" }, withSearch).ok).toBe(true);
    expect(checkStep({ ...typing, target: 4, fill: "me@x.com" }, withSearch).ok).toBe(false);
    expect(checkStep({ ...base, target: 3, fill: "air fryer" }, withSearch).ok).toBe(false); // click, not type
    expect(checkStep({ ...base, kind: "done", target: null, expect: null, fill: "x" }, withSearch).ok).toBe(false);
  });
  it("must be one short line", () => {
    expect(checkStep({ ...typing, target: 3, fill: "  " }, withSearch).ok).toBe(false);
    expect(checkStep({ ...typing, target: 3, fill: "a".repeat(101) }, withSearch).ok).toBe(false);
    expect(checkStep({ ...typing, target: 3, fill: "air\nfryer" }, withSearch).ok).toBe(false);
  });
});
