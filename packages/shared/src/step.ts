import { z } from "zod";
import type { PageSnapshot } from "./snapshot";

/**
 * JustAsk never acts for her: she does every step herself.
 * `guide`: JustAsk highlights one thing on the screen and says what to do; she does it.
 */
export const StepKind = z.enum(["guide", "clarify", "wait", "done", "blocked"]);
/** What she does to the target. `scroll`: she brings it into view; `submit`: she presses Enter in the target field. */
export const Expect = z.enum(["click", "type", "choose", "hover", "file", "scroll", "submit"]);
export const Risk = z.enum(["none", "money", "personal_info", "account_change", "suspicious"]);

/**
 * The single source for the planStep contract. Every field is required; nullable fields
 * become `anyOf: [..., {type: "null"}]` in the JSON Schema sent to Claude.
 */
export const StepResponse = z
  .object({
    kind: StepKind,
    say: z.string(),
    target: z.number().int().nullable(),
    expect: Expect.nullable(),
    option: z.string().nullable(),
    risk: Risk,
  })
  .strict();
export type StepResponse = z.infer<typeof StepResponse>;
export type Expect = z.infer<typeof Expect>;
export type Risk = z.infer<typeof Risk>;

/** JSON Schema for `output_config.format`. Derived from the Zod schema, then trimmed to what structured output accepts. */
export function stepJsonSchema(): Record<string, unknown> {
  const raw = z.toJSONSchema(StepResponse, { target: "draft-2020-12" }) as Record<string, unknown>;
  delete raw.$schema;
  return stripUnsupported(raw) as Record<string, unknown>;
}

const UNSUPPORTED = new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength"]);
function stripUnsupported(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripUnsupported);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (UNSUPPORTED.has(k)) continue;
      out[k] = stripUnsupported(v);
    }
    return out;
  }
  return node;
}

export const MAX_SAY_WORDS = 20;

export type StepCheck = { ok: true } | { ok: false; reason: string };

/** Rules the JSON Schema cannot express (plan §4.1). A failed check gets one re-plan, then `blocked`. */
export function checkStep(step: StepResponse, snapshot: PageSnapshot): StepCheck {
  const words = step.say.trim().split(/\s+/).filter(Boolean).length;
  if (words === 0) return { ok: false, reason: "say is empty" };
  if (words > MAX_SAY_WORDS) return { ok: false, reason: `say has ${words} words; the limit is ${MAX_SAY_WORDS}` };

  if (step.kind === "guide") {
    if (step.target === null) return { ok: false, reason: "guide needs a target" };
    if (step.expect === null) return { ok: false, reason: "guide needs expect" };
  }
  if (step.target !== null) {
    const el = snapshot.elements.find((e) => e.n === step.target);
    if (!el) return { ok: false, reason: `target ${step.target} is not in the current list` };
    if (step.expect === "choose") {
      const options = el.field?.options;
      if (!options || options.length === 0) return { ok: false, reason: "choose needs a select target" };
      if (step.option === null) return { ok: false, reason: "choose needs an option" };
      // The snapshot may include only the first part of a long list. We only let the
      // planner choose an option it actually saw; otherwise it could invent a label.
      if (!options.includes(step.option)) {
        return { ok: false, reason: `option "${step.option}" is not one of the target's options` };
      }
    }
  }
  // Only guide points at a target (clarify may mention one).
  if (step.kind !== "guide" && step.kind !== "clarify" && step.target !== null) {
    return { ok: false, reason: `${step.kind} must not have a target` };
  }
  return { ok: true };
}
