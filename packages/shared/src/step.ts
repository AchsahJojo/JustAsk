import { z } from "zod";
import type { PageSnapshot } from "./snapshot";

/**
 * `act`: JustAsk performs the step itself (drive mode, docs/ARCHITECTURE.md §11).
 * `guide`: the user performs it (sensitive fields, failed actions, "Show me instead").
 */
export const StepKind = z.enum(["act", "guide", "clarify", "wait", "done", "blocked"]);
/** `scroll` brings the target into view; `submit` presses Enter in (or submits the form of) the target field. */
export const Expect = z.enum(["click", "type", "choose", "hover", "file", "scroll", "submit"]);
export const Risk = z.enum(["none", "money", "personal_info", "account_change", "suspicious"]);

/**
 * The single source for the planStep contract. Every field is required in the JSON Schema sent to
 * Claude; nullable fields become `anyOf: [..., {type: "null"}]`. `choices` is optional in TypeScript
 * only, so steps built in code (lines, tests, the mock planner) can leave it out.
 */
export const StepResponse = z
  .object({
    kind: StepKind,
    say: z.string(),
    target: z.number().int().nullable(),
    expect: Expect.nullable(),
    option: z.string().nullable(),
    /** What JustAsk types for an `act` + `type` step. Built from the user's words; null otherwise. */
    text: z.string().nullable(),
    risk: Risk,
    /**
     * `clarify` only: up to 4 short answers the user can tap ("Pick up in store"). Each must be on the
     * page or in the user's words (`checkStep`), so Claude can't invent options. Null otherwise.
     */
    choices: z.array(z.string()).nullable().optional(),
  })
  .strict();
export type StepResponse = z.infer<typeof StepResponse>;
export type Expect = z.infer<typeof Expect>;
export type Risk = z.infer<typeof Risk>;

/** JSON Schema for `output_config.format`. Derived from the Zod schema, then trimmed to what structured output accepts. */
export function stepJsonSchema(): Record<string, unknown> {
  const raw = z.toJSONSchema(StepResponse, { target: "draft-2020-12" }) as Record<string, unknown>;
  delete raw.$schema;
  // Claude always sends every field, `choices` included (null when there are none).
  raw.required = Object.keys(raw.properties as Record<string, unknown>);
  return stripUnsupported(raw) as Record<string, unknown>;
}

const UNSUPPORTED = new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "minItems", "maxItems"]);
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
/** `fixStep` trims a `say` up to this long. Longer lines are re-planned. */
export const MAX_TRIM_WORDS = 28;
/** A clarify offers at most this many tap-able choices, each this many words or fewer. */
export const MAX_CHOICES = 4;
export const MAX_CHOICE_WORDS = 5;

/** Why a step failed `checkStep`, as a fixed code: safe to log (no page data). */
export type CheckCode =
  | "say_empty"
  | "say_long"
  | "no_target"
  | "no_expect"
  | "no_text"
  | "act_cant"
  | "unknown_target"
  | "sensitive"
  | "no_select"
  | "no_option"
  | "bad_option"
  | "extra_target"
  | "extra_choices"
  | "bad_choice";

export type StepCheck = { ok: true } | { ok: false; reason: string; code: CheckCode };

const fail = (code: CheckCode, reason: string): StepCheck => ({ ok: false, reason, code });

export const sayWords = (say: string) => say.trim().split(/\s+/).filter(Boolean).length;

/** Lowercase words joined by single spaces, padded, so `includes` matches whole words only. */
const plain = (s: string) => ` ${s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(" ")} `;

/** Everything a choice may be copied from: what's on the page, plus the user's own words. */
function choiceSource(snapshot: PageSnapshot, said: string): string {
  const els = snapshot.elements.flatMap((e) => [e.text, e.label ?? "", e.nearby ?? "", ...(e.field?.options ?? [])]);
  return plain([snapshot.title, snapshot.heading, snapshot.pageText, ...els, said].join("\n"));
}

/**
 * Rules the JSON Schema cannot express (plan §4.1). A failed check gets one re-plan, then `blocked`.
 * `said` is the user's own words (request, answers, recipe): a clarify choice may come from there too.
 */
