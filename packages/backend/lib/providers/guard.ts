import type { PageSnapshot, StepResponse } from "@justask/shared";

// Deterministic "no outside knowledge" gate for the DeepSeek path (issue #18). DeepSeek tended to match the
// user's description ("the blood pressure one", "my savings") to a page item using its own knowledge. A guide
// line that states one of these claims when the page doesn't is re-planned once, then blocked.
// Generic vocabulary only, no site names. Not in `checkStep`: `packages/shared` changes go through the integrator.

/** Claims about what something is for, what kind of account it is, or who someone is. Lowercase, whole words. */
export const CLAIM_PHRASES = [
  // health: what a medicine is for
  "blood pressure", "diabetes", "blood sugar", "sugar", "cholesterol", "thyroid", "pain", "allergy", "allergies",
  "asthma", "depression", "anxiety", "sleep", "infection", "antibiotic", "water pill", "blood thinner", "stomach", "acid reflux",
  // money: what an account or plan is
  "savings", "checking", "retirement", "cheaper", "cheapest", "less expensive", "lower cost", "best value",
  // people: who someone is
  "son", "daughter", "wife", "husband", "grandson", "granddaughter", "brother", "sister", "mother", "father",
];

/** Lowercase words joined by single spaces, padded, so `includes` matches whole words only. */
const plain = (s: string) => ` ${s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(" ")} `;

function pageSource(snapshot: PageSnapshot): string {
  const els = snapshot.elements.flatMap((e) => [e.text, e.label ?? "", e.nearby ?? "", ...(e.field?.options ?? [])]);
  return plain([snapshot.title, snapshot.heading, snapshot.pageText, ...els].join("\n"));
}

export type GuardCheck = { ok: true } | { ok: false; reason: string; code: "outside_knowledge" };

/**
 * A guide `say` may not state a claim the page doesn't make: that is how a description gets matched to the wrong
 * item. Steps with no target (clarify, done) may repeat the user's words ("When your daughter sends the code…",
 * "Which one is your blood pressure medicine?"), so only guide and act are checked.
 */
export function checkOutsideKnowledge(step: StepResponse, snapshot: PageSnapshot): GuardCheck {
  if (step.kind !== "guide" && step.kind !== "act") return { ok: true };
  const say = plain(step.say);
  const page = pageSource(snapshot);
  for (const phrase of CLAIM_PHRASES) {
    const p = plain(phrase);
    if (say.includes(p) && !page.includes(p)) {
      return {
        ok: false,
        code: "outside_knowledge",
        reason: `the page never says "${phrase}", so don't match it to an item. Reply "clarify" and ask the user to pick by the names on the screen`,
      };
    }
  }
  return { ok: true };
}
