import { describe, expect, it } from "vitest";
import { extraWords, gateAct, herWords, looksPersonal, luhn, sameStem, words } from "../src/drive";
import { snapshotSignature } from "../src/signature";
import type { PageSnapshot, SnapshotElement, StepResponse } from "@justask/shared";

const act = (extra: Partial<StepResponse> = {}): StepResponse => ({ kind: "act", say: "I'm typing it.", target: 1, expect: "type", option: null, text: "water bottle", risk: "none", ...extra });
const box = (field: SnapshotElement["field"] = { kind: "search", hasValue: false, valid: true }): SnapshotElement => ({
  n: 1, role: "search box", text: "", label: "Search", nearby: null, color: null, big: false, disabled: false, inModal: false, inViewport: true, region: "main", field,
});
const ctx = (her: string[] = ["water", "bottle"], extra = {}) => ({ showMeInstead: false, guideMode: false, her, ...extra });

describe("words and stems", () => {
  it("keeps lowercased words longer than 2 characters", () => {
    expect(words("Find me a Water-Bottle, 2 of them")).toEqual(["find", "water", "bottle", "them"]);
  });
  it("matches plurals and shared 4+ prefixes, not short ones", () => {
    expect(sameStem("bottles", "bottle")).toBe(true);
    expect(sameStem("printer", "print")).toBe(true);
    expect(sameStem("water", "watch")).toBe(false);
    expect(sameStem("cat", "cats")).toBe(true);
  });
});

describe("herWords / extraWords", () => {
  it("collects the request, her answers and the recipe", () => {
    const her = herWords("buy a water bottle", ['She answered: "the blue one"', 'On "Store": She did: "Click it." (click)'], { steps: ["Use Amazon"] });
    expect(her).toEqual(expect.arrayContaining(["buy", "water", "bottle", "the", "blue", "one", "use", "amazon"]));
    expect(her).not.toContain("click");
  });
  it("finds words she never said", () => {
    expect(extraWords("water bottles", ["water", "bottle"])).toEqual([]);
    expect(extraWords("Happy birthday, Sam!", ["sam"])).toEqual(["happy", "birthday"]);
  });
});

describe("looksPersonal", () => {
  it("luhn", () => {
    expect(luhn("4111111111111111")).toBe(true);
    expect(luhn("4111111111111112")).toBe(false);
  });
  it.each([
    ["123-45-6789", true],
    ["4111 1111 1111 1111", true],
    ["(602) 555-0142", true],
    ["margaret@example.com", true],
    ["my Password is hunter2", true],
    ["water bottle", false],
    ["size 12 pack of 24", false],
    ["order 12345", false],
  ])("%s -> %s", (s, want) => expect(looksPersonal(s)).toBe(want));
});

describe("gateAct", () => {
  it("acts when the text is her words", () => {
    expect(gateAct(act(), box(), ctx())).toEqual({ mode: "act" });
  });
  it("Show me instead and guide mode turn acts into guides", () => {
    expect(gateAct(act(), box(), ctx(undefined, { showMeInstead: true }))).toEqual({ mode: "guide", reason: "show-me" });
    expect(gateAct(act(), box(), ctx(undefined, { guideMode: true }))).toEqual({ mode: "guide", reason: "guide-mode" });
  });
  it("never types, chooses or submits on a sensitive field; clicking is fine", () => {
    const pw = box({ kind: "password", hasValue: false, valid: true, sensitive: true });
    expect(gateAct(act(), pw, ctx())).toEqual({ mode: "guide", reason: "sensitive" });
    expect(gateAct(act({ expect: "submit", text: null }), pw, ctx())).toEqual({ mode: "guide", reason: "sensitive" });
    expect(gateAct(act({ expect: "click", text: null }), pw, ctx())).toEqual({ mode: "act" });
  });
  it("guards personal data even when she said it", () => {
    expect(gateAct(act({ text: "602 555 0142" }), box(), ctx(["602", "555", "0142"]))).toEqual({ mode: "guide", reason: "personal-data" });
  });
  it("asks before typing extra words", () => {
    expect(gateAct(act({ text: "Happy birthday Sam" }), box(), ctx(["sam"]))).toEqual({ mode: "confirm-text", extra: ["happy", "birthday"] });
  });
});

describe("snapshotSignature", () => {
  const snap = (els: SnapshotElement[]): PageSnapshot => ({ snapshotId: "x", url: "", title: "", heading: "", pageText: "", elements: els, omitted: { count: 0, regions: [] }, surface: "web" });
  it("changes with the elements, not the snapshot id", () => {
    const a = snapshotSignature(snap([box()]));
    expect(snapshotSignature({ ...snap([box()]), snapshotId: "y", pageText: "other" })).toBe(a);
    expect(snapshotSignature(snap([box({ kind: "search", hasValue: true, valid: true })]))).not.toBe(a);
    expect(snapshotSignature(snap([box(), { ...box(), n: 2, text: "Go" }]))).not.toBe(a);
  });
});