export function checkStep(step: StepResponse, snapshot: PageSnapshot, said = ""): StepCheck {
  const words = sayWords(step.say);
  if (words === 0) return fail("say_empty", "say is empty");
  if (words > MAX_SAY_WORDS) return fail("say_long", `say has ${words} words; the limit is ${MAX_SAY_WORDS}`);

  if (step.kind === "guide" || step.kind === "act") {
    if (step.target === null) return fail("no_target", `${step.kind} needs a target`);
    if (step.expect === null) return fail("no_expect", `${step.kind} needs expect`);
  }
  if (step.kind === "act") {
    if (step.expect === "type" && !step.text?.trim()) return fail("no_text", "act with type needs text");
    if (step.expect === "hover" || step.expect === "file") return fail("act_cant", `act can't ${step.expect}; use guide`);
  }
  if (step.target !== null) {
    const el = snapshot.elements.find((e) => e.n === step.target);
    if (!el) return fail("unknown_target", `target ${step.target} is not in the current list`);
    // Sensitive fields (passwords, codes, card numbers) are never filled by JustAsk: the user types them.
    if (step.kind === "act" && el.field?.sensitive && (step.expect === "type" || step.expect === "choose" || step.expect === "submit")) {
      return fail("sensitive", "that field is sensitive; use guide so the user types it themselves");
    }
    if (step.expect === "choose") {
      const options = el.field?.options;
      if (!options || options.length === 0) return fail("no_select", "choose needs a select target");
      if (step.option === null) return fail("no_option", "choose needs an option");
      // The snapshot may include only the first part of a long list. We only let the
      // planner choose an option it actually saw; otherwise it could invent a label.
      if (!options.includes(step.option)) {
        return fail("bad_option", `option "${step.option}" is not one of the target's options`);
      }
    }
  }
  if (step.kind !== "guide" && step.kind !== "act" && step.target !== null && step.kind !== "clarify") {
    return fail("extra_target", `${step.kind} must not have a target`);
  }
  if (step.choices?.length) {
    if (step.kind !== "clarify") return fail("extra_choices", `${step.kind} must not have choices`);
    if (step.choices.length > MAX_CHOICES) return fail("extra_choices", `${step.choices.length} choices; the limit is ${MAX_CHOICES}`);
    const source = choiceSource(snapshot, said);
    for (const c of step.choices) {
      const n = sayWords(c);
      if (n === 0 || n > MAX_CHOICE_WORDS) return fail("bad_choice", `choice "${c}" must be 1 to ${MAX_CHOICE_WORDS} words`);
      // Deterministic: the choice must already be on the page or in the user's words, so Claude can't invent one.
      if (!source.includes(plain(c))) return fail("bad_choice", `choice "${c}" is not on the page or in the user's words`);
    }
  }
  return { ok: true };
}

/** Words that carry the instruction in a guide or act line ("Click", "Type", "Pick"…). */
const ACTION_VERB = /\b(click|press|tap|type|enter|pick|choose|select|point|move|hover|scroll|open|put|use|find|look|upload|attach)\b/i;

/** A case-insensitive whole-word match for a name ("Go" matches "the Go button", not "going"). */
const wordsRe = (name: string) => new RegExp(`(^|\\W)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\W|$)`, "i");

/**
 * A `say` a little over the limit (21–28 words) is cut at the last sentence end that fits, instead of
 * costing a second Claude call. The cut must keep what the user needs: the action verb and the target's
 * name for guide and act steps, the question for a clarify. Otherwise the step comes back unchanged and
 * `checkStep` sends it for a re-plan. Deterministic: no Claude.
 */
export function fixStep(step: StepResponse, snapshot: PageSnapshot): StepResponse {
  const words = sayWords(step.say);
  if (words <= MAX_SAY_WORDS || words > MAX_TRIM_WORDS) return step;
  const sentences = step.say.trim().match(/[^.?!]+[.?!]+["'”’)\]]*\s*|[^.?!]+$/g) ?? [];
  let cut = "";
  for (const s of sentences) {
    if (sayWords(cut + s) > MAX_SAY_WORDS) break;
    cut += s;
  }
  cut = cut.trim();
  // Only whole sentences: the last one kept must end in . ? or !
  if (!cut || !/[.?!]["'”’)\]]*$/.test(cut)) return step;
  const keeps = (re: RegExp) => !re.test(step.say) || re.test(cut);
  if (step.kind === "guide" || step.kind === "act") {
    if (!keeps(ACTION_VERB)) return step;
    const el = step.target === null ? undefined : snapshot.elements.find((e) => e.n === step.target);
    const names = [el?.text, el?.label].map((x) => x?.trim()).filter((x): x is string => !!x).map(wordsRe);
    if (!names.every(keeps)) return step;
  }
  if (step.kind === "clarify" && !keeps(/\?/)) return step;
  return { ...step, say: cut };
}
