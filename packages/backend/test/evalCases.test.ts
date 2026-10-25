import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PageSnapshot, StepResponse } from "@justask/shared";
import { scoreStep, type EvalCase } from "../../../eval/lib/score";

// The prompt eval (eval/) lives outside the Vitest include list; these checks keep its cases guide-only.
const CASES = fileURLToPath(new URL("../../../eval/cases/", import.meta.url));
const cases: EvalCase[] = readdirSync(CASES)
  .filter((f) => f.endsWith(".case.json"))
  .map((f) => JSON.parse(readFileSync(CASES + f, "utf8")));

describe("eval cases are guide-only", () => {
  it("no case expects or allows the old act kind, or a text field", () => {
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      expect(c.expected.kind, c.id).not.toBe("act");
      expect(c.expected.allowKinds ?? [], c.id).not.toContain("act");
      expect(c.expected, c.id).not.toHaveProperty("text");
    }
  });

  it("scoreStep checks the target of a guide step", () => {
    const snapshot: PageSnapshot = {
      snapshotId: "s", url: "http://x/", title: "t", heading: "", pageText: "", omitted: { count: 0, regions: [] },
      elements: [1, 2].map((n) => ({ n, role: "button", text: n === 1 ? "Refill" : "Cancel", label: null, nearby: null, color: null, big: false, disabled: false, inModal: false, inViewport: true, region: "main" })),
    };
    const c: EvalCase = { id: "x", url: "", request: "refill", expected: { kind: "guide", targetText: "Refill" } };
    const step = (target: number): StepResponse => ({ kind: "guide", say: "Click it.", target, expect: "click", option: null, risk: "none" });
    expect(scoreStep(c, step(1), snapshot).pass).toBe(true);
    expect(scoreStep(c, step(2), snapshot)).toMatchObject({ targetOk: false, pass: false });
  });
});
