// Deterministic drive-mode gates (docs/ARCHITECTURE.md §11). Pure functions, never left to Claude.
import type { Recipe, SnapshotElement, StepResponse } from "@justask/shared";

/** Lowercased words longer than 2 characters. */
export function words(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2);
}

/** Simple stems: the same word, a plural "s", or a shared prefix of 4+ characters. */
export function sameStem(a: string, b: string): boolean {
  if (a === b || a + "s" === b || b + "s" === a) return true;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i >= 4;
}

/** Her own words: the request, her "She answered" history entries, and the caregiver recipe steps. */
export function herWords(request: string, history: string[], recipe: Recipe | null): string[] {
  const parts = [request, ...(recipe?.steps ?? [])];
  for (const h of history) {
    const m = /^She answered: (.*)$/.exec(h);
    if (!m) continue;
    try {
      parts.push(String(JSON.parse(m[1])));
    } catch {
      parts.push(m[1]);
    }
  }
  return [...new Set(parts.flatMap(words))];
}

/** Words of `text` that she never said (allowing simple stems). Empty means the text is built from her words. */
export function extraWords(text: string, her: string[]): string[] {
  return [...new Set(words(text))].filter((w) => !her.some((h) => sameStem(w, h)));
}

/** Luhn checksum over a string of digits. */
export function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/**
 * Personal-data guard: true when `text` looks like an SSN, a card number (Luhn-valid 13–19 digits),
 * a phone number (10+ digits), an email, or mentions a password. JustAsk never types these.
 */
export function looksPersonal(text: string): boolean {
  if (/\b\d{3}-?\d{2}-?\d{4}\b/.test(text)) return true;
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(text)) return true;
  if (/\bpasswords?\b/i.test(text)) return true;
  for (const m of text.match(/\d(?:[ -]?\d){12,18}/g) ?? []) {
    const d = m.replace(/\D/g, "");
    if (d.length >= 13 && d.length <= 19 && luhn(d)) return true;
  }
  for (const m of text.match(/\+?\(?\d[\d\s().-]*\d/g) ?? []) {
    if (m.replace(/\D/g, "").length >= 10) return true;
  }
  return false;
}

export type GuideReason = "show-me" | "guide-mode" | "not-actable" | "sensitive" | "personal-data";
export type ActGate = { mode: "act" } | { mode: "confirm-text"; extra: string[] } | { mode: "guide"; reason: GuideReason };

export interface GateContext {
  /** The "Show me instead" preference. */
  showMeInstead: boolean;
  /** The session switched to guide mode (3 actions in a row that changed nothing). */
  guideMode: boolean;
  /** From `herWords`. */
  her: string[];
}

/** Decide how an `act` step runs: act now, confirm the typed text first, or guide her instead. */
export function gateAct(step: StepResponse, el: SnapshotElement | undefined, ctx: GateContext): ActGate {
  if (ctx.showMeInstead) return { mode: "guide", reason: "show-me" };
  if (ctx.guideMode) return { mode: "guide", reason: "guide-mode" };
  const e = step.expect;
  if (e === null || e === "hover" || e === "file") return { mode: "guide", reason: "not-actable" };
  if (el?.field?.sensitive && (e === "type" || e === "choose" || e === "submit")) return { mode: "guide", reason: "sensitive" };
  if (step.text && looksPersonal(step.text)) return { mode: "guide", reason: "personal-data" };
  if (e === "type") {
    if (!step.text?.trim()) return { mode: "guide", reason: "not-actable" };
    const extra = extraWords(step.text, ctx.her);
    if (extra.length) return { mode: "confirm-text", extra };
  }
  return { mode: "act" };
}
