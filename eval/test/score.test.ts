import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PageSnapshot, StepResponse } from "../../packages/shared/src/index";
import { scoreStep, type EvalCase } from "../lib/score";

const EVAL = fileURLToPath(new URL("..", import.meta.url));
const load = (id: string) => ({
  c: JSON.parse(readFileSync(`${EVAL}cases/${id}.case.json`, "utf8")) as EvalCase,
  snapshot: JSON.parse(readFileSync(`${EVAL}snapshots/${id}.json`, "utf8")) as PageSnapshot,
});
const step = (kind: StepResponse["kind"], say: string, target: number | null = null): StepResponse => ({ kind, say, target, expect: target === null ? null : "click", option: null, text: null, risk: "none" });

describe("outside-knowledge cases (#12)", () => {
  const ids = readdirSync(`${EVAL}cases`).filter((f) => f.startsWith("knowledge-")).map((f) => f.replace(".case.json", ""));

  it("has at least 4, each a clarify that names the on-screen choices, with a committed snapshot", () => {
    expect(ids.length).toBeGreaterThanOrEqual(4);
    for (const id of ids) {
      const { c } = load(id);
      expect(c.expected.kind).toBe("clarify");
      expect(c.expected.allowKinds ?? ["clarify"]).toEqual(["clarify"]);
      expect(c.expected.sayIncludes?.length).toBeGreaterThanOrEqual(2);
      expect(existsSync(`${EVAL}snapshots/${id}.json`)).toBe(true);
    }
  });

  it("a guess from medical knowledge fails; asking by the names on screen passes", () => {
    const { c, snapshot } = load("knowledge-medicine");
    const lisinopril = snapshot.elements.find((e) => /lisinopril/i.test(`${e.text} ${e.nearby ?? ""}`))!.n;
    expect(scoreStep(c, step("guide", "Click Refill next to Lisinopril, your blood pressure medicine.", lisinopril), snapshot).pass).toBe(false);
    expect(scoreStep(c, step("clarify", "Which is for blood pressure? I can't tell."), snapshot).pass).toBe(false);
    const ok = scoreStep(c, step("clarify", "The page doesn't say. Is it Lisinopril or Metformin?"), snapshot);
    expect(ok).toMatchObject({ kindOk: true, sayOk: true, pass: true });
  });

  it("sayIncludes is case-insensitive and optional", () => {
    const { c, snapshot } = load("knowledge-account");
    expect(scoreStep(c, step("clarify", "is it everyday 1234 or rainy day 5678?"), snapshot).sayOk).toBe(true);
    const plain = { ...c, expected: { kind: "clarify" as const } };
    expect(scoreStep(plain, step("clarify", "Which one?"), snapshot).sayOk).toBe(true);
  });
});
